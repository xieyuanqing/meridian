import { afterEach, describe, expect, it } from "bun:test"
import { fileURLToPath } from "node:url"
import { createAntigravityServer } from "../proxy/backends/antigravity"
import { AntigravityRuntime } from "../proxy/backends/antigravityRuntime"
import { parseAgRequest, type AgRequest, type AgBlock } from "../proxy/backends/antigravityProtocol"
import { DEFAULT_PROXY_CONFIG, type AntigravityOptions } from "../proxy/types"

const closing: Array<() => Promise<void>> = []
function fixture(options: AntigravityOptions = {}) {
  const runtime = new AntigravityRuntime({ executable: fileURLToPath(new URL("./fixtures/agy-cli.cjs", import.meta.url)), allowToolBridge: true, ...options })
  const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
  closing.push(server.closeBackend)
  const send = (body: AgRequest) => server.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(body) }))
  return { runtime, send }
}
function request(text: string): AgRequest {
  return parseAgRequest({ model: "fixture-model", max_tokens: 100, messages: [{ role: "user", content: text }], tools: [{ name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }] })
}
// Hermes persists one multi-entry tool_call as several tool_use blocks: the
// first keeps the delivered ID, the rest get new client IDs.
function splitBatch(body: AgRequest, content: AgBlock[]): AgRequest {
  const call = content.find(b => b.type === "tool_use")!
  const split = [call, { ...call, id: "call_split_1", input: { key: "split" } }]
  return { ...body, messages: [...body.messages, { role: "assistant", content: split }, { role: "user", content: split.map((b, n) => ({ type: "tool_result" as const, tool_use_id: b.id, content: `R${n}` })) }] }
}
afterEach(async () => { for (const close of closing.splice(0)) await close() })

describe("Antigravity client-rewritten tool batches", () => {
  for (const reuseConversations of [false, true]) it(`replays complete client history when a delivered batch is split (reuse=${reuseConversations})`, async () => {
    const { send, runtime } = fixture({ reuseConversations })
    const initial = request("lookup")
    const first = await send(initial)
    expect(first.status, await first.clone().text()).toBe(200)
    const answer = await first.json() as { content: AgBlock[] }
    const continuation = splitBatch(initial, answer.content)
    const retry = await send(continuation)
    expect(retry.status, await retry.clone().text()).toBe(200)
    expect((await retry.json() as { content: AgBlock[] }).content).toEqual([{ type: "text", text: "R0|R1" }])
    expect(runtime.requests.at(0)?.continuation).toBe("client-context-replay")
    expect(runtime.recoveringTools.size).toBe(0)
    expect(runtime.hasConsumedTool("call_split_1")).toBe(true)
  })

  it("still refuses an earlier-history fork and keeps the live owner for the real continuation", async () => {
    const { send, runtime } = fixture()
    const initial = request("lookup")
    const answer = await (await send(initial)).json() as { content: AgBlock[] }
    const call = answer.content.find(b => b.type === "tool_use")!
    const fork: AgRequest = { ...splitBatch(initial, answer.content), messages: [{ role: "user", content: "lookup (edited)" }, ...splitBatch(initial, answer.content).messages.slice(1)] }
    expect((await send(fork)).status).toBe(409)
    expect(runtime.runs.size).toBe(1)
    const genuine: AgRequest = { ...initial, messages: [...initial.messages, { role: "assistant", content: answer.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "LIVE" }] }] }
    const live = await send(genuine)
    expect(live.status, await live.clone().text()).toBe(200)
    expect((await live.json() as { content: AgBlock[] }).content).toEqual([{ type: "text", text: "LIVE" }])
  })

  it("keeps refusing rewritten batches when native capabilities could repeat side effects", async () => {
    const { send } = fixture({ allowNativeSubagents: true })
    const initial = request("lookup")
    const answer = await (await send(initial)).json() as { content: AgBlock[] }
    const refused = await send(splitBatch(initial, answer.content))
    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain("changed its delivered history or tool batch")
  })

  it("keeps refusing a rewritten batch that also retargets the model", async () => {
    const { send } = fixture()
    const initial = request("lookup")
    const answer = await (await send(initial)).json() as { content: AgBlock[] }
    const refused = await send({ ...splitBatch(initial, answer.content), model: "fixture-model-high" })
    expect(refused.status).toBe(409)
  })
})

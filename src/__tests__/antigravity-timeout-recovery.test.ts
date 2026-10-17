import { afterEach, describe, expect, it } from "bun:test"
import { fileURLToPath } from "node:url"
import { createAntigravityServer } from "../proxy/backends/antigravity"
import { AntigravityRuntime } from "../proxy/backends/antigravityRuntime"
import { AntigravityError, parseAgRequest, type AgRequest, type AgBlock } from "../proxy/backends/antigravityProtocol"
import { DEFAULT_PROXY_CONFIG, type AntigravityOptions } from "../proxy/types"

const closing: Array<() => Promise<void>> = []
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function fixture(options: AntigravityOptions = {}) {
  const runtime = new AntigravityRuntime({ executable: fileURLToPath(new URL("./fixtures/agy-cli.cjs", import.meta.url)), allowToolBridge: true, turnTimeoutMs: 700, ...options })
  const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
  closing.push(server.closeBackend)
  const send = (body: AgRequest) => server.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(body) }))
  return { runtime, send }
}
function request(text: string): AgRequest {
  return parseAgRequest({ model: "fixture-model", max_tokens: 100, messages: [{ role: "user", content: text }], tools: [{ name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }] })
}
function follow(body: AgRequest, content: AgBlock[]): AgRequest {
  return { ...body, messages: [...body.messages, { role: "assistant", content }, { role: "user", content: content.filter(b => b.type === "tool_use").map(b => ({ type: "tool_result" as const, tool_use_id: b.id, content: "DONE_ONCE" })) }] }
}
afterEach(async () => { for (const close of closing.splice(0)) await close() })

describe("Antigravity per-response deadlines and timeout recovery", () => {
  it("lets the bridge own deadlines instead of a cumulative CLI print timeout", async () => {
    const { send } = fixture()
    const response = await send({ ...request("HTTP_BUDGET_PROBE"), tools: [] })
    expect(response.status, await response.clone().text()).toBe(200)
  })

  for (const reuseConversations of [false, true]) it(`excludes client waits and renews the budget for every result (reuse=${reuseConversations})`, async () => {
    const { send, runtime } = fixture({ reuseConversations, pendingToolTimeoutMs: 5000 })
    let body = request("TIMED_CHAIN")
    const started = Date.now()
    for (let round = 0; round < 3; round++) {
      const response = await send(body)
      expect(response.status, await response.clone().text()).toBe(200)
      const answer = await response.json() as { content: AgBlock[]; stop_reason: string }
      expect(answer.stop_reason).toBe("tool_use")
      body = follow(body, answer.content)
      // A real client tool may run longer than an individual model response.
      await delay(850)
      expect(runtime.runs.size).toBe(1)
    }
    const response = await send(body)
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.text()).toContain("DONE_ONCE")
    expect(Date.now() - started).toBeGreaterThan(runtime.turnTimeoutMs * 3)
    expect(runtime.requests.every(r => r.status === 200)).toBe(true)
  })

  for (const stream of [false, true]) it(`safely retries a timed-out consumed result without asking the client to repeat tools (stream=${stream})`, async () => {
    const { send, runtime } = fixture()
    const initial = request("TIMEOUT_AFTER_RESULT")
    const first = await send(initial)
    expect(first.status).toBe(200)
    const answer = await first.json() as { content: AgBlock[] }
    const continuation = { ...follow(initial, answer.content), stream }
    const failed = await send(continuation)
    const wire = await failed.text()
    expect(wire).toContain("Antigravity turn timed out")
    expect(failed.status).toBe(stream ? 200 : 504)
    expect(runtime.requests.at(0)?.status).toBe(504)
    expect(runtime.canRetryContinuation(continuation)).toBe(true)
    expect(runtime.runs.size).toBe(0)
    const call = answer.content.find(b => b.type === "tool_use")!
    expect(runtime.hasConsumedTool(call.id)).toBe(true)
    for (const changed of [{ system: "changed" }, { max_tokens: 200 }, { model: "fixture-model-high" }, { meridian_session_key: "other" }, { tool_choice: { type: "none" as const } }]) {
      expect((await send({ ...continuation, ...changed })).status).toBe(409)
    }
    const retry = await send({ ...continuation, stream: false })
    expect(retry.status, await retry.clone().text()).toBe(200)
    const result = await retry.json() as { content: AgBlock[] }
    expect(result.content).toEqual([{ type: "text", text: "DONE_ONCE" }])
    expect(runtime.canRetryContinuation(continuation)).toBe(false)
    const cached = await send({ ...continuation, stream: false })
    expect(cached.headers.get("x-meridian-response-replayed")).toBe("true")
    expect((await cached.json() as { content: AgBlock[] }).content).toEqual(result.content)
  })

  for (const variant of ["parallel", "inline-steering", "user-steering", "third-result"]) it(`recovers the full exact history for ${variant}`, async () => {
    const { send, runtime } = fixture()
    let body = request(variant === "third-result" ? "TIMED_CHAIN TIMEOUT_CHAIN" : `TIMEOUT_AFTER_RESULT ${variant === "parallel" ? "PARALLEL2" : ""}`)
    const ids: string[] = []
    for (let round = 0; round < (variant === "third-result" ? 3 : 1); round++) {
      const response = await send(body)
      expect(response.status, await response.clone().text()).toBe(200)
      const answer = await response.json() as { content: AgBlock[]; stop_reason: string }
      expect(answer.stop_reason).toBe("tool_use")
      ids.push(...answer.content.filter(b => b.type === "tool_use").map(b => b.id))
      body = follow(body, answer.content)
    }
    if (variant === "inline-steering") {
      const last = body.messages.at(-1)!
      last.content = [...last.content as AgBlock[], { type: "text", text: "Report the result only" }]
    }
    if (variant === "user-steering") body.messages.push({ role: "user", content: "Report the result only" })
    expect((await send(body)).status).toBe(504)
    expect(runtime.canRetryContinuation(body)).toBe(true)
    expect(ids.every(id => runtime.hasConsumedTool(id))).toBe(true)
    expect(runtime.recoveringTools.size).toBe(0)
    const retry = await send(body)
    expect(retry.status, await retry.clone().text()).toBe(200)
    const result = await retry.json() as { content: AgBlock[] }
    expect(result.content).toEqual([{ type: "text", text: variant === "parallel" ? "DONE_ONCE|DONE_ONCE" : "DONE_ONCE" }])
    expect(runtime.canRetryContinuation(body)).toBe(false)
    expect(runtime.recoveringTools.size).toBe(0)
  })

  it("does not grant timeout recovery when a native capability could have side effects", async () => {
    const { send, runtime } = fixture({ allowNativeSubagents: true })
    const initial = request("TIMEOUT_AFTER_RESULT")
    const answer = await (await send(initial)).json() as { content: AgBlock[] }
    const continuation = follow(initial, answer.content)
    expect((await send(continuation)).status).toBe(504)
    expect(runtime.canRetryContinuation(continuation)).toBe(false)
    expect((await send(continuation)).status).toBe(409)
  })

  it("does not grant timeout recovery after committing a subsequent tool batch", async () => {
    const { send, runtime } = fixture()
    const initial = request("NEXT_TOOL")
    const answer = await (await send(initial)).json() as { content: AgBlock[] }
    const run = [...runtime.runs.values()][0]!
    const markDelivered = run.markDelivered.bind(run)
    run.markDelivered = calls => {
      markDelivered(calls)
      const error = new AntigravityError("injected delivery timeout", 504, "api_error")
      run.abort(error)
      throw error
    }
    const continuation = follow(initial, answer.content)
    expect((await send(continuation)).status).toBe(504)
    expect(runtime.canRetryContinuation(continuation)).toBe(false)
    expect((await send(continuation)).status).toBe(409)
  })

  it("still bounds client tool execution with its separate pending deadline", async () => {
    const { send, runtime } = fixture({ pendingToolTimeoutMs: 100 })
    const response = await send(request("lookup"))
    expect(response.status).toBe(200)
    await response.text()
    await delay(250)
    expect(runtime.runs.size).toBe(0)
  })
})

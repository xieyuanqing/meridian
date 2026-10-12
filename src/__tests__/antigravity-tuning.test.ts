import { afterEach, describe, expect, it } from "bun:test"
import { fileURLToPath } from "node:url"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAntigravityServer } from "../proxy/backends/antigravity"
import { AntigravityRuntime } from "../proxy/backends/antigravityRuntime"
import { DEFAULT_PROXY_CONFIG, resolveBackendConfig } from "../proxy/types"
import { dropAgSamplingControls } from "../proxy/backends/antigravityProtocol"

type TestReply = { content: Array<{ type: string; text?: string; id?: string; name?: string }>; stop_reason?: string }
async function decode(response: Response): Promise<TestReply> { return await response.json() as TestReply }

const executable = fileURLToPath(new URL("./fixtures/agy-cli.cjs", import.meta.url))
const closing: Array<() => Promise<void>> = []
function fixture(options = {}) {
  const runtime = new AntigravityRuntime({ executable, allowToolBridge: true, turnTimeoutMs: 10000, ...options })
  const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
  closing.push(server.closeBackend)
  const send = (body: unknown) => server.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(body) }))
  return { runtime, server, send }
}
const tool = { name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }
const text = (content: string, extra = {}) => ({ model: "fixture-model", max_tokens: 100, messages: [{ role: "user", content }], tools: [], ...extra })
const spares = (runtime: AntigravityRuntime) => [...runtime.runs.values()].filter(run => run.prewarmed)
async function until(condition: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition was not reached")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
afterEach(async () => { for (const close of closing.splice(0)) await close() })

describe("Antigravity operator tuning", () => {
  it("reads the tuning environment without changing defaults", () => {
    const keys = ["MERIDIAN_AGY_ACCEPT_VERSIONS", "MERIDIAN_AGY_ACCOUNT_CHECK_TTL_MS", "MERIDIAN_AGY_MODELS_TTL_MS", "MERIDIAN_AGY_IDLE_TIMEOUT_MS", "MERIDIAN_AGY_LEAN_AGENT", "MERIDIAN_AGY_PREWARM", "MERIDIAN_AGY_PREWARM_TTL_MS"]
    const saved = keys.map(key => process.env[key])
    try {
      for (const key of keys) delete process.env[key]
      const defaults = new AntigravityRuntime(resolveBackendConfig({ backend: "antigravity" }).antigravity)
      expect([defaults.accountCheckTtlMs, defaults.modelsTtlMs, defaults.prewarmCount, defaults.idleConversationMs, defaults.options.leanAgent]).toEqual([0, 60_000, 0, defaults.pendingToolTimeoutMs, false])
      Object.assign(process.env, { MERIDIAN_AGY_ACCEPT_VERSIONS: "1.3.3, 1.3.4", MERIDIAN_AGY_ACCOUNT_CHECK_TTL_MS: "600000", MERIDIAN_AGY_MODELS_TTL_MS: "900000", MERIDIAN_AGY_IDLE_TIMEOUT_MS: "300000", MERIDIAN_AGY_LEAN_AGENT: "1", MERIDIAN_AGY_PREWARM: "1", MERIDIAN_AGY_PREWARM_TTL_MS: "120000" })
      const tuned = new AntigravityRuntime(resolveBackendConfig({ backend: "antigravity" }).antigravity)
      expect(tuned.options.acceptedCliVersions).toEqual(["1.3.3", "1.3.4"])
      expect([tuned.accountCheckTtlMs, tuned.modelsTtlMs, tuned.prewarmCount, tuned.idleConversationMs, tuned.prewarmTtlMs, tuned.options.leanAgent]).toEqual([600_000, 900_000, 1, 300_000, 120_000, true])
      expect(() => new AntigravityRuntime({ prewarm: -1 })).toThrow("non-negative")
      expect(() => new AntigravityRuntime({ idleConversationMs: 0 })).toThrow("positive")
    } finally {
      keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index] })
    }
  })

  it("admits only the CLI versions the operator listed", async () => {
    const { send, runtime } = fixture({ acceptedCliVersions: ["1.3.3"] })
    runtime.childEnv.AGY_FIXTURE_VERSION = "1.3.3"
    expect((await send(text("hello"))).status).toBe(200)
    expect(runtime.cliVersion).toBe("1.3.3")
    runtime.childEnv.AGY_FIXTURE_VERSION = "2.0.0"
    const refused = await send(text("hello again"))
    expect(refused.status).toBe(503)
    expect(await refused.text()).toContain("Unsupported agy version 2.0.0")
  })

  it("verifies the account on every admission unless a check lifetime is set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meridian-tuning-"))
    try {
      const count = async (options: object) => {
        const log = join(directory, `${Math.random()}.log`)
        const { send, runtime } = fixture({ reuseConversations: false, ...options })
        runtime.childEnv.AGY_FIXTURE_PROBE_LOG = log
        for (const content of ["one", "two", "three"]) expect((await send(text(content))).status).toBe(200)
        return (await readFile(log, "utf8")).trim().split("\n").length
      }
      // Startup model discovery checks once, then each admission checks again.
      expect(await count({})).toBe(4)
      expect(await count({ accountCheckTtlMs: 60_000 })).toBe(1)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it("does not serve a refused configuration from an expired check", async () => {
    const { send, runtime } = fixture({ reuseConversations: false, accountCheckTtlMs: 40 })
    expect((await send(text("one"))).status).toBe(200)
    runtime.childEnv.AGY_FIXTURE_API = "1"
    await new Promise(resolve => setTimeout(resolve, 60))
    expect((await send(text("two"))).status).toBe(503)
    delete runtime.childEnv.AGY_FIXTURE_API
    expect((await send(text("three"))).status).toBe(200)
  })

  it("starts ordinary requests under the lean agent and keeps the default agent for schema output", async () => {
    const lean = fixture({ leanAgent: true })
    expect((await decode(await lean.send(text("LEAN_PROBE")))).content[0]!.text).toBe("READY")
    const called = await decode(await lean.send(text("LEAN_PROBE", { tools: [tool] })))
    expect(called.stop_reason).toBe("tool_use")
    const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }
    const structured = await lean.send(text("DEFAULT_AGENT_PROBE", { output_config: { format: { type: "json_schema", schema } } }))
    expect(structured.status).toBe(200)
    expect((await decode(structured)).content[0]!.text).toBe(JSON.stringify({ answer: "READY" }))
    const standard = fixture()
    expect((await standard.send(text("DEFAULT_AGENT_PROBE"))).status).toBe(200)
  })

  it("refuses sampling settings by default and drops them only when the operator opts in", async () => {
    const chat = (server: ReturnType<typeof fixture>["server"], body: object, path = "/v1/chat/completions") => server.app.fetch(new Request("http://local" + path, { method: "POST", body: JSON.stringify(body) }))
    const messages = [{ role: "user", content: "hello" }]
    const strict = fixture()
    const refused = await strict.send(text("hello", { temperature: 0.7 }))
    expect(refused.status).toBe(400)
    expect(await refused.text()).toContain("does not support temperature")
    expect((await chat(strict.server, { model: "fixture-model", messages, temperature: 0.7 })).status).toBe(400)
    expect((await chat(strict.server, { model: "fixture-model", messages, seed: 7 })).status).toBe(400)

    const lenient = fixture({ ignoreSamplingControls: true })
    expect((await decode(await lenient.send(text("hello", { temperature: 0.7, top_p: 0.9, top_k: 40 })))).content[0]!.text).toBe("READY")
    const completion = await chat(lenient.server, { model: "fixture-model", messages, temperature: 0.2, top_p: 0.9, presence_penalty: 0.5, frequency_penalty: 0.5, repetition_penalty: 1.1, seed: 7, logit_bias: { "50256": -100 }, min_p: 0.05, typical_p: 0.9, top_k: 40 })
    expect(completion.status).toBe(200)
    expect(((await completion.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe("READY")
    expect((await chat(lenient.server, { model: "fixture-model", input: "hello", temperature: 0.2, top_p: 0.9 }, "/v1/responses")).status).toBe(200)
    // Settings that change what the client gets back are still refused.
    expect((await chat(lenient.server, { model: "fixture-model", messages, logprobs: true })).status).toBe(400)
    expect((await chat(lenient.server, { model: "fixture-model", messages, n: 2 })).status).toBe(400)
  })

  it("drops only top-level sampling fields", () => {
    const body = { model: "m", temperature: 1, seed: 3, messages: [{ role: "user", content: "temperature" }], tools: [{ name: "set", input_schema: { type: "object", properties: { temperature: { type: "number" }, seed: { type: "integer" } } } }], metadata: { top_p: "kept" } }
    expect(dropAgSamplingControls(body)).toEqual({ model: "m", messages: body.messages, tools: body.tools, metadata: body.metadata })
    for (const value of [null, "text", 7, [{ temperature: 1 }]]) expect(dropAgSamplingControls(value)).toEqual(value)
  })

  it("retains a completed conversation for the idle lifetime rather than the tool deadline", async () => {
    const { send, runtime } = fixture({ pendingToolTimeoutMs: 5000, idleConversationMs: 40 })
    expect((await send(text("one"))).status).toBe(200)
    expect(runtime.runs.size).toBe(1)
    await until(() => runtime.runs.size === 0)
  })
})

describe("Antigravity long requests and resumed conversations", () => {
  it("continues a live conversation when the client trimmed or padded the assistant text", async () => {
    const { send, runtime } = fixture()
    const request = text("NATIVE_FIRST")
    expect((await decode(await send(request))).content[0]!.text).toBe("READY")
    const next = await decode(await send({ ...request, messages: [...request.messages, { role: "assistant", content: "  READY\n" }, { role: "user", content: "NATIVE_SECOND" }] }))
    expect(next.content[0]!.text).toBe("NATIVE_REUSED")
    expect(runtime.reused).toBe(1)
  })

  it("delivers a request longer than one CLI message in acknowledged parts, losing nothing", async () => {
    const { send } = fixture({ messageBytes: 2048, requestBytes: 64_000 })
    const filler = "é🧪x ".repeat(1200)
    const messages = [{ role: "user", content: "ECHO_TAIL " + filler }, { role: "assistant", content: filler }, { role: "user", content: filler + "TAIL-MARKER-0123456789" }]
    const reply = await decode(await send({ ...text(""), messages }))
    // The fixture parses the joined conversation, so a lost or reordered byte fails before it answers.
    expect(reply.content.map(block => block.text).join("")).toBe("TAIL-MARKER-0123456789")
    expect(reply.stop_reason).toBe("end_turn")
  })

  it("refuses a request above the whole budget instead of cutting it", async () => {
    const { send, runtime } = fixture({ messageBytes: 2048, requestBytes: 8192 })
    const refused = await send(text("x".repeat(9000)))
    expect(refused.status).toBe(400)
    expect(JSON.stringify(await refused.json())).toContain("prompt is too long")
    expect(runtime.runs.size).toBe(0)
  })

  it("fails the turn when the CLI acts before the whole request arrived", async () => {
    const { send } = fixture({ messageBytes: 2048, requestBytes: 64_000 })
    expect((await send(text("PRELOAD_TOOL " + "y".repeat(6000), { tools: [tool] }))).status).toBe(502)
  })

  it("lets the CLI read back only this conversation's saved tool results", async () => {
    const { send } = fixture()
    expect((await decode(await send(text("SPILL_PROBE")))).content[0]!.text).toBe("READY")
  })

  it("resumes a conversation from disk for the configured lifetime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meridian-agy-resume-"))
    try {
      const { send, runtime } = fixture({ statePath: join(directory, "state.sqlite"), idleConversationMs: 50, nativeSessionTtlMs: 6 * 3_600_000 })
      runtime.childEnv.AGY_FIXTURE_CONVERSATION = "11111111-2222-4333-8444-555555555555"
      const request = text("NATIVE_FIRST")
      expect((await decode(await send(request))).content[0]!.text).toBe("READY")
      await until(() => runtime.runs.size === 0 && runtime.state!.records("native-sessions").length === 1)
      const lifetime = runtime.state!.records("native-sessions")[0]!.expires - Date.now()
      expect(lifetime).toBeGreaterThan(5 * 3_600_000)
      const next = await decode(await send({ ...request, messages: [...request.messages, { role: "assistant", content: "READY" }, { role: "user", content: "RESTORED_PROBE" }] }))
      expect(next.content[0]!.text).toBe("READY")
      expect(runtime.restored).toBe(1)
    } finally { for (const close of closing.splice(0)) await close(); await rm(directory, { recursive: true, force: true }) }
  })

  it("validates the message and request sizes", () => {
    const defaults = new AntigravityRuntime()
    expect([defaults.messageBytes, defaults.requestBytes]).toEqual([160_000, 640_000])
    expect(() => new AntigravityRuntime({ messageBytes: 192_000 })).toThrow("CLI's own cut")
    expect(() => new AntigravityRuntime({ messageBytes: 4096, requestBytes: 1024 })).toThrow("at least one message")
    expect(() => new AntigravityRuntime({ nativeSessionTtlMs: 0 })).toThrow("positive")
  })
})

describe("Antigravity prewarmed processes", () => {
  it("serves the next new conversation of the same shape from a spare and keeps one ready", async () => {
    const { send, runtime } = fixture({ prewarm: 1 })
    expect((await decode(await send(text("first")))).content[0]!.text).toBe("READY")
    expect(runtime.prewarmed).toBe(0)
    expect(spares(runtime)).toHaveLength(1)
    const spare = spares(runtime)[0]!
    const system = "Client instructions arrive only with the adopting request"
    const request = text("NATIVE_FIRST", { system })
    const second = await decode(await send(request))
    expect(second.content[0]!.text).toBe("READY")
    expect(runtime.prewarmed).toBe(1)
    expect(spare.prewarmed).toBe(false)
    expect(spare.request.system).toBe(system)
    await until(() => spares(runtime).length === 1)
    expect(spares(runtime)[0]).not.toBe(spare)
    // The adopted process is now an ordinary live conversation.
    const next = await decode(await send({ ...request, messages: [...request.messages, { role: "assistant", content: second.content }, { role: "user", content: "NATIVE_SECOND" }] }))
    expect(next.content[0]!.text).toBe("NATIVE_REUSED")
    expect(runtime.reused).toBe(1)
    expect(runtime.prewarmed).toBe(1)
  })

  it("adopts a spare with client tools and completes the tool continuation", async () => {
    const { send, runtime } = fixture({ prewarm: 1 })
    const first = await decode(await send(text("alpha", { tools: [tool] })))
    expect(first.stop_reason).toBe("tool_use")
    const request = text("beta", { tools: [tool] })
    const called = await decode(await send(request))
    expect(runtime.prewarmed).toBe(1)
    const call = called.content.find(block => block.type === "tool_use")!
    expect(call.name).toBe("lookup")
    const done = await decode(await send({ ...request, messages: [...request.messages, { role: "assistant", content: called.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "RECEIPT-7" }] }] }))
    expect(done.content[0]!.text).toBe("RECEIPT-7")
  })

  it("does not adopt across a different model, effort or tool catalog", async () => {
    const { send, runtime } = fixture({ prewarm: 1 })
    expect((await send(text("first"))).status).toBe(200)
    const original = spares(runtime)[0]!
    expect((await send(text("second", { tools: [tool], tool_choice: { type: "none" } }))).status).toBe(200)
    expect((await send(text("third", { model: "fixture-model-high" }))).status).toBe(200)
    expect(runtime.prewarmed).toBe(0)
    await original.settled
    // One spare at a time: the newest shape replaced the earlier ones.
    await until(() => spares(runtime).length === 1)
    expect(spares(runtime)[0]!.request.model).toBe("fixture-model-high")
  })

  it("expires an unused spare and never prewarms without spare capacity", async () => {
    const expiring = fixture({ prewarm: 1, prewarmTtlMs: 1500 })
    expect((await expiring.send(text("first"))).status).toBe(200)
    expect(spares(expiring.runtime)).toHaveLength(1)
    await until(() => spares(expiring.runtime).length === 0, 5000)
    expect(expiring.runtime.failed).toBe(0)
    const full = fixture({ prewarm: 1, maxConcurrent: 1 })
    expect((await full.send(text("first"))).status).toBe(200)
    expect(spares(full.runtime)).toHaveLength(0)
    expect(full.runtime.runs.size).toBe(1)
  })

  it("gives up a spare before any live conversation when capacity is full", async () => {
    const { send, runtime } = fixture({ prewarm: 1, maxConcurrent: 2 })
    const request = text("NATIVE_FIRST")
    const first = await decode(await send(request))
    expect(spares(runtime)).toHaveLength(1)
    const continued = { ...request, messages: [...request.messages, { role: "assistant", content: first.content }, { role: "user", content: "NATIVE_SECOND" }] }
    const second = await decode(await send(continued))
    expect(second.content[0]!.text).toBe("NATIVE_REUSED")
    // A different shape needs a slot: the spare goes, the continued conversation stays,
    // and no spare for the new shape is allowed to push it out afterwards.
    expect((await send(text("other shape", { model: "fixture-model-high" }))).status).toBe(200)
    expect(runtime.reclaimed).toBe(1)
    expect(runtime.runs.size).toBe(2)
    expect(spares(runtime)).toHaveLength(0)
    const third = await send({ ...continued, messages: [...continued.messages, { role: "assistant", content: second.content }, { role: "user", content: "still here" }] })
    expect(third.status).toBe(200)
    expect(runtime.reused).toBe(2)
  })

  it("makes room for a spare by retiring a one-shot conversation before a continued one", async () => {
    const { send, runtime } = fixture({ prewarm: 1, maxConcurrent: 3 })
    const request = text("NATIVE_FIRST")
    const first = await decode(await send(request))
    const continued = { ...request, messages: [...request.messages, { role: "assistant", content: first.content }, { role: "user", content: "NATIVE_SECOND" }] }
    const second = await decode(await send(continued))
    expect(runtime.reused).toBe(1)
    const main = [...runtime.runs.values()].find(run => run.continued)!
    expect((await send(text("one-shot B"))).status).toBe(200)
    const oneShot = [...runtime.runs.values()].find(run => !run.prewarmed && run !== main)!
    await until(() => spares(runtime).length === 1)
    expect(runtime.runs.size).toBe(3)
    expect((await send(text("one-shot C"))).status).toBe(200)
    expect(runtime.prewarmed).toBe(2)
    await oneShot.settled
    await until(() => spares(runtime).length === 1)
    expect(runtime.runs.has(main.id)).toBe(true)
    expect(runtime.runs.has(oneShot.id)).toBe(false)
    expect(runtime.failed + runtime.reclaimed).toBe(0)
    const third = await send({ ...continued, messages: [...continued.messages, { role: "assistant", content: second.content }, { role: "user", content: "still here" }] })
    expect(third.status).toBe(200)
    expect(runtime.reused).toBe(2)
  })

  it("skips prewarming for schema output and when conversation reuse is disabled", async () => {
    const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }
    const structured = fixture({ prewarm: 1 })
    expect((await structured.send(text("one", { output_config: { format: { type: "json_schema", schema } } }))).status).toBe(200)
    expect(structured.runtime.runs.size).toBe(0)
    const oneShot = fixture({ prewarm: 1, reuseConversations: false })
    expect((await oneShot.send(text("one"))).status).toBe(200)
    await until(() => oneShot.runtime.runs.size === 0)
  })

  it("stops spares on shutdown without counting them as failures", async () => {
    const { send, runtime, server } = fixture({ prewarm: 1 })
    expect((await send(text("first"))).status).toBe(200)
    expect(spares(runtime)).toHaveLength(1)
    await server.closeBackend()
    expect(runtime.runs.size).toBe(0)
    expect(runtime.failed).toBe(0)
  })
})

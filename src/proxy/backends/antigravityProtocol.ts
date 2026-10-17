import { z } from "zod"

export class AntigravityError extends Error {
  constructor(message: string, readonly status = 400, readonly type = "invalid_request_error", readonly retryAfter = status === 429 ? 60 : status === 503 ? 5 : undefined) { super(message) }
}

/** Preserve actionable account failures without retrying a potentially executed tool. */
export function classifyAgFailure(message: string): AntigravityError {
  if (/INVALID_ARGUMENT/.test(message)) return new AntigravityError(message)
  if (/rate.?limit|quota|resource.exhausted|too many requests|\b429\b/i.test(message)) {
    const seconds = /retry(?:[- ]after| in)[:= ]+(\d+)\s*(?:s|seconds)?/i.exec(message)?.[1]
    return new AntigravityError(message, 429, "rate_limit_error", seconds ? Math.min(86400, Math.max(1, Number(seconds))) : 60)
  }
  if (/unauthenticated|authentication required|sign.?in required|login required|token expired/i.test(message)) return new AntigravityError(message, 401, "authentication_error")
  if (/overloaded|service unavailable|\b503\b|\b529\b/i.test(message)) return new AntigravityError(message, 503, "overloaded_error")
  return new AntigravityError(message, 502, "api_error")
}

const textBlock = z.object({ type: z.literal("text"), text: z.string() })
const imageBlock = z.object({ type: z.literal("image"), source: z.union([z.object({ type: z.literal("url"), url: z.url().startsWith("https://") }).strict(), z.object({
  type: z.literal("base64"), media_type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  data: z.string().min(4).max(8 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/).refine(data => data.length % 4 === 0, "Invalid base64 length"),
}).strict()]) })
const documentBlock = z.object({ type: z.literal("document"), title: z.string().optional(), source: z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), media_type: z.literal("text/plain"), data: z.string().max(1024 * 1024) }).strict(),
  z.object({ type: z.literal("base64"), media_type: z.enum(["application/pdf", "text/plain"]), data: z.string().max(8 * 1024 * 1024) }).strict(),
]) }).strict()
const audioBlock = z.object({ type: z.literal("audio"), source: z.object({ type: z.literal("base64"), media_type: z.enum(["audio/wav", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/flac"]), data: z.string().max(8 * 1024 * 1024) }).strict() }).strict()
const videoBlock = z.object({ type: z.literal("video"), source: z.object({ type: z.literal("base64"), media_type: z.enum(["video/mp4", "video/webm", "video/quicktime"]), data: z.string().max(8 * 1024 * 1024) }).strict() }).strict()
const callBlock = z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) })
const resultBlock = z.object({
  type: z.literal("tool_result"), tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.discriminatedUnion("type", [textBlock, imageBlock, documentBlock, audioBlock, videoBlock]))]).optional(), is_error: z.boolean().optional(),
})
const block = z.discriminatedUnion("type", [textBlock, imageBlock, documentBlock, audioBlock, videoBlock, callBlock, resultBlock])
const message = z.object({ role: z.enum(["user", "assistant"]), content: z.union([z.string(), z.array(block)]) })
const outputFormat = z.object({ type: z.literal("json_schema"), schema: z.record(z.string(), z.unknown()) }).strict()
const schema = z.object({
  meridian_tool_grammars: z.record(z.string(), z.object({ syntax: z.enum(['lark', 'regex']), definition: z.string().max(65536) }).strict()).refine(value => Object.keys(value).length <= 16, 'At most 16 custom grammars').optional(),
  meridian_session_key: z.string().max(512).optional(),
  model: z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  messages: z.array(message).min(1),
  system: z.union([z.string(), z.array(textBlock)]).optional(),
  // A catalog is not an execution batch. The CLI accepts larger MCP catalogs;
  // retain per-tool validation and the runtime's separate action limits.
  tools: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), description: z.string().optional(), input_schema: z.record(z.string(), z.unknown()) })).default([]),
  stream: z.boolean().default(false), max_tokens: z.number().int().positive().optional(),
  tool_choice: z.discriminatedUnion("type", [
    z.object({ type: z.enum(["auto", "any"]), disable_parallel_tool_use: z.boolean().optional() }).strict(),
    z.object({ type: z.literal("none") }).strict(),
    z.object({ type: z.literal("tool"), name: z.string(), disable_parallel_tool_use: z.boolean().optional() }).strict(),
  ]).optional(),
  thinking: z.discriminatedUnion("type", [
    z.object({ type: z.literal("disabled") }),
    z.object({ type: z.literal("enabled"), budget_tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), display: z.enum(["summarized", "omitted"]).optional() }).strict(),
    z.object({ type: z.literal("adaptive"), display: z.enum(["summarized", "omitted"]).optional() }),
  ]).optional(),
  output_config: z.object({
    effort: z.enum(["low", "medium", "high"]).optional(),
    format: outputFormat.optional(),
  }).strict().optional(),
  output_format: outputFormat.optional(),
  temperature: z.number().optional(), top_p: z.number().optional(), top_k: z.number().optional(),
  stop_sequences: z.array(z.string().min(1).max(1024)).max(4).optional(),
}).passthrough()

/** Request fields that only shape token sampling. The CLI exposes none of them. */
export const AG_SAMPLING_CONTROLS = ["temperature", "top_p", "top_k", "min_p", "typical_p", "presence_penalty", "frequency_penalty", "repetition_penalty", "seed", "logit_bias"]
/**
 * Operator opt-in for clients that always send sampling settings: remove them
 * from a raw Messages, Chat Completions or Responses body instead of refusing
 * the request. Fields that change what is returned (n, logprobs) stay refused.
 */
export function dropAgSamplingControls(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !AG_SAMPLING_CONTROLS.includes(key)))
}

export type AgRequest = z.infer<typeof schema>
export type AgMessage = z.infer<typeof message>
export type AgBlock = z.infer<typeof block>
export type AgCall = z.infer<typeof callBlock>
export type AgResult = z.infer<typeof resultBlock>
export function parseAgRequest(value: unknown, adaptThinkingBudgets = false): AgRequest {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new AntigravityError("Antigravity supports text, images, documents and adapted media; invalid or unsupported request: " + parsed.error.issues.map(i => i.path.join(".") + " " + i.message).join("; "))
  const request = parsed.data
  if (request.thinking?.type === "enabled") {
    if (!adaptThinkingBudgets) throw new AntigravityError("Numeric thinking budgets require MERIDIAN_AGY_ADAPT_THINKING_BUDGETS=1; this maps budgets to approximate Gemini effort, not token limits")
    const family = /^(gemini-[a-zA-Z0-9._-]+)-(low|medium|high)$/.exec(request.model)?.[1]
    if (!family) throw new AntigravityError("Thinking-budget adaptation requires a Gemini low/medium/high model slug from /v1/models")
    const budget = request.thinking.budget_tokens
    const effort = budget <= 2048 ? "low" : budget <= 8192 ? "medium" : "high"
    if (request.output_config?.effort && request.output_config.effort !== effort) throw new AntigravityError("Explicit effort conflicts with the adapted thinking budget")
    request.model = `${family}-${effort}`
    request.thinking = { type: "adaptive", ...(request.thinking.display ? { display: request.thinking.display } : {}) }
    request.output_config = { ...request.output_config, effort }
  }
  if (request.output_format) {
    if (request.output_config?.format) throw new AntigravityError("Use only one of output_format and output_config.format")
    request.output_config = { ...request.output_config, format: request.output_format }
    delete request.output_format
  }
  for (const key of ["temperature", "top_p", "top_k", "betas"]) {
    if (request[key] !== undefined) throw new AntigravityError(`Antigravity does not support ${key}`)
  }
  if (request.output_config?.effort && !request.model.endsWith("-" + request.output_config.effort)) throw new AntigravityError("This agy model does not support the requested effort override; select the matching low/medium/high model slug from /v1/models")
  const choice = request.tool_choice
  if (choice?.type === "tool" && !request.tools.some(t => t.name === choice.name)) throw new AntigravityError("tool_choice names an unknown tool")
  if (request.tool_choice?.type === "any" && !request.tools.length) throw new AntigravityError("tool_choice any requires tools")

  if (new Set(request.tools.map(t => t.name)).size !== request.tools.length) throw new AntigravityError("Duplicate tool names")
  if (request.messages.at(-1)?.role !== "user") throw new AntigravityError("The last message must be a user message")
  // A replay must never turn an unpaired historical action into a fresh instruction.
  const seen = new Set<string>()
  let pending = new Set<string>()
  for (const message of request.messages) {
    const content = blocks(message)
    const results = content.filter(b => b.type === "tool_result")
    if (pending.size && (message.role !== "user" || results.length !== pending.size)) throw new AntigravityError("Every tool call must have a matching result in the next user message")
    for (const b of content) {
      if (b.type === "tool_use") {
        if (message.role !== "assistant" || !b.id || seen.has(b.id)) throw new AntigravityError("Invalid or duplicate historical tool call")
        seen.add(b.id)
      }
      if (b.type === "tool_result") {
        if (message.role !== "user" || !pending.delete(b.tool_use_id)) throw new AntigravityError("Unknown or duplicate historical tool result")
      }
    }
    if (pending.size) throw new AntigravityError("Missing historical tool result")
    pending = new Set(content.filter(b => b.type === "tool_use").map(b => b.id))
  }
  return request
}
export function blocks(message: AgMessage): AgBlock[] {
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]"
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => JSON.stringify(key) + ":" + stable(val)).join(",") + "}"
  return JSON.stringify(value) ?? "null"
}
export function historyKey(messages: AgMessage[]): string {
  // The CLI ends its text with a newline and clients commonly trim what they
  // store, so whitespace at the edges of assistant text is not history. Without
  // this, every new user turn of such a client misses its live conversation.
  return stable(messages.map(m => ({ role: m.role, content: m.role === "assistant" ? blocks(m).map(b => b.type === "text" ? { ...b, text: b.text.trim() } : b).filter(b => b.type !== "text" || b.text) : blocks(m) })))
}
/**
 * Hermes persists one multi-entry call as consecutive same-name tool_use blocks:
 * the first keeps the delivered ID and each carries a slice of `calls`. When the
 * client's assistant message is exactly such a split of the delivered batch,
 * fold the children's results back into one result per delivered call so the
 * live process can continue. Anything else returns undefined.
 */
export function mergeExpandedAgBatch(delivered: AgCall[], sent: AgMessage | undefined, client: AgMessage, results: AgResult[]): AgResult[] | undefined {
  const withoutCalls = (m: AgMessage) => historyKey([{ ...m, content: blocks(m).filter(b => b.type !== "tool_use") }])
  if (!sent || sent.role !== "assistant" || client.role !== "assistant" || withoutCalls(sent) !== withoutCalls(client)) return undefined
  const uses = blocks(client).filter((b): b is AgCall => b.type === "tool_use")
  const ids = new Set(delivered.map(call => call.id))
  const resultFor = new Map(results.map(result => [result.tool_use_id, result]))
  if (resultFor.size !== uses.length || uses.some(use => !resultFor.has(use.id))) return undefined
  const merged: AgResult[] = []
  for (let i = 0; i < uses.length;) {
    const call = delivered.find(d => d.id === uses[i]!.id)
    if (!call) return undefined
    const group = [uses[i++]!]
    while (i < uses.length && !ids.has(uses[i]!.id) && uses[i]!.name === call.name) group.push(uses[i++]!)
    if (group.length === 1) {
      if (stable(group[0]!.input) !== stable(call.input)) return undefined
      merged.push(resultFor.get(call.id)!)
      continue
    }
    const entries = group.map(use => use.input.calls)
    if (!Array.isArray(call.input.calls) || entries.some(e => !Array.isArray(e)) || stable(call.input.calls) !== stable(entries.flat())) return undefined
    const parts = group.map(use => resultFor.get(use.id)!)
    const content = parts.flatMap((part, n) => [
      { type: "text" as const, text: `[entry ${n + 1} of ${parts.length}]` },
      ...(part.content === undefined ? [] : typeof part.content === "string" ? [{ type: "text" as const, text: part.content }] : part.content),
    ])
    merged.push({ type: "tool_result", tool_use_id: call.id, content, ...(parts.every(part => part.is_error) ? { is_error: true } : {}) })
  }
  return merged.length === delivered.length ? merged : undefined
}
/** The CLI keeps the first 192,000 bytes of a user message and silently drops the rest. */
export const AG_CLI_MESSAGE_BYTES = 192_000
const AG_PART_FRAME_BYTES = 512
/**
 * Never hand the CLI a message it would cut. A request above one message is
 * delivered as consecutive messages the CLI acknowledges in turn; a request
 * above the whole budget is refused so the client can compact its history.
 */
export function splitAgPrompt(text: string, messageBytes: number, requestBytes: number): string[] {
  const bytes = Buffer.byteLength(text)
  // Both phrases are ones clients and gateways already treat as a caller-side
  // overflow to compact, not an upstream fault to retry. Sizes are in KB so no figure reads as a token window.
  if (bytes > requestBytes) throw new AntigravityError(`prompt is too long: context length exceeded for one Antigravity request (${Math.ceil(bytes / 1024)} KB rendered, up to ${Math.floor(requestBytes / 1024)} KB carried); compact or shorten the conversation`)
  if (bytes <= messageBytes) return [text]
  const budget = messageBytes - AG_PART_FRAME_BYTES
  const pieces: string[] = []
  let rest = text
  while (Buffer.byteLength(rest) > budget) {
    let low = 0, high = Math.min(rest.length, budget)
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (Buffer.byteLength(rest.slice(0, middle)) <= budget) low = middle
      else high = middle - 1
    }
    // Prefer the start of a conversation message; never split a surrogate pair.
    const boundary = rest.lastIndexOf(',{"role":"', low - 1)
    if (boundary > low / 2) low = boundary + 1
    else if ((rest.charCodeAt(low - 1) & 0xfc00) === 0xd800) low--
    pieces.push(rest.slice(0, low))
    rest = rest.slice(low)
  }
  pieces.push(rest)
  const total = pieces.length
  return pieces.map((piece, index) => (index < total - 1
    ? `Meridian request part ${index + 1} of ${total}. This request is longer than one CLI message, so it arrives as ${total} consecutive messages that join, in order and without separators, into one request. Keep this part in context. Do not answer the client and do not call any tool yet. Reply with exactly: OK`
    : `Meridian request part ${total} of ${total} (final). It continues exactly where part ${total - 1} ended. Now follow the complete request and answer the client's latest user message, the last entry of the conversation.`) + "\n\n" + piece)
}
export function contractKey(request: AgRequest): string {
  return stable({ session: request.meridian_session_key, grammars: request.meridian_tool_grammars, model: request.model, system: request.system, tools: request.tools, max_tokens: request.max_tokens, thinking: request.thinking, stop_sequences: request.stop_sequences, output_config: request.output_config })
}
/** Client plugins may refresh instructions/tool definitions, but cannot retarget a pending execution. */
export function sameAgExecutionContract(previous: AgRequest, next: AgRequest): boolean {
  return contractKey({ ...previous, system: next.system, tools: next.tools }) === contractKey(next)
}
export function hasAgImages(messages: AgMessage[]): boolean {
  return messages.some(m => blocks(m).some(b => (b.type === "image" || b.type === "document" || b.type === "audio" || b.type === "video") || (b.type === "tool_result" && Array.isArray(b.content) && b.content.some(c => c.type === "image" || c.type === "document" || c.type === "audio" || c.type === "video"))))
}
export function availableAgTools(request: AgRequest): AgRequest["tools"] {
  const choice = request.tool_choice
  return choice?.type === "none" ? [] : choice?.type === "tool" ? request.tools.filter(t => t.name === choice.name) : request.tools
}
export function parallelAgTool(request: AgRequest): AgRequest["tools"][number] | undefined {
  if (!availableAgTools(request).length || (request.tool_choice && "disable_parallel_tool_use" in request.tool_choice && request.tool_choice.disable_parallel_tool_use)) return undefined
  let name = "meridian_parallel"
  while (request.tools.some(tool => tool.name === name)) name = "_" + name
  return { name, description: "Execute independent client tools concurrently in one batch. Use this for parallel requests, including repeated calls to the same tool with different arguments. Each result identifies its original name and input. Follow the exact client schemas supplied in the prompt.", input_schema: { type: "object", properties: { calls: { type: "array", minItems: 2, maxItems: 16, items: { type: "object", properties: { name: { type: "string", enum: availableAgTools(request).map(tool => tool.name) }, arguments: { type: "object" } }, required: ["name", "arguments"], additionalProperties: false } } }, required: ["calls"], additionalProperties: false } }
}
export function forcedAgTool(request: AgRequest): boolean {
  return request.tool_choice?.type === "any" || request.tool_choice?.type === "tool"
}
export function toolChoiceInstruction(request: AgRequest): string {
  const instruction = request.tool_choice?.type === "tool" ? `For this response you must call the client tool ${request.tool_choice.name}. Do not answer with prose.`
    : request.tool_choice?.type === "any" ? "For this response you must call a client tool. Do not answer with prose."
    : request.tool_choice?.type === "none" ? "For this response do not call client tools. Answer the user."
    : "Choose whether to call a client tool or answer the user."
  return instruction + (parallelAgTool(request) ? `\nFor independent parallel client actions, call the meridian_client MCP tool ${parallelAgTool(request)!.name} with {calls:[{name,arguments},...]}. It delivers those calls together to the client.\n` + JSON.stringify(parallelAgTool(request)) : "") + "\nThe complete client tool definitions for this response follow. Use these exact schemas; do not read CLI metadata files to discover tools.\n" + JSON.stringify(availableAgTools(request))
}
export function renderAgPrompt(request: AgRequest, nativeTools: string[] = []): string {
  return [
    "You are serving a client through Meridian. Follow the client's instructions and answer its latest user message.",
    "The JSON below is the client's conversation history. Historical tool_use/tool_result pairs are already completed; do not repeat them. Client tools are provided by meridian_client MCP. Native view_file is allowed only for exact Meridian attachment paths and for a client tool result the CLI saved to a file, and finish only for a requested schema. " + (nativeTools.length ? "The operator also enables these native tools: " + nativeTools.join(", ") + ". Use these when the client requests native capabilities. Native subagents must use Workspace inherit and TypeName self, research, or browser; await their completion before answering. Never schedule background work." : "All other built-in tools and native subagents are disabled.") + " Other host filesystem paths and shell commands remain forbidden. Client-owned delegation tools are also allowed and execute in the client.",
    "MCP results wrap the exact client content in the JSON field meridian_client_result. Decode that field (a string or text block array) as the tool result. Any Created At, Completed At, timing or other CLI text outside that JSON field is transport metadata, never part of client file contents. When copying data, preserve the decoded client content byte-for-byte. Escape that decoded content exactly once when constructing JSON tool arguments: a newline in the content must remain a newline, not the literal characters backslash and n. Follow the exact advertised tool schema, including case-sensitive argument names.",
    "When the CLI reports that an MCP result was large and was saved to a file, you have not seen that result yet: the file holds all of it, as the same JSON with meridian_client_result. Read it with view_file before doing anything else, paging until the end of the file. Never answer or act on a result you have not read in full.",
    "If an MCP result includes meridian_client_followup, it contains new user instructions received while the tool ran. Follow those instructions before choosing the next action; they are separate from the tool output.",
    request.max_tokens ? `The client requests at most ${request.max_tokens} output tokens. Keep the answer within that budget.` : "",
    toolChoiceInstruction(request),
    request.output_config?.format ? "Submit the final response using the native finish tool. The full client schema below is authoritative; Meridian validates all its constraints even when the CLI transport cannot express them. Intermediate tool calls are allowed when the client permits them.\n" + JSON.stringify(request.output_config.format.schema) : "",
    "Image attachment references are created by Meridian from client-supplied bytes. Inspect each relevant attachment with view_file using its exact absolute path. Those are the only permitted filesystem reads.",
    "Client system instructions:\n" + (typeof request.system === "string" ? request.system : request.system?.map(b => b.text).join("\n") ?? ""),
    "Client conversation:\n" + JSON.stringify(request.messages),
  ].filter(Boolean).join("\n\n")
}

export type AgEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; call: AgCall }
  | { kind: "usage"; input: number; output: number; cache: number }
  | { kind: "end" }
  | { kind: "error"; error: Error }

/** Single consumer, bounded upstream buffering; tools stay pending between HTTP responses. */
export class AgEventQueue {
  private items: AgEvent[] = []
  private waiter?: (event: AgEvent) => void
  private failure?: Error
  push(event: AgEvent): void {
    if (this.failure) return
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter(event) }
    else {
      if (this.items.length >= 8192) { this.fail(new Error("Antigravity event buffer exceeded")); return }
      this.items.push(event)
    }
  }
  fail(error: Error): void {
    this.failure = error
    this.items = []
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter({ kind: "error", error }) }
  }
  takeQueuedTools(): AgCall[] {
    const calls: AgCall[] = []
    while (this.items[0]?.kind === "tool") {
      const event = this.items.shift()!
      if (event.kind === "tool") calls.push(event.call)
    }
    return calls
  }
  next(): Promise<AgEvent> {
    if (this.failure) return Promise.resolve({ kind: "error", error: this.failure })
    const event = this.items.shift()
    if (event) return Promise.resolve(event)
    if (this.waiter) return Promise.reject(new Error("Concurrent Antigravity response consumer"))
    return new Promise(resolve => { this.waiter = resolve })
  }
}

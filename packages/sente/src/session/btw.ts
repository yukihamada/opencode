import type { SessionV1 } from "@sente-ai/core/v1/session"
import type { ModelV2 } from "@sente-ai/core/model"
import type { ProviderV2 } from "@sente-ai/core/provider"
import { LLMEvent, Usage } from "@sente-ai/llm"
import { Cause, Effect, Exit, Option, Schema, Stream } from "effect"
import type { Agent } from "@/agent/agent"
import type { Provider } from "@/provider/provider"
import { SecretRedact } from "@/tool/secret-redact"
import type { LLM } from "./llm"
import { SessionEscalation } from "./escalation"
import { MessageID, SessionID } from "./schema"
import { Session } from "./session"

// `/btw <question>`: a quick side question about the running session.
// The answer comes from a separate one-shot model request built from a text
// excerpt of the session. Nothing is added to the conversation, the main run is
// never awaited or interrupted, and the request carries no tools. Its cost is
// recorded on the session's metadata (`btw_spend`) so the cost limit, the
// sidebar and the status line all count it.

/** How many of the latest messages the excerpt is built from. */
export const MESSAGE_LIMIT = 40
const CONTEXT_CHARS = 16_000
/** Share of the excerpt kept for compaction summaries, which stand in for older turns. */
const SUMMARY_CHARS = 4_000
const PART_CHARS = 1_200
const TOOL_OUTPUT_CHARS = 400
const QUESTION_CHARS = 4_000
/** Side answers are meant to be short; this also bounds their cost. */
export const MAX_OUTPUT_TOKENS = 1_500

export const AGENT_NAME = "btw"
export const SPEND_KEY = "btw_spend"
const SPEND_RECENT = 200

const INSTRUCTIONS = [
  "You answer a quick side question (/btw) about a coding session that is still running.",
  "The session excerpt below is read-only context. You cannot call tools, read files, run commands or change anything; do not offer to.",
  "Answer directly and concisely in markdown, from the excerpt only. Tool outputs in the excerpt are shortened to their last lines.",
  "If the answer is not in the excerpt, say exactly that it is not in the part of the session you can see (in Japanese: 「その内容は今見えている範囲にありません」) and do not guess.",
  "Reply in the language of the question.",
].join("\n")

// Every tool permission is denied as well, so a side answer can never edit
// files or run a shell even if a provider ignored the empty tool list.
export const AGENT: Agent.Info = {
  name: AGENT_NAME,
  description: "Side question about the current session (/btw). Read-only, no tools.",
  mode: "primary",
  permission: [{ permission: "*", pattern: "*", action: "deny" }],
  options: {},
  native: true,
  prompt: INSTRUCTIONS,
}

export const Approval = Schema.Struct({
  spent: Schema.Finite,
  estimate: Schema.optional(Schema.Finite),
  limit: Schema.Finite,
})

export const Answer = Schema.Struct({
  text: Schema.String,
  providerID: Schema.String,
  modelID: Schema.String,
  cost: Schema.Finite,
  tokens: Schema.Struct({ input: Schema.Finite, output: Schema.Finite }),
  /** No small model was found, so the session's main model answered. */
  fallback: Schema.optional(Schema.Boolean),
  /** Set when the call was not made because it would cross the session's cost limit. */
  approval: Schema.optional(Approval),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "SessionBtwAnswer" })
export type Answer = Schema.Schema.Type<typeof Answer>

export type ModelRef = { providerID: ProviderV2.ID; modelID: ModelV2.ID }

function clip(text: string, limit: number) {
  const value = text.trim()
  return value.length > limit ? value.slice(0, limit) + "…" : value
}

function tail(text: string, limit: number) {
  const value = text.trim()
  return value.length > limit ? "…" + value.slice(value.length - limit) : value
}

function toolLine(part: SessionV1.ToolPart) {
  const input = clip(JSON.stringify(part.state.input ?? {}), 200)
  if (part.state.status === "error") return `[tool ${part.tool} failed: ${clip(part.state.error, 300)}] ${input}`
  if (part.state.status === "completed") {
    const output = part.state.time.compacted ? "" : tail(part.state.output, TOOL_OUTPUT_CHARS)
    return [`[tool ${part.tool} done: ${clip(part.state.title, 120)}] ${input}`, ...(output ? [`output (tail):\n${output}`] : [])].join("\n")
  }
  return `[tool ${part.tool} ${part.state.status}] ${input}`
}

function messageLines(message: SessionV1.WithParts) {
  return message.parts.flatMap((part) => {
    if (part.type === "text" && !part.synthetic && !part.ignored && part.text.trim()) return [clip(part.text, PART_CHARS)]
    if (part.type === "subtask") return [`[subtask ${part.agent}] ${clip(part.prompt, PART_CHARS)}`]
    if (part.type === "tool") return [toolLine(part)]
    return []
  })
}

function fit(blocks: string[], limit: number) {
  const kept: string[] = []
  let size = 0
  for (const block of blocks.toReversed()) {
    if (size + block.length > limit && kept.length > 0) break
    kept.unshift(block.length > limit ? "…" + block.slice(block.length - limit) : block)
    size += block.length
  }
  return { kept, size }
}

/**
 * A plain-text excerpt of the session. Compaction summaries are kept first
 * (they stand in for the turns before them), then the newest messages fill
 * the rest of the budget.
 */
export function transcript(messages: readonly SessionV1.WithParts[], limit = CONTEXT_CHARS) {
  const blocks = messages.flatMap((message, index) => {
    const lines = messageLines(message)
    if (lines.length === 0) return []
    const summary = message.info.role === "assistant" && !!message.info.summary
    const who = message.info.role === "user" ? "User" : summary ? "Summary of earlier conversation" : "Assistant"
    return [{ index, summary, text: `${who}:\n${lines.join("\n")}` }]
  })
  const summaries = fit(
    blocks.filter((block) => block.summary).map((block) => block.text),
    Math.min(SUMMARY_CHARS, limit),
  )
  const keptSummaries = new Set(summaries.kept)
  const rest = fit(
    blocks.filter((block) => !block.summary).map((block) => block.text),
    Math.max(limit - summaries.size, Math.floor(limit / 2)),
  )
  const keptRest = new Set(rest.kept)
  return blocks
    .filter((block) => (block.summary ? keptSummaries.has(block.text) : keptRest.has(block.text)))
    .map((block) => block.text)
    .join("\n\n")
}

/** The user content of the side request. Secrets are masked in all of it, including pasted text and tool input. */
export function request(input: { title?: string; messages: readonly SessionV1.WithParts[]; question: string }) {
  const excerpt = transcript(input.messages)
  return SecretRedact.redact(
    [
      ...(input.title && !Session.isDefaultTitle(input.title) ? [`<session_goal>\n${input.title}\n</session_goal>`] : []),
      `<session_excerpt>\n${excerpt || "(no messages yet)"}\n</session_excerpt>`,
      `<side_question>\n${clip(input.question, QUESTION_CHARS)}\n</side_question>`,
    ].join("\n\n"),
  )
}

/** Drops `<think>` blocks some small models print inline. */
export function clean(text: string) {
  return text.replace(/<think>[\s\S]*?(<\/think>\s*|$)/g, "").trim()
}

/** The main model of the session: the latest user message's model. */
export function mainModel(messages: readonly SessionV1.WithParts[]) {
  const user = messages.findLast((message) => message.info.role === "user")?.info
  return user?.role === "user" ? user.model : undefined
}

export class ModelNotFound extends Schema.TaggedErrorClass<ModelNotFound>()("SessionBtwModelNotFound", {
  message: Schema.String,
}) {}

/**
 * Picks the side model: an explicit model (an error if it does not exist),
 * otherwise the cheap small model (config `small_model`) of the main model's
 * provider, otherwise the main model itself (`fallback`).
 */
export const resolveModel = Effect.fn("SessionBtw.resolveModel")(function* (input: {
  explicit?: ModelRef
  main?: ModelRef
  provider: Pick<Provider.Interface, "getModel" | "getSmallModel">
}) {
  const lookup = (ref: ModelRef) =>
    input.provider.getModel(ref.providerID, ref.modelID).pipe(
      Effect.map(Option.some),
      Effect.catch(() => Effect.succeed(Option.none<Provider.Model>())),
    )
  if (input.explicit) {
    const found = yield* lookup(input.explicit)
    if (Option.isNone(found))
      return yield* new ModelNotFound({
        message: `Model ${input.explicit.providerID}/${input.explicit.modelID} was not found for /btw.`,
      })
    return { model: found.value, fallback: false }
  }
  if (!input.main)
    return yield* new ModelNotFound({ message: "No model is available for side questions. Connect a provider first." })
  const small = yield* input.provider.getSmallModel(input.main.providerID)
  if (small) return { model: small, fallback: false }
  const main = yield* lookup(input.main)
  if (Option.isNone(main))
    return yield* new ModelNotFound({ message: `Model ${input.main.providerID}/${input.main.modelID} was not found for /btw.` })
  return { model: main.value, fallback: true }
})

type SpendEntry = { usd: number; time: number }

function spendOf(metadata: Record<string, unknown> | undefined) {
  const value = metadata?.[SPEND_KEY]
  if (typeof value !== "object" || value === null) return { total: 0, recent: [] as SpendEntry[] }
  const total = "total" in value && typeof value.total === "number" && Number.isFinite(value.total) ? value.total : 0
  const recent =
    "recent" in value && Array.isArray(value.recent)
      ? value.recent.filter(
          (item): item is SpendEntry =>
            typeof item === "object" && item !== null && typeof item.usd === "number" && typeof item.time === "number",
        )
      : []
  return { total: Math.max(0, total), recent }
}

/** Total recorded /btw cost of a session (USD). */
export function spentOn(metadata: Record<string, unknown> | undefined) {
  return spendOf(metadata).total
}

/** Metadata with one more /btw cost added. Other keys are kept. */
export function withSpend(metadata: Record<string, unknown> | undefined, usd: number, time: number): Record<string, unknown> {
  const current = spendOf(metadata)
  return {
    ...metadata,
    [SPEND_KEY]: { total: current.total + usd, recent: [...current.recent, { usd, time }].slice(-SPEND_RECENT) },
  }
}

/**
 * The same approval line as the main run (`/cost`, metadata.cost_limit_usd,
 * SENTE_COST_LIMIT_USD): the conversation's recorded cost, earlier /btw costs
 * included, plus this call's conservative estimate.
 */
export function budget(input: {
  session: Pick<Session.Info, "metadata">
  root: Pick<Session.Info, "metadata" | "id">
  rootHistory: { info: { role: string; agent?: string; cost?: number } }[]
  sameRoot: boolean
  model: Provider.Model
  content: string
}) {
  const own = input.session.metadata?.[SessionEscalation.COST_LIMIT_METADATA_KEY]
  const limit =
    own === undefined
      ? SessionEscalation.sessionCostLimit(input.root.metadata)
      : SessionEscalation.sessionCostLimit(input.session.metadata)
  const spent =
    SessionEscalation.userFacingCost(input.rootHistory) +
    spentOn(input.root.metadata) +
    (input.sameRoot ? 0 : spentOn(input.session.metadata))
  const estimate = SessionEscalation.requestEstimate(
    input.model,
    MAX_OUTPUT_TOKENS,
    SessionEscalation.requestTokens(INSTRUCTIONS + input.content),
  )
  return { limit, spent, estimate, needsApproval: SessionEscalation.needsCostApproval(limit, spent, estimate) }
}

function price(model: Provider.Model, input: number, output: number) {
  const cost = model.cost
  const value = (input * (cost?.input ?? 0) + output * (cost?.output ?? 0)) / 1_000_000
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Runs the side request. Provider failures are returned in `error` together
 * with any text that already arrived. Whatever was spent is passed to
 * `record`, also when the request is interrupted (closing the panel aborts the
 * HTTP request): then the reported usage is used if any arrived, otherwise an
 * estimate from the request size and the text received so far.
 */
export const ask = Effect.fn("SessionBtw.ask")(function* (input: {
  session: Pick<Session.Info, "id" | "title">
  messages: readonly SessionV1.WithParts[]
  question: string
  model: Provider.Model
  fallback?: boolean
  stream: LLM.Interface["stream"]
  record: (usd: number) => Effect.Effect<void>
}) {
  // A throwaway session id: the side call must not share request state
  // (prompt cache key, run state) with the main session. The cost limit is
  // checked by the caller (`budget`) against the real session.
  const sessionID = SessionID.descending()
  const base = { providerID: input.model.providerID, modelID: input.model.id }
  const content = request({ title: input.session.title, messages: input.messages, question: input.question })
  const events: LLMEvent[] = []
  const usage = () =>
    events
      .filter(LLMEvent.is.stepFinish)
      .map((event) => Session.getUsage({ model: input.model, usage: event.usage ?? new Usage({}), metadata: event.providerMetadata }))
  const text = () => events.filter(LLMEvent.is.textDelta).map((event) => event.text).join("")
  const result = yield* input
    .stream({
      agent: AGENT,
      user: {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: AGENT_NAME,
        model: base,
      },
      system: [],
      small: true,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      tools: {},
      toolChoice: "none",
      model: input.model,
      sessionID,
      retries: 1,
      messages: [{ role: "user", content }],
    })
    .pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.onInterrupt(() => {
        const known = usage()
        const usd =
          known.length > 0
            ? known.reduce((sum, item) => sum + item.cost, 0)
            : price(input.model, SessionEscalation.requestTokens(INSTRUCTIONS + content) ?? 0, Math.ceil(text().length / 3))
        return usd > 0 ? input.record(usd) : Effect.void
      }),
      Effect.exit,
    )
  const used = usage()
  const cost = used.reduce((sum, item) => sum + item.cost, 0)
  if (cost > 0) yield* input.record(cost)
  const message = Exit.isFailure(result)
    ? errorText(result)
    : events.find(LLMEvent.is.providerError)?.message
  return {
    ...base,
    text: clean(text()),
    cost,
    tokens: {
      input: used.reduce((sum, item) => sum + item.tokens.input + item.tokens.cache.read + item.tokens.cache.write, 0),
      output: used.reduce((sum, item) => sum + item.tokens.output + item.tokens.reasoning, 0),
    },
    ...(input.fallback ? { fallback: true } : {}),
    ...(message !== undefined ? { error: message } : {}),
  } satisfies Answer
})

function errorText(exit: Exit.Failure<unknown, unknown>) {
  const value = Cause.squash(exit.cause)
  return value instanceof Error ? value.message : String(value)
}

export * as SessionBtw from "./btw"

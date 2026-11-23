import type { SessionV1 } from "@sente-ai/core/v1/session"
import { LLMEvent, Usage } from "@sente-ai/llm"
import { Effect, Schema, Stream } from "effect"
import type { Agent } from "@/agent/agent"
import type { Provider } from "@/provider/provider"
import type { LLM } from "./llm"
import { MessageID, SessionID } from "./schema"
import { Session } from "./session"

// `/btw <question>`: a quick side question about the running session.
// The answer comes from a separate one-shot model request built from a text
// excerpt of the session. Nothing is written to the session, the main run is
// never awaited or interrupted, and the request carries no tools.

/** How many of the latest messages the excerpt is built from. */
export const MESSAGE_LIMIT = 40
const CONTEXT_CHARS = 16_000
const PART_CHARS = 1_200
const QUESTION_CHARS = 4_000

export const AGENT_NAME = "btw"

const INSTRUCTIONS = [
  "You answer a quick side question (/btw) about a coding session that is still running.",
  "The session excerpt below is read-only context. You cannot call tools, read files, run commands or change anything; do not offer to.",
  "Answer directly and concisely in markdown, from the excerpt and general knowledge only.",
  "If the excerpt does not contain what is needed, say so in one sentence instead of guessing.",
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

export const Answer = Schema.Struct({
  text: Schema.String,
  providerID: Schema.String,
  modelID: Schema.String,
  cost: Schema.Finite,
  tokens: Schema.Struct({ input: Schema.Finite, output: Schema.Finite }),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "SessionBtwAnswer" })
export type Answer = Schema.Schema.Type<typeof Answer>

function clip(text: string, limit: number) {
  const value = text.trim()
  return value.length > limit ? value.slice(0, limit) + "…" : value
}

function toolLine(part: SessionV1.ToolPart) {
  const input = clip(JSON.stringify(part.state.input ?? {}), 200)
  if (part.state.status === "error") return `[tool ${part.tool} failed: ${clip(part.state.error, 200)}] ${input}`
  if (part.state.status === "completed") return `[tool ${part.tool} done: ${clip(part.state.title, 120)}] ${input}`
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

/**
 * A plain-text excerpt of the session, newest messages kept when it is too long.
 * Summaries written by compaction are kept because they stand in for older turns.
 */
export function transcript(messages: readonly SessionV1.WithParts[], limit = CONTEXT_CHARS) {
  const blocks = messages.flatMap((message) => {
    const lines = messageLines(message)
    if (lines.length === 0) return []
    const who =
      message.info.role === "user" ? "User" : message.info.summary ? "Summary of earlier conversation" : "Assistant"
    return [`${who}:\n${lines.join("\n")}`]
  })
  const kept: string[] = []
  let size = 0
  for (const block of blocks.toReversed()) {
    if (size + block.length > limit && kept.length > 0) break
    kept.unshift(block.length > limit ? "…" + block.slice(block.length - limit) : block)
    size += block.length
  }
  return kept.join("\n\n")
}

export function request(input: { title?: string; messages: readonly SessionV1.WithParts[]; question: string }) {
  const excerpt = transcript(input.messages)
  return [
    ...(input.title && !Session.isDefaultTitle(input.title) ? [`<session_goal>\n${input.title}\n</session_goal>`] : []),
    `<session_excerpt>\n${excerpt || "(no messages yet)"}\n</session_excerpt>`,
    `<side_question>\n${clip(input.question, QUESTION_CHARS)}\n</side_question>`,
  ].join("\n\n")
}

/** Drops `<think>` blocks some small models print inline. */
export function clean(text: string) {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim()
}

/** The main model of the session: the latest user message's model. */
export function mainModel(messages: readonly SessionV1.WithParts[]) {
  const user = messages.findLast((message) => message.info.role === "user")?.info
  return user?.role === "user" ? user.model : undefined
}

/**
 * Runs the side request. Failures are returned in `error` (with an empty
 * answer) instead of failing, so the TUI can show the provider's message.
 */
export const ask = Effect.fn("SessionBtw.ask")(function* (input: {
  session: Pick<Session.Info, "id" | "title">
  messages: readonly SessionV1.WithParts[]
  question: string
  model: Provider.Model
  stream: LLM.Interface["stream"]
}) {
  // A throwaway session id: the side call must not share request state
  // (prompt cache key, cost guard, run state) with the main session.
  const sessionID = SessionID.descending()
  const base = { providerID: input.model.providerID, modelID: input.model.id }
  const events = yield* input
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
      tools: {},
      toolChoice: "none",
      model: input.model,
      sessionID,
      retries: 1,
      messages: [
        {
          role: "user",
          content: request({ title: input.session.title, messages: input.messages, question: input.question }),
        },
      ],
    })
    .pipe(Stream.runCollect, Effect.result)
  if (events._tag === "Failure") {
    const error = events.failure
    return {
      ...base,
      text: "",
      cost: 0,
      tokens: { input: 0, output: 0 },
      error: error instanceof Error ? error.message : String(error),
    } satisfies Answer
  }
  const list = Array.from(events.success)
  const usage = list.filter(LLMEvent.is.stepFinish).map((event) =>
    Session.getUsage({ model: input.model, usage: event.usage ?? new Usage({}), metadata: event.providerMetadata }),
  )
  const failure = list.find(LLMEvent.is.providerError)
  return {
    ...base,
    text: clean(list.filter(LLMEvent.is.textDelta).map((event) => event.text).join("")),
    cost: usage.reduce((sum, item) => sum + item.cost, 0),
    tokens: {
      input: usage.reduce((sum, item) => sum + item.tokens.input + item.tokens.cache.read + item.tokens.cache.write, 0),
      output: usage.reduce((sum, item) => sum + item.tokens.output + item.tokens.reasoning, 0),
    },
    ...(failure ? { error: failure.message } : {}),
  } satisfies Answer
})

export * as SessionBtw from "./btw"

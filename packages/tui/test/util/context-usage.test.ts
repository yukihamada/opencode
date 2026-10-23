import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, Part, UserMessage } from "@sente-ai/sdk/v2"
import { contextUsage } from "../../src/util/context-usage"

function user(id: string): UserMessage {
  return { id, sessionID: "session", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "local", modelID: "chat" } }
}

function assistant(id: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id, sessionID: "session", role: "assistant", parentID: "user", time: { created: 2 },
    providerID: "local", modelID: "chat", agent: "build", mode: "build", path: { cwd: "/", root: "/" },
    cost: 0, tokens: { input: 80000, output: 1000, reasoning: 0, cache: { read: 10000, write: 0 } },
    finish: "stop", ...overrides,
  }
}

function fixture(tail?: string) {
  const messages: Message[] = [user("old"), assistant("before"), user("keep"), assistant("tail"), user("compact"), assistant("summary", { summary: true, parentID: "compact", modelID: "summarizer" })]
  const parts: Record<string, Part[]> = Object.fromEntries(messages.map((message) => [message.id, [{
    id: `part-${message.id}`, sessionID: "session", messageID: message.id, type: "text", text: "x".repeat(message.id === "old" ? 400000 : 400),
  }]]))
  parts.compact = [{ id: "marker", sessionID: "session", messageID: "compact", type: "compaction", auto: false, ...(tail ? { tail_start_id: tail } : {}) }]
  return { messages, parts, usage: () => contextUsage(messages, (id) => parts[id]) }
}

describe("context usage after compaction", () => {
  test("replaces summary request usage with the surviving context immediately", () => {
    const f = fixture()
    expect(contextUsage(f.messages.slice(0, 4), (id) => f.parts[id])?.tokens).toBe(91000)
    expect(f.usage()).toEqual({ tokens: 106, estimated: true, providerID: "local", modelID: "chat" })
  })

  test("counts retained tail, not its historical input tokens or the discarded head", () => {
    const f = fixture("keep")
    expect(f.usage()?.tokens).toBe(306)
    f.parts.old = [{ id: "old-part", sessionID: "session", messageID: "old", type: "text", text: "ignored" }]
    expect(f.usage()?.tokens).toBe(306)
  })

  test("includes new user input and switches back to measured usage on response", () => {
    const f = fixture()
    f.messages.push(user("next"))
    f.parts.next = [{ id: "next-part", sessionID: "session", messageID: "next", type: "text", text: "x".repeat(800) }]
    expect(f.usage()?.tokens).toBe(306)
    f.messages.push(assistant("after", { tokens: { input: 3000, output: 200, reasoning: 0, cache: { read: 1000, write: 0 } } }))
    expect(f.usage()).toMatchObject({ tokens: 4200, estimated: false })
  })

  test("in-progress or failed summaries do not reset the previous usage", () => {
    const f = fixture()
    const summary = f.messages.at(-1) as AssistantMessage
    summary.finish = undefined
    expect(f.usage()?.tokens).toBe(91000)
    summary.finish = "error"
    summary.error = { name: "UnknownError", data: { message: "failed" } }
    expect(f.usage()).toMatchObject({ tokens: 91000, estimated: false })
  })

  test("missing retained history or summary parts are unknown, not stale large usage", () => {
    expect(fixture("not-loaded").usage()).toBeUndefined()
    const f = fixture()
    delete f.parts.summary
    expect(f.usage()).toBeUndefined()
    f.parts.summary = []
    expect(f.usage()).toBeUndefined()
  })

  test("uses input/cache usage even for tool-only responses with zero output", () => {
    const f = fixture()
    f.messages.push(assistant("tool-only", { tokens: { input: 1200, output: 0, reasoning: 0, cache: { read: 800, write: 0 } } }))
    expect(f.usage()).toMatchObject({ tokens: 2000, estimated: false })
  })

  test("counts retained tool results and honors pruned output", () => {
    const f = fixture("keep")
    const tool = { id: "tool", sessionID: "session", messageID: "tail", type: "tool", callID: "call", tool: "read", state: { status: "completed", input: {}, output: "x".repeat(4000), title: "read", metadata: {}, time: { start: 1, end: 2, compacted: undefined as number | undefined } } } satisfies Part
    f.parts.tail = [tool]
    expect(f.usage()?.tokens).toBe(1207)
    tool.state.time.compacted = 3
    expect(f.usage()?.tokens).toBe(215)
  })

  test("a repeated compaction discards the previous estimate and uses the new summary", () => {
    const f = fixture("keep")
    f.messages.push(user("compact2"), assistant("summary2", { parentID: "compact2", summary: true }))
    f.parts.compact2 = [{ id: "marker2", sessionID: "session", messageID: "compact2", type: "compaction", auto: false }]
    f.parts.summary2 = [{ id: "part2", sessionID: "session", messageID: "summary2", type: "text", text: "x".repeat(200) }]
    expect(f.usage()?.tokens).toBe(56)
  })
})

import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message } from "@sente-ai/sdk/v2"
import { terminalTaskState, terminalTaskTitle } from "../../src/util/terminal-title"

const answer: AssistantMessage = {
  id: "msg_a",
  sessionID: "ses_a",
  role: "assistant",
  parentID: "msg_u",
  time: { created: 1, completed: 2 },
  finish: "stop",
  modelID: "test",
  providerID: "test",
  mode: "build",
  agent: "build",
  path: { cwd: "/", root: "/" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

describe("terminal task status", () => {
  test("restored idle sessions distinguish completion from abandoned work", () => {
    expect(terminalTaskState({ messages: [answer] })).toBe("done")
    expect(terminalTaskState({ messages: [{ ...answer, time: { created: 1 } }] })).toBe("stopped")
    expect(terminalTaskState({ messages: [{ ...answer, finish: "tool-calls" }] })).toBe("stopped")
    expect(terminalTaskState({ messages: [{ ...answer, finish: undefined }] })).toBe("stopped")
    expect(
      terminalTaskState({
        messages: [answer],
        todos: [{ content: "unfinished", status: "in_progress", priority: "high" }],
      }),
    ).toBe("stopped")
  })

  test("a new user turn never inherits the previous done badge", () => {
    const user: Message = {
      id: "msg_u2",
      sessionID: "ses_a",
      role: "user",
      time: { created: 3 },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    }
    expect(terminalTaskState({ messages: [answer, user] })).toBe("stopped")
    expect(terminalTaskState({ messages: [answer, user], status: { type: "busy" } })).toBe("working")
  })

  test("approval and question gates take precedence over busy status", () => {
    expect(terminalTaskState({ status: { type: "busy" }, permission: true })).toBe("permission")
    expect(terminalTaskState({ status: { type: "busy" }, question: true })).toBe("question")
    expect(terminalTaskState({ status: { type: "retry", attempt: 1, next: 123, message: "retry" } })).toBe("retry")
  })

  test("abort and provider errors are not completed responses", () => {
    expect(
      terminalTaskState({
        messages: [{ ...answer, error: { name: "MessageAbortedError", data: { message: "aborted" } } }],
      }),
    ).toBe("stopped")
    expect(
      terminalTaskState({ messages: [{ ...answer, error: { name: "UnknownError", data: { message: "failed" } } }] }),
    ).toBe("error")
    expect(terminalTaskState({ messages: [answer], error: "UnknownError" })).toBe("error")
    expect(terminalTaskState({ messages: [answer], error: "MessageAbortedError" })).toBe("stopped")
    expect(
      terminalTaskState({
        messages: [{ ...answer, error: { name: "UnknownError", data: { message: "old" } } }],
        status: { type: "busy" },
      }),
    ).toBe("working")
  })

  test("empty and unloaded sessions are not done", () => {
    expect(terminalTaskState({})).toBe("loading")
    expect(terminalTaskState({ messages: [] })).toBe("ready")
  })

  test("localized badges stay at the start even with default or long titles", () => {
    expect(terminalTaskTitle("done", "修正", "ja-JP")).toBe("✅ 完了 | 修正")
    expect(terminalTaskTitle("stopped", "Fix", "en-US")).toBe("⏸ Stopped | Fix")
    expect(terminalTaskTitle("working", "New session - 2026-10-06T00:00:00.000Z", "en")).toBe("● Working | Sente")
    expect(terminalTaskTitle("question", "😀".repeat(50), "ja")).toBe(`⏳ 回答待ち | ${"😀".repeat(39)}…`)
    expect(terminalTaskTitle("done", "\u001b[31mFix\u001b[0m\u0007\n", "en")).toBe("✅ Done | Fix")
  })
})

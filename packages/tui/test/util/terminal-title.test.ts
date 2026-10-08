import { describe, expect, test } from "bun:test"
import type { Message, Todo } from "@sente-ai/sdk/v2"
import {
  terminalIsRunning,
  terminalHandBackScript,
  terminalNeedsAttention,
  terminalShouldRing,
  terminalTaskProgress,
  terminalTaskState,
  terminalTaskTitle,
} from "../../src/util/terminal-title"

const MIN = 60_000
const user = (created: number) => ({ role: "user", time: { created } }) as Message
const reply = (created: number, completed?: number, extra: Record<string, unknown> = {}) =>
  ({ role: "assistant", time: { created, completed }, finish: completed ? "stop" : undefined, ...extra }) as Message
const todo = (status: string) => ({ content: "x", status, priority: "medium" }) as Todo

describe("util.terminal-title", () => {
  describe("terminalTaskState", () => {
    test("approval and question win over a busy session", () => {
      expect(terminalTaskState({ status: { type: "busy" }, permission: true })).toBe("permission")
      expect(terminalTaskState({ status: { type: "busy" }, question: true })).toBe("question")
    })

    test("busy and retry are running states", () => {
      expect(terminalTaskState({ status: { type: "busy" } })).toBe("working")
      expect(terminalTaskState({ status: { type: "retry", attempt: 1, message: "x", next: 1 } })).toBe("retry")
    })

    test("a finished reply with no open todos is done", () => {
      expect(terminalTaskState({ messages: [user(0), reply(1, 2)], todos: [todo("completed")] })).toBe("done")
    })

    test("an unfinished reply or open todos is reported as stopped early, not done", () => {
      expect(terminalTaskState({ messages: [user(0), reply(1)] })).toBe("incomplete")
      expect(terminalTaskState({ messages: [user(0), reply(1, 2, { finish: "tool-calls" })] })).toBe("incomplete")
      expect(terminalTaskState({ messages: [user(0), reply(1, 2)], todos: [todo("pending")] })).toBe("incomplete")
    })

    test("a user abort is stopped, other failures are errors", () => {
      expect(terminalTaskState({ error: "MessageAbortedError" })).toBe("stopped")
      expect(terminalTaskState({ error: "APIError" })).toBe("error")
      expect(terminalTaskState({ messages: [user(0), reply(1, 2, { error: { name: "APIError" } })] })).toBe("error")
    })

    test("no messages yet", () => {
      expect(terminalTaskState({})).toBe("loading")
      expect(terminalTaskState({ messages: [] })).toBe("ready")
    })
  })

  test("only hand-back states ask for a bell, and an abort by the user does not", () => {
    expect(["done", "permission", "question", "error", "incomplete"].every((s) => terminalNeedsAttention(s as never))).toBe(true)
    expect(["working", "retry", "stopped", "ready", "loading"].some((s) => terminalNeedsAttention(s as never))).toBe(false)
    expect(terminalIsRunning("working")).toBe(true)
    expect(terminalIsRunning("retry")).toBe(true)
    expect(terminalIsRunning("done")).toBe(false)
  })

  test("stays quiet while the user is looking at the tab, rings when away or when focus is unknown", () => {
    expect(terminalShouldRing(true, {})).toBe(false)
    expect(terminalShouldRing(false, {})).toBe(true)
    expect(terminalShouldRing(undefined, {})).toBe(true)
    expect(terminalShouldRing(false, { TE_NO_BELL: "1" })).toBe(false)
  })

  describe("terminalHandBackScript", () => {
    test("the banner tells done from approval and names the session", () => {
      const done = terminalHandBackScript({ state: "done", title: "請求書の整理", pid: 42, appleTerminal: false, locale: "ja" })
      expect(done).toBe('display notification "請求書の整理" with title "✅ 完了 — Sente"\nreturn "notified"')
      const ask = terminalHandBackScript({ state: "permission", title: "請求書の整理", pid: 42, appleTerminal: false, locale: "ja" })
      expect(ask).toContain('with title "❓ 確認待ち — Sente"')
    })

    test("Terminal.app first checks whether this tab is the one in view", () => {
      const script = terminalHandBackScript({ state: "done", title: "x", pid: 42.9, appleTerminal: true, locale: "ja" })
      expect(script).toContain("ps -o tty= -p 42 ")
      expect(script.indexOf('return "focused"')).toBeLessThan(script.indexOf("display notification"))
    })

    test("a session title cannot break out of the script", () => {
      const script = terminalHandBackScript({ state: "done", title: 'a" & b & "\\', pid: 1, appleTerminal: false, locale: "en-US" })
      expect(script).toContain('display notification "a\\" & b & \\"\\\\" with title')
    })
  })

  describe("terminalTaskProgress", () => {
    test("estimates the remaining time from finished todos", () => {
      const text = terminalTaskProgress(
        { now: 6 * MIN, messages: [user(0)], todos: [todo("completed"), todo("completed"), todo("completed"), todo("in_progress"), todo("pending"), todo("pending"), todo("pending"), todo("cancelled")] },
        "ja",
      )
      expect(text).toBe("3/7 · 残り約8分 · 経過6分")
    })

    test("shows only the count until one todo is finished", () => {
      expect(terminalTaskProgress({ now: 2 * MIN, messages: [user(0)], todos: [todo("in_progress"), todo("pending")] }, "ja")).toBe(
        "0/2 · 経過2分",
      )
    })

    test("falls back to the usual length of earlier turns in the session", () => {
      const messages = [user(0), reply(1, 2 * MIN), user(10 * MIN), reply(10 * MIN, 14 * MIN), user(20 * MIN), reply(20 * MIN, 26 * MIN), user(30 * MIN)]
      expect(terminalTaskProgress({ now: 31 * MIN, messages }, "ja")).toBe("目安4分 · 経過1分")
      // once the usual length has passed the guide would only mislead
      expect(terminalTaskProgress({ now: 35 * MIN, messages }, "ja")).toBe("経過5分")
    })

    test("needs two earlier turns before it offers a guide", () => {
      expect(terminalTaskProgress({ now: 11 * MIN, messages: [user(0), reply(1, 2 * MIN), user(10 * MIN)] }, "ja")).toBe("経過1分")
    })

    test("stays quiet for the first seconds in the title and counts seconds beside the spinner", () => {
      expect(terminalTaskProgress({ now: 4_000, messages: [user(0)] }, "ja")).toBeUndefined()
      expect(terminalTaskProgress({ now: 25_000, messages: [user(0)] }, "ja")).toBe("経過20秒")
      expect(terminalTaskProgress({ now: 83_000, messages: [user(0)], exact: true }, "ja")).toBe("経過1分23秒")
      expect(terminalTaskProgress({ now: 4_000, messages: [user(0)], exact: true }, "ja")).toBe("経過4秒")
    })

    test("english wording and long tasks", () => {
      expect(terminalTaskProgress({ now: 90 * MIN, messages: [user(0)], todos: [todo("completed"), todo("pending")] }, "en-US")).toBe(
        "1/2 · ~1h 30m left · 1h 30m elapsed",
      )
    })

    test("nothing to show without a user message", () => {
      expect(terminalTaskProgress({ now: 1, messages: [] }, "ja")).toBeUndefined()
      expect(terminalTaskProgress({ now: 1 }, "ja")).toBeUndefined()
    })
  })

  describe("terminalTaskTitle", () => {
    test("done and approval are told apart and both carry the bell mark", () => {
      expect(terminalTaskTitle("done", "請求書の整理", undefined, "ja")).toBe("🔔✅ 完了 | 請求書の整理")
      expect(terminalTaskTitle("permission", "請求書の整理", undefined, "ja")).toBe("🔔❓ 確認待ち | 請求書の整理")
      expect(terminalTaskTitle("question", "請求書の整理", undefined, "ja")).toBe("🔔❓ 回答待ち | 請求書の整理")
    })

    test("a running task shows its progress and no bell mark", () => {
      expect(terminalTaskTitle("working", "請求書の整理", "3/7 · 残り約8分 · 経過6分", "ja")).toBe(
        "⏳ 実行中 3/7 · 残り約8分 · 経過6分 | 請求書の整理",
      )
    })

    test("puts the state last for terminals that keep only the end of a tab title", () => {
      expect(terminalTaskTitle("done", "請求書の整理", undefined, "ja", true)).toBe("請求書の整理 | 完了 🔔✅")
      expect(terminalTaskTitle("permission", "請求書の整理", undefined, "ja", true)).toBe("請求書の整理 | 確認待ち 🔔❓")
      expect(terminalTaskTitle("working", "請求書の整理", "3/7 · 残り約8分", "ja", true)).toBe(
        "請求書の整理 | 3/7 · 残り約8分 実行中 ⏳",
      )
    })

    test("cleans control characters and long or default titles", () => {
      expect(terminalTaskTitle("ready", undefined, undefined, "en-US")).toBe("○ Ready | Sente")
      expect(terminalTaskTitle("done", "a\u0007b\u001b[31mc", undefined, "en-US")).toBe("🔔✅ Done | a bc")
      expect(terminalTaskTitle("done", "あ".repeat(50), undefined, "ja")).toBe(`🔔✅ 完了 | ${"あ".repeat(39)}…`)
    })
  })
})

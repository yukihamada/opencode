import { describe, expect, test } from "bun:test"
import { SessionTodoFollowup } from "../../src/session/todo-followup"

const todo = (content: string, status: string) => ({ content, status, priority: "medium" })

describe("todo follow-up", () => {
  test("finds todos that still need work", () => {
    const open = SessionTodoFollowup.unfinished([
      todo("a", "pending"),
      todo("b", "in_progress"),
      todo("c", "completed"),
      todo("d", "cancelled"),
    ])
    expect(open.map((item) => item.content)).toEqual(["a", "b"])
  })

  test("is bounded and can be disabled", () => {
    expect(SessionTodoFollowup.canFollowup(0, {})).toBe(true)
    expect(SessionTodoFollowup.canFollowup(1, {})).toBe(true)
    expect(SessionTodoFollowup.canFollowup(SessionTodoFollowup.MAX_TODO_FOLLOWUPS, {})).toBe(false)
    expect(SessionTodoFollowup.canFollowup(0, { SENTE_TODO_FOLLOWUP: "0" })).toBe(false)
    expect(SessionTodoFollowup.canFollowup(0, { SENTE_TODO_FOLLOWUP: "off" })).toBe(false)
  })

  test("stays off in a non-interactive one-shot run", () => {
    expect(SessionTodoFollowup.canFollowup(0, { SENTE_NONINTERACTIVE: "1" })).toBe(false)
    expect(SessionTodoFollowup.canFollowup(0, { SENTE_NONINTERACTIVE: "1", SENTE_TODO_FOLLOWUP: "1" })).toBe(false)
  })

  test("prompt lists the open items and asks to finish or close them", () => {
    const prompt = SessionTodoFollowup.followupPrompt([todo("ログイン画面", "in_progress")], "ja")
    expect(prompt).toContain("[in_progress] ログイン画面")
    expect(prompt).toContain("todowrite")
    expect(prompt).toContain("completed")
  })

  test("note reports the count and attempt", () => {
    expect(SessionTodoFollowup.note(1, 2, "ja")).toContain("2件")
    expect(SessionTodoFollowup.note(1, 2, "en")).toContain("2 todo")
  })
})

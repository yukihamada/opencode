import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@sente-ai/core/v1/session"
import { SessionTitle } from "../../src/session/title"

const message = (parts: unknown[]) => ({ info: { role: "user" }, parts }) as unknown as SessionV1.WithParts

describe("session title anchored to the first goal", () => {
  test("reads user text and subtask prompts, skipping synthetic parts", () => {
    const text = SessionTitle.messageText(
      message([
        { type: "text", text: "ログイン画面を作る" },
        { type: "text", text: "<system-reminder>", synthetic: true },
        { type: "subtask", prompt: "既存画面を調べる" },
        { type: "file", url: "file:///a.png" },
      ]),
    )
    expect(text).toBe("ログイン画面を作る\n既存画面を調べる")
  })

  test("request puts the first request as the goal and later messages as follow-ups", () => {
    const content = SessionTitle.request({
      first: "ログイン画面を作る",
      later: ["ボタンを青にして"],
      current: "ログイン画面の作成",
    })
    expect(content).toContain("<first_request>\nログイン画面を作る\n</first_request>")
    expect(content).toContain("<later_messages>\n- ボタンを青にして\n</later_messages>")
    expect(content).toContain("<current_title>ログイン画面の作成</current_title>")
    expect(content).toContain("never title the session after a later message")
  })

  test("first turn has no follow-ups or current title", () => {
    const content = SessionTitle.request({ first: "ログイン画面を作る", later: [] })
    expect(content).not.toContain("<later_messages>")
    expect(content).not.toContain("<current_title>")
    expect(content).not.toContain("output it unchanged")
  })

  test("keeps only the latest follow-ups and clips long text", () => {
    const later = Array.from({ length: 10 }, (_, i) => `msg${i}`)
    const content = SessionTitle.request({ first: "x".repeat(5000), later })
    expect(content).not.toContain("msg3")
    expect(content).toContain("msg4")
    expect(content).toContain("msg9")
    expect(content.length).toBeLessThan(2500)
  })

  test("detects a title that just echoes the latest follow-up", () => {
    const first = "ログイン画面を作る"
    expect(SessionTitle.echoesLatest({ candidate: "ボタンを青にして", first, latest: "ボタンを青にして!" })).toBe(true)
    expect(SessionTitle.echoesLatest({ candidate: "ログイン画面の作成", first, latest: "ボタンを青にして" })).toBe(false)
    expect(SessionTitle.echoesLatest({ candidate: "ログイン画面", first, latest: "ログイン画面のボタンを青に" })).toBe(false)
    expect(SessionTitle.echoesLatest({ candidate: "OK", first, latest: "OK" })).toBe(false)
  })
})

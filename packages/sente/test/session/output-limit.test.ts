import { describe, expect, test } from "bun:test"
import { SessionOutputLimit } from "../../src/session/output-limit"

describe("SessionOutputLimit", () => {
  test("allows a bounded number of continuations", () => {
    expect(SessionOutputLimit.canContinue(0)).toBe(true)
    expect(SessionOutputLimit.canContinue(SessionOutputLimit.MAX_OUTPUT_CONTINUES - 1)).toBe(true)
    expect(SessionOutputLimit.canContinue(SessionOutputLimit.MAX_OUTPUT_CONTINUES)).toBe(false)
    expect(SessionOutputLimit.canContinue(-1)).toBe(false)
    expect(SessionOutputLimit.canContinue(1.5)).toBe(false)
  })

  test("SENTE_AUTO_CONTINUE=0 turns automatic continuation off", () => {
    expect(SessionOutputLimit.canContinue(0, {})).toBe(true)
    expect(SessionOutputLimit.canContinue(0, { SENTE_AUTO_CONTINUE: "0" })).toBe(false)
    expect(SessionOutputLimit.canContinue(0, { SENTE_AUTO_CONTINUE: "off" })).toBe(false)
    expect(SessionOutputLimit.canContinue(0, { SENTE_AUTO_CONTINUE: "yes" })).toBe(true)
  })

  test("the note says which attempt this is, in the user's language", () => {
    expect(SessionOutputLimit.continueNote(2, "ja")).toBe("出力上限に達したため自動で続きを生成します（2/3回目）")
    expect(SessionOutputLimit.continueNote(2, "en")).toBe("Output limit reached; continuing automatically (2/3)")
  })

  test("the continuation prompt asks to resume without restarting", () => {
    expect(SessionOutputLimit.continuePrompt("ja")).toContain("続きから再開")
    expect(SessionOutputLimit.continuePrompt("en")).toContain("Resume from exactly where it stopped")
  })
})

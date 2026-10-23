import { describe, expect, test } from "bun:test"
import {
  claudeUsageLabels,
  codexUsageLabels,
  codexUsageReasonLabel,
  formatCodexUsageWindow,
  formatCodexWindowDuration,
} from "../../src/util/codex-usage"

describe("codex-usage", () => {
  test("reports percent remaining and reset time without inventing token counts", () => {
    const formatted = formatCodexUsageWindow(
      { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_900_000_000 },
      "en",
    )
    expect(formatted.remaining).toBe(58)
    expect(formatted.reset).toBeString()
    expect(formatted).not.toHaveProperty("tokens")
  })

  test("reset includes the date so weekly windows are unambiguous", () => {
    const formatted = formatCodexUsageWindow({ usedPercent: 10, resetsAt: 1_900_000_000 }, "en")
    expect(formatted.reset).toContain("2030")
    const ja = formatCodexUsageWindow({ usedPercent: 10, resetsAt: 1_900_000_000 }, "ja")
    expect(ja.reset).toContain("2030")
  })

  test("clamps remaining percent at zero when the window is exhausted", () => {
    expect(formatCodexUsageWindow({ usedPercent: 120 }, "en").remaining).toBe(0)
  })

  test("clamps remaining percent at 100 and treats non-finite values as zero", () => {
    expect(formatCodexUsageWindow({ usedPercent: -5 }, "en").remaining).toBe(100)
    expect(formatCodexUsageWindow({ usedPercent: "NaN" }, "en").remaining).toBe(100)
    expect(formatCodexUsageWindow({ usedPercent: "Infinity" }, "en").remaining).toBe(100)
    expect(formatCodexUsageWindow({ usedPercent: 10, resetsAt: "NaN" }, "en").reset).toBeUndefined()
    expect(formatCodexUsageWindow({ usedPercent: 10, windowDurationMins: "Infinity" }, "en").duration).toBeUndefined()
  })

  test("omits reset and duration when the backend did not send them", () => {
    const formatted = formatCodexUsageWindow({ usedPercent: 10 }, "en")
    expect(formatted.reset).toBeUndefined()
    expect(formatted.duration).toBeUndefined()
  })

  test("distinguishes windows by localized duration labels", () => {
    expect(formatCodexWindowDuration(300, "en")).toBe("5 hr")
    expect(formatCodexWindowDuration(10080, "en")).toBe("1 wk")
    expect(formatCodexWindowDuration(2880, "en")).toBe("2 days")
    expect(formatCodexWindowDuration(90, "en")).toBe("90 min")
    expect(formatCodexWindowDuration(300, "ja")).toContain("5")
    expect(formatCodexWindowDuration(300, "ja")).toContain("時間")
    expect(formatCodexWindowDuration(10080, "ja")).toContain("週間")
    expect(formatCodexWindowDuration(2880, "ja")).toContain("日")
  })

  test("exposes window duration through the formatter", () => {
    expect(formatCodexUsageWindow({ usedPercent: 10, windowDurationMins: 300 }, "en").duration).toBe("5 hr")
    expect(formatCodexUsageWindow({ usedPercent: 10, windowDurationMins: 10080 }, "ja").duration).toContain("週間")
  })

  test("provides Japanese and English labels including an unavailable state", () => {
    expect(codexUsageLabels("ja").title).toBe("Codex サブスク残量")
    expect(codexUsageLabels("en").title).toBe("Codex subscription quota")
    expect(codexUsageLabels("ja").unavailable).toContain("取得できません")
    expect(codexUsageLabels("en").unavailable).toContain("unavailable")
    expect(codexUsageLabels("ja").signinRequired).toContain("ブラウザログイン")
    expect(codexUsageLabels("en").signinRequired).toContain("browser sign-in")
  })

  test("explains missing CLI and missing login instead of hiding them", () => {
    expect(codexUsageReasonLabel("cli_missing", "en")).toContain("not found")
    expect(codexUsageReasonLabel("cli_missing", "en")).toContain("npm i -g @openai/codex")
    expect(codexUsageReasonLabel("cli_missing", "ja")).toContain("見つかりません")
    expect(codexUsageReasonLabel("not_authenticated", "en")).toContain("codex login")
    expect(codexUsageReasonLabel("not_authenticated", "ja")).toContain("codex login")
    expect(codexUsageReasonLabel("unavailable", "en")).toContain("unavailable")
    expect(codexUsageReasonLabel(undefined, "en")).toContain("unavailable")
  })

  test("claude labels stay honest: no automated quota, points at official /usage", () => {
    const en = claudeUsageLabels("en")
    const ja = claudeUsageLabels("ja")
    expect(en.title).toBe("Claude subscription quota")
    expect(ja.title).toBe("Claude サブスク残量")
    expect(en.automated).toContain("not supported")
    expect(en.automated).toContain("/usage")
    expect(ja.automated).toContain("未対応")
    expect(ja.automated).toContain("/usage")
    expect(en.open).toContain("/usage")
    expect(ja.open).toContain("/usage")
    expect(en.hint).toContain("/connect")
    expect(en.hint).toContain("/usage")
    expect(ja.hint).toContain("/connect")
    expect(ja.hint).toContain("/usage")
    expect(en.missing).toContain("not found")
    expect(ja.missing).toContain("見つかりません")
    expect(en.failed("boom")).toContain("boom")
    expect(en.exited(3)).toContain("3")
    expect(ja.exited(3)).toContain("3")
  })
})

import { describe, expect, test } from "bun:test"
import {
  describeMode,
  invalidModeMessage,
  modeChangedMessage,
  parseModeCommand,
  usableWindow,
} from "../../src/util/usage-mode"

describe("util.usage-mode", () => {
  test("parses /mode commands and leaves other slash commands alone", () => {
    expect(parseModeCommand("/mode")).toEqual({ type: "show" })
    expect(parseModeCommand("  /mode   ")).toEqual({ type: "show" })
    expect(parseModeCommand("/mode 節約")).toEqual({ type: "set", mode: "saver" })
    expect(parseModeCommand("/mode たっぷり")).toEqual({ type: "set", mode: "max" })
    expect(parseModeCommand("/mode Standard")).toEqual({ type: "set", mode: "standard" })
    expect(parseModeCommand("/mode turbo")).toEqual({ type: "invalid", value: "turbo" })
    expect(parseModeCommand("/models")).toBeUndefined()
    expect(parseModeCommand("mode saver")).toBeUndefined()
  })

  test("shows the default mode and its threshold in Japanese and English", () => {
    const base = { env: {}, window: 1_018_000 }
    expect(describeMode({ ...base, language: "ja" })).toBe(
      ["モード: 標準(既定)", "自動要約の閾値: 256,000 tokens", "古いツール出力の整理: OFF"].join("\n"),
    )
    expect(describeMode({ ...base, language: "en" })).toBe(
      ["Mode: Standard (default)", "Auto-compaction threshold: 256,000 tokens", "Prune old tool outputs: off"].join(
        "\n",
      ),
    )
  })

  test("shows where the mode came from and the model window for max", () => {
    expect(describeMode({ compaction: { mode: "saver" }, env: {}, window: 1_018_000, language: "ja" })).toBe(
      ["モード: 節約(設定ファイル)", "自動要約の閾値: 128,000 tokens", "古いツール出力の整理: ON"].join("\n"),
    )
    expect(
      describeMode({ compaction: { mode: "max" }, env: { SENTE_MODE: "たっぷり" }, window: 1_018_000, language: "en" }),
    ).toContain(
      "Mode: Max (SENTE_MODE environment variable)\nAuto-compaction threshold: up to the model's window (~1,018,000 tokens)",
    )
    expect(describeMode({ env: {}, window: 168_000, language: "ja" })).toContain(
      "自動要約の閾値: 168,000 tokens(このモデルの文脈窓が上限)",
    )
  })

  test("says when SENTE_MAX_CONTEXT overrides the mode and flags an invalid SENTE_MODE", () => {
    const text = describeMode({
      compaction: { mode: "saver", max_context: 400_000 },
      env: { SENTE_MODE: "turbo", SENTE_MAX_CONTEXT: "400k" },
      window: 1_018_000,
      language: "ja",
    })
    expect(text).toContain("自動要約の閾値: 400,000 tokens — SENTE_MAX_CONTEXT が優先")
    expect(text).toContain("SENTE_MODE=turbo は無効なので無視しています")
  })

  test("change and error messages are localized and mention an overriding SENTE_MODE", () => {
    expect(modeChangedMessage("saver", {}, "ja")).toBe(
      "モードを「節約」にしました(128k で自動要約・古いツール出力を整理)",
    )
    expect(modeChangedMessage("max", { SENTE_MODE: "saver" }, "en")).toContain(
      "SENTE_MODE=saver still takes precedence",
    )
    expect(modeChangedMessage("saver", { SENTE_MODE: "節約" }, "ja")).not.toContain("優先")
    expect(invalidModeMessage("turbo", "en")).toContain("/mode saver | standard | max")
  })

  test("usable window mirrors session/overflow.ts", () => {
    expect(usableWindow({ context: 1_050_000, output: 32_000 })).toBe(1_018_000)
    expect(usableWindow({ context: 400_000, input: 272_000, output: 128_000 })).toBe(252_000)
    expect(usableWindow({ context: 0, output: 0 })).toBeUndefined()
  })
})

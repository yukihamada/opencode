import { describe, expect, test } from "bun:test"
import { modelCostDetail } from "../../src/util/model-cost"

describe("model cost details", () => {
  test("shows base input/output rates per million tokens, not a request total", () => {
    expect(modelCostDetail({ input: 0.07, output: 0.25 }, "en-US")).toBe(
      "Configured rate · USD/1M tokens · in 0.07 / out 0.25",
    )
    expect(modelCostDetail({ input: 10, output: 50 }, "ja-JP")).toBe(
      "設定単価 · USD/100万token · 入力 10 / 出力 50",
    )
  })

  test("does not present missing, invalid or default zero rates as free", () => {
    for (const cost of [
      undefined,
      { input: 0, output: 0 },
      { input: Number.NaN, output: 1 },
      { input: 1, output: Number.POSITIVE_INFINITY },
      { input: -1, output: 1 },
    ]) {
      expect(modelCostDetail(cost, "en-US")).toBe("Rate unavailable")
      expect(modelCostDetail(cost, "ja-JP")).toBe("単価未確認")
    }
  })

  test("preserves tiny nonzero prices and supports one free direction", () => {
    expect(modelCostDetail({ input: 0, output: 0.00001 }, "en-US")).toEndWith("in 0 / out 0.00001")
  })

  test("formats decimals for the locale without floating point noise", () => {
    expect(modelCostDetail({ input: 0.21559999999999999, output: 0.6468 }, "en-US")).toEndWith(
      "in 0.2156 / out 0.6468",
    )
    expect(modelCostDetail({ input: 0.07, output: 0.25 }, "de-DE")).toEndWith("in 0,07 / out 0,25")
  })
})

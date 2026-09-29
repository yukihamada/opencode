import { describe, expect, test } from "bun:test"
import type { Provider } from "../../src/provider/provider"
import { DEFAULT_MAX_CONTEXT, isOverflow, usable } from "../../src/session/overflow"

function model(context: number, output = 32_000, input?: number): Provider.Model {
  return {
    id: "m",
    providerID: "teai",
    name: "m",
    limit: { context, output, input },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/openai-compatible" },
    options: {},
  } as unknown as Provider.Model
}

const tokens = (n: number) => ({ input: 5_000, output: 1_000, reasoning: 0, cache: { read: n - 6_000, write: 0 } })

describe("session.overflow max_context cap", () => {
  // 実測: openai/gpt-6-astra-pro(1.05M window)で 1 リクエスト 912,439 tokens まで育っていた。
  test("1M-window models compact at the default cap instead of ~1M", () => {
    const m = model(1_050_000)
    expect(usable({ cfg: {}, model: m })).toBe(DEFAULT_MAX_CONTEXT)
    expect(isOverflow({ cfg: {}, model: m, tokens: tokens(300_000) })).toBe(true)
    expect(isOverflow({ cfg: {}, model: m, tokens: tokens(200_000) })).toBe(false)
  })

  test("models with a smaller window keep their window-based threshold", () => {
    expect(usable({ cfg: {}, model: model(200_000) })).toBe(200_000 - 32_000)
    expect(usable({ cfg: {}, model: model(400_000, 128_000, 272_000) })).toBe(252_000)
  })

  test("compaction.max_context overrides the cap; 0 disables it", () => {
    const m = model(1_050_000)
    expect(usable({ cfg: { compaction: { max_context: 120_000 } }, model: m })).toBe(120_000)
    expect(usable({ cfg: { compaction: { max_context: 0 } }, model: m })).toBe(1_050_000 - 32_000)
    expect(isOverflow({ cfg: { compaction: { max_context: 0 } }, model: m, tokens: tokens(900_000) })).toBe(false)
  })

  test("auto: false still disables compaction entirely", () => {
    expect(isOverflow({ cfg: { compaction: { auto: false } }, model: model(1_050_000), tokens: tokens(900_000) })).toBe(
      false,
    )
  })
})

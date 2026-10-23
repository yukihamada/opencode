import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part } from "@sente-ai/sdk/v2"
import { actualModel, displayModel, requestedLabel } from "../../src/util/actual-model"

function stepFinish(metadata?: Record<string, unknown>): Part {
  return {
    id: "prt_step",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(metadata ? { metadata } : {}),
  } as Part
}

const message = {
  providerID: "teai",
  modelID: "auto",
} as AssistantMessage

describe("actualModel", () => {
  test("reads the actual routed model and reason from the last step-finish part", () => {
    expect(
      actualModel([stepFinish({ actualModel: "moonshotai/kimi-k3", routeReason: "quota-fallback" })]),
    ).toEqual({ model: "moonshotai/kimi-k3", reason: "quota-fallback" })
  })

  test("works for tool-only turns where the only content is a step-finish part", () => {
    expect(actualModel([stepFinish({ actualModel: "openai/gpt-5" })])).toEqual({ model: "openai/gpt-5" })
  })

  test("uses the latest step when a turn has multiple steps", () => {
    expect(
      actualModel([
        stepFinish({ actualModel: "openai/gpt-5" }),
        { id: "prt_tool", sessionID: "ses_1", messageID: "msg_1", type: "tool", callID: "c", tool: "read", state: { status: "pending", input: {}, raw: "" } } as Part,
        stepFinish({ actualModel: "moonshotai/kimi-k3" }),
      ]),
    ).toEqual({ model: "moonshotai/kimi-k3" })
  })

  test("returns undefined without metadata instead of guessing from the configured model", () => {
    expect(actualModel([])).toBeUndefined()
    expect(actualModel([stepFinish()])).toBeUndefined()
    expect(actualModel([stepFinish({})])).toBeUndefined()
    expect(actualModel([stepFinish({ actualModel: 42 })])).toBeUndefined()
    expect(actualModel([stepFinish({ actualModel: "" })])).toBeUndefined()
  })
})

describe("displayModel", () => {
  test("shows the actual model with the requested one kept visible", () => {
    const result = displayModel({
      providers: undefined,
      message,
      parts: [stepFinish({ actualModel: "moonshotai/kimi-k3", routeReason: "quota-fallback" })],
    })
    expect(result.label).toBe(`moonshotai/kimi-k3 (${requestedLabel()}: auto) · quota-fallback`)
    expect(result.actual).toEqual({ model: "moonshotai/kimi-k3", reason: "quota-fallback" })
  })

  test("localizes the requested label for japanese environments", () => {
    const env = { TE_LANG: process.env.TE_LANG, LANG: process.env.LANG }
    process.env.TE_LANG = "ja_JP.UTF-8"
    try {
      const result = displayModel({
        providers: undefined,
        message,
        parts: [stepFinish({ actualModel: "moonshotai/kimi-k3" })],
      })
      expect(result.label).toBe("moonshotai/kimi-k3 (要求: auto)")
    } finally {
      if (env.TE_LANG === undefined) delete process.env.TE_LANG
      else process.env.TE_LANG = env.TE_LANG
      if (env.LANG === undefined) delete process.env.LANG
      else process.env.LANG = env.LANG
    }
  })

  test("falls back to the requested model when no route metadata exists", () => {
    const result = displayModel({ providers: undefined, message, parts: [stepFinish()] })
    expect(result.label).toBe("auto")
    expect(result.actual).toBeUndefined()
  })

  test("does not annotate when the actual model equals the requested model", () => {
    const result = displayModel({
      providers: undefined,
      message: { providerID: "openai", modelID: "gpt-5" } as AssistantMessage,
      parts: [stepFinish({ actualModel: "gpt-5" })],
    })
    expect(result.label).toBe("gpt-5")
  })
})

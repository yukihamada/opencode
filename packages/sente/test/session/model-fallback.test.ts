import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@sente-ai/core/v1/session"
import { NamedError } from "@sente-ai/core/util/error"
import { SessionModelFallback } from "../../src/session/model-fallback"
import { SessionRetry } from "../../src/session/retry"

// Text teai returned on 2026-10-31 when the Anthropic account behind claude-sonnet-5 ran dry.
const BLOCKED =
  "Generation did not complete: API error (503): Upstream provider for `anthropic/claude-sonnet-5` is blocked at the account level (upstream returned 400, typically an exhausted balance or a revoked key). The route reopens automatically once a background probe succeeds; other models on unaffected providers keep working.. Retry shortly."

const api = (data: Partial<{ statusCode: number; message: string; responseBody: string; isRetryable: boolean }>) =>
  new SessionV1.APIError({ message: "failed", isRetryable: false, ...data }).toObject()

describe("SessionModelFallback", () => {
  test("recognises teai's upstream account block in the message or the body", () => {
    expect(SessionModelFallback.blocked(api({ statusCode: 503, message: BLOCKED }))).toBe(true)
    expect(SessionModelFallback.blocked(api({ isRetryable: true, message: "x", responseBody: BLOCKED }))).toBe(true)
    expect(SessionModelFallback.blocked(new NamedError.Unknown({ message: BLOCKED }).toObject())).toBe(true)
  })

  test("ignores ordinary outages and empty errors", () => {
    expect(SessionModelFallback.blocked(api({ statusCode: 503, message: "Service Unavailable" }))).toBe(false)
    expect(SessionModelFallback.blocked(api({ message: "No upstream route is available right now" }))).toBe(false)
    expect(SessionModelFallback.blocked(undefined)).toBe(false)
  })

  test("the same model is not retried in-stream once blocked; other 503s still are", () => {
    expect(SessionRetry.retryable(api({ statusCode: 503, message: BLOCKED, isRetryable: true }), "teai")).toBeUndefined()
    expect(SessionRetry.retryable(api({ statusCode: 503, message: "Service Unavailable" }), "teai")).toBeDefined()
  })

  test("family is the vendor prefix", () => {
    expect(SessionModelFallback.family("anthropic/claude-sonnet-5")).toBe("anthropic")
    expect(SessionModelFallback.family("z-ai/glm-5.3-flash")).toBe("z-ai")
    expect(SessionModelFallback.family("glm")).toBe("glm")
  })

  test("candidates come from the user's own settings, env first, without duplicates", () => {
    const cfg = {
      model: "teai/anthropic/claude-sonnet-5",
      small_model: "teai/openai/gpt-6-luna",
      agent: {
        general: { model: "teai/deepseek/deepseek-v4.1-flash-1017" },
        explore: { model: "teai/openai/gpt-6-luna" },
        build: {},
        bad: { model: "no-slash" },
      },
    }
    expect(SessionModelFallback.candidates(cfg, { SENTE_FALLBACK_MODELS: " teai/z-ai/glm-5.3-flash ,," })).toEqual([
      { providerID: "teai", modelID: "z-ai/glm-5.3-flash" },
      { providerID: "teai", modelID: "openai/gpt-6-luna" },
      { providerID: "teai", modelID: "deepseek/deepseek-v4.1-flash-1017" },
      { providerID: "teai", modelID: "anthropic/claude-sonnet-5" },
    ])
    expect(SessionModelFallback.candidates({}, {})).toEqual([])
  })

  test("status note is localised", () => {
    expect(SessionModelFallback.note("a/x", "b/y", "ja")).toContain("b/y に切り替えて")
    expect(SessionModelFallback.note("a/x", "b/y", "en")).toBe("a/x is unavailable upstream; continuing with b/y")
  })
})

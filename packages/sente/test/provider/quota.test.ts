import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { ProviderV2 } from "@sente-ai/core/provider"
import { ProviderQuota } from "../../src/provider/quota"
import { ProviderError } from "../../src/provider/error"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import { exitCodeForError, ExitCode, shouldRestart } from "../../src/cli/exit-code"

// 2026-09-29T14:37:25Z
const NOW = Date.UTC(2026, 8, 29, 14, 37, 25)

// teai.io PR #776 が返す 402 本文(api_key_limit_exceeded_text と同じ形)
function teai402(code: string, message: string) {
  return JSON.stringify({ error: { message, type: "insufficient_quota", code } })
}

const HOURLY = teai402(
  "api_key_hourly_limit_exceeded",
  "This API key reached its hourly limit (500 of 100 credits this hour). Raise or remove the limit in the dashboard: https://teai.io/dashboard#api-keys",
)

function callError(statusCode: number, responseBody: string) {
  return new APICallError({
    message: "Payment Required",
    url: "https://api.teai.io/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseHeaders: {},
    responseBody,
    isRetryable: false,
  })
}

describe("provider.quota.detect", () => {
  test("maps every teai window code to its period and next UTC window start", () => {
    const cases: Array<[string, ProviderQuota.QuotaPeriod, number]> = [
      ["api_key_minute_limit_exceeded", "minute", Date.UTC(2026, 8, 29, 14, 38)],
      ["api_key_hourly_limit_exceeded", "hour", Date.UTC(2026, 8, 29, 15)],
      ["api_key_daily_limit_exceeded", "day", Date.UTC(2026, 8, 30)],
      ["api_key_monthly_limit_exceeded", "month", Date.UTC(2026, 9, 1)],
    ]
    for (const [code, period, resetAt] of cases) {
      expect(ProviderQuota.detect({ statusCode: 402, responseBody: teai402(code, "x") }, NOW)).toEqual({
        period,
        code,
        resetAt,
      })
    }
  })

  test("falls back to the English message when the code is missing", () => {
    const q = ProviderQuota.detect({ statusCode: 402, message: "This API key reached its daily limit (9 of 5)" }, NOW)
    expect(q?.period).toBe("day")
  })

  test("month rollover in December goes to next year", () => {
    expect(ProviderQuota.nextWindowStart("month", Date.UTC(2026, 11, 31, 23, 59))).toBe(Date.UTC(2027, 0, 1))
  })

  test("a 402 without a window is a balance stop with no reset time", () => {
    const q = ProviderQuota.detect(
      { statusCode: 402, responseBody: '{"error":{"message":"insufficient credits"}}' },
      NOW,
    )
    expect(q).toEqual({ period: "balance", code: "insufficient_credits", resetAt: undefined })
  })

  test("ignores anything that is not a 402", () => {
    expect(ProviderQuota.detect({ statusCode: 429, responseBody: HOURLY }, NOW)).toBeUndefined()
    expect(ProviderQuota.detect({ responseBody: HOURLY }, NOW)).toBeUndefined()
  })
})

describe("provider.quota.describe", () => {
  const hour = ProviderQuota.detect({ statusCode: 402, responseBody: HOURLY }, NOW)!

  test("Japanese: which window, when to resume, that work is saved, how to resume", () => {
    const text = ProviderQuota.describe(hour, { now: NOW, lang: "ja", timeZone: "Asia/Tokyo" })
    expect(text).toContain("1時間あたり")
    expect(text).toContain("0:00") // 15:00Z = 翌 0:00 JST
    expect(text).toContain("約23分後")
    expect(text).toContain("自動再試行はしません")
    expect(text).toContain("保存済み")
    expect(text).toContain("te resume")
  })

  test("English", () => {
    const text = ProviderQuota.describe(hour, { now: NOW, lang: "en", timeZone: "UTC" })
    expect(text).toContain("hourly usage limit")
    expect(text).toContain("03:00 PM")
    expect(text).toContain("in about 23 min")
    expect(text).toContain("te resume")
  })

  test("language follows LANG / LC_ALL", () => {
    expect(ProviderQuota.language({ LANG: "ja_JP.UTF-8" })).toBe("ja")
    expect(ProviderQuota.language({ LANG: "en_US.UTF-8" })).toBe("en")
    expect(ProviderQuota.language({ LC_ALL: "ja_JP.UTF-8", LANG: "en_US.UTF-8" })).toBe("ja")
    expect(ProviderQuota.language({})).toBe("en")
  })
})

describe("402 end to end through the error pipeline", () => {
  const teai = ProviderV2.ID.make("teai")

  test("parseAPICallError marks it non-retryable with period metadata", () => {
    const parsed = ProviderError.parseAPICallError({ providerID: teai, error: callError(402, HOURLY) })
    expect(parsed.type).toBe("api_error")
    if (parsed.type !== "api_error") return
    expect(parsed.isRetryable).toBe(false)
    expect(parsed.statusCode).toBe(402)
    expect(parsed.metadata?.quotaPeriod).toBe("hour")
    expect(parsed.metadata?.quotaCode).toBe("api_key_hourly_limit_exceeded")
    expect(parsed.metadata?.quotaResetAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:00:00\.000Z$/)
    expect(parsed.message).toMatch(/te resume/)
  })

  // 本文の "500 of 100 credits" が 5xx 用の /500/ パターンに当たり、再送されていた。
  test("never retried, even when the body contains 5xx-looking numbers", () => {
    const error = MessageV2.fromError(callError(402, HOURLY), { providerID: teai })
    expect(SessionRetry.retryable(error, "teai")).toBeUndefined()
  })

  test("a 402 from another provider is not rewritten as a teai message but still not retried", () => {
    const other = ProviderV2.ID.make("openrouter")
    const parsed = ProviderError.parseAPICallError({
      providerID: other,
      error: callError(402, '{"error":{"message":"Insufficient credits (502 left)"}}'),
    })
    if (parsed.type !== "api_error") throw new Error("expected api_error")
    expect(parsed.isRetryable).toBe(false)
    expect(parsed.message).not.toContain("teai.io")
    const error = MessageV2.fromError(callError(402, '{"error":{"message":"Insufficient credits (502 left)"}}'), {
      providerID: other,
    })
    expect(SessionRetry.retryable(error, "openrouter")).toBeUndefined()
  })

  test("run exits 6 (Quota) and supervisors do not restart", () => {
    const error = MessageV2.fromError(callError(402, HOURLY), { providerID: teai })
    expect(exitCodeForError(error)).toBe(ExitCode.Quota)
    expect(shouldRestart(exitCodeForError(error))).toBe(false)
  })

  test("429 is still retried (unchanged)", () => {
    const error = MessageV2.fromError(
      new APICallError({
        message: "Too Many Requests",
        url: "https://api.teai.io/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: {},
        responseBody: '{"error":{"message":"rate limit"}}',
        isRetryable: true,
      }),
      { providerID: teai },
    )
    expect(SessionRetry.retryable(error, "teai")).toBeDefined()
  })
})

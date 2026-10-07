import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@sente-ai/core/v1/session"
import { SessionAutoResume } from "../../src/session/auto-resume"

const api = (data: Partial<{ statusCode: number; message: string; responseBody: string; isRetryable: boolean }>) =>
  new SessionV1.APIError({ message: "failed", isRetryable: false, ...data }).toObject()

describe("SessionAutoResume", () => {
  test("waits longer each time, up to six times the base, and gives up after five", () => {
    expect([1, 2, 3, 4, 5].map((n) => SessionAutoResume.resumeDelay(n, 10_000))).toEqual([
      10_000, 20_000, 40_000, 60_000, 60_000,
    ])
    expect(SessionAutoResume.resumeDelay(6, 10_000)).toBeUndefined()
    expect(SessionAutoResume.resumeDelay(0, 10_000)).toBeUndefined()
  })

  test("the base comes from SENTE_AUTO_RESUME_BASE_MS; 0 turns it off; nonsense keeps the default", () => {
    expect(SessionAutoResume.baseMs({})).toBe(10_000)
    expect(SessionAutoResume.baseMs({ SENTE_AUTO_RESUME_BASE_MS: "200" })).toBe(200)
    expect(SessionAutoResume.baseMs({ SENTE_AUTO_RESUME_BASE_MS: "abc" })).toBe(10_000)
    expect(SessionAutoResume.baseMs({ SENTE_AUTO_RESUME_BASE_MS: "-5" })).toBe(10_000)
    expect(SessionAutoResume.resumeDelay(1, SessionAutoResume.baseMs({ SENTE_AUTO_RESUME_BASE_MS: "0" }))).toBeUndefined()
  })

  test("resumes after failures that waiting can fix", () => {
    for (const statusCode of [408, 429, 500, 502, 503, 504, 524]) {
      expect(SessionAutoResume.recoverable(api({ statusCode }))).toBe(true)
    }
    expect(SessionAutoResume.recoverable(api({ message: "fetch failed" }))).toBe(true)
    expect(SessionAutoResume.recoverable(api({ message: "socket hang up" }))).toBe(true)
    expect(SessionAutoResume.recoverable(api({ isRetryable: true }))).toBe(true)
  })

  test("never resumes what would come back the same: auth, refusals, spent quota, aborts", () => {
    for (const statusCode of [400, 401, 402, 403, 404, 422]) {
      expect(SessionAutoResume.recoverable(api({ statusCode, isRetryable: true }))).toBe(false)
    }
    // teai's cap notice arrives as 402 with numbers in the body that look like a 5xx to a loose matcher.
    expect(
      SessionAutoResume.recoverable(api({ statusCode: 402, responseBody: "used 500 of 100 credits this hour" })),
    ).toBe(false)
    expect(SessionAutoResume.recoverable(api({ statusCode: 503, responseBody: "GoUsageLimitError" }))).toBe(false)
    expect(SessionAutoResume.recoverable(new SessionV1.AbortedError({ message: "aborted" }).toObject())).toBe(false)
    expect(SessionAutoResume.recoverable(undefined)).toBe(false)
    expect(
      SessionAutoResume.recoverable(new SessionV1.OutputLengthError({}).toObject() as SessionV1.Assistant["error"]),
    ).toBe(false)
  })

  test("the waiting note says which attempt this is, in the user's language", () => {
    expect(SessionAutoResume.resumeNote(2, "ja")).toBe("一時的なエラーのため自動で再開します（2/5回目）")
    expect(SessionAutoResume.resumeNote(2, "en")).toBe("Temporary error; resuming automatically (2/5)")
  })
})

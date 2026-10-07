export * as SessionAutoResume from "./auto-resume"

import { SessionV1 } from "@sente-ai/core/v1/session"
import { ProviderQuota } from "@/provider/quota"

/**
 * Automatic resume after a turn stops on a transient provider failure.
 *
 * The stream already retries a failed request a few times (SessionRetry). When
 * those run out the turn used to end and the work sat there until someone typed
 * "continue". An outage that lasts a minute is the common case, so wait and run
 * the turn again — a bounded number of times, with a growing pause, and only for
 * failures that waiting can fix.
 */
export const MAX_AUTO_RESUMES = 5

const DEFAULT_BASE_MS = 10_000

/** Pause before the first resume; later ones double, capped at six times this. `SENTE_AUTO_RESUME_BASE_MS=0` disables. */
export function baseMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SENTE_AUTO_RESUME_BASE_MS
  if (raw === undefined || raw.trim() === "") return DEFAULT_BASE_MS
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_BASE_MS
}

/** `count` is which resume this would be (1-based). `undefined` means do not resume. */
export function resumeDelay(count: number, base = baseMs()): number | undefined {
  if (base <= 0) return undefined
  if (!Number.isInteger(count) || count < 1 || count > MAX_AUTO_RESUMES) return undefined
  return Math.min(base * 2 ** (count - 1), base * 6)
}

export function resumeNote(count: number, lang: "ja" | "en" = ProviderQuota.language()): string {
  return lang === "ja"
    ? `一時的なエラーのため自動で再開します（${count}/${MAX_AUTO_RESUMES}回目）`
    : `Temporary error; resuming automatically (${count}/${MAX_AUTO_RESUMES})`
}

const TRANSIENT_STATUS = [408, 429, 500, 502, 503, 504, 524]
const TRANSIENT_TEXT = /network|timeout|timed out|fetch failed|connection|socket|overloaded|service unavailable/i

/**
 * Whether waiting and trying again can plausibly fix this error.
 *
 * Never for an abort, bad credentials, a refused request or a spent quota:
 * those come back identical, and resuming would only repeat a rejected (or a
 * billed) request.
 */
export function recoverable(error: SessionV1.Assistant["error"]): boolean {
  if (!error || error.name === "MessageAbortedError" || error.name === "ProviderAuthError") return false
  if (!SessionV1.APIError.isInstance(error)) return false
  const status = error.data.statusCode
  if (status !== undefined && [400, 401, 402, 403, 404, 422].includes(status)) return false
  if (ProviderQuota.detect({ statusCode: status, responseBody: error.data.responseBody, message: error.data.message }))
    return false
  const text = `${error.data.message} ${error.data.responseBody ?? ""}`
  if (/FreeUsageLimitError|GoUsageLimitError/.test(text)) return false
  return (
    error.data.isRetryable === true || (status !== undefined && TRANSIENT_STATUS.includes(status)) || TRANSIENT_TEXT.test(text)
  )
}

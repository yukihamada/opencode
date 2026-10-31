export * as SessionModelFallback from "./model-fallback"

import type { SessionV1 } from "@sente-ai/core/v1/session"

/**
 * Switching to another model when the upstream of the current one is blocked.
 *
 * teai answers 503 "Upstream provider for `X` is blocked at the account level" when the
 * provider behind X has run out of balance or lost its key. The route only reopens after
 * a background probe succeeds (minutes or hours), so waiting and retrying the same model
 * fails every time. On 2026-10-29〜31 this stopped many sessions: each one retried the
 * blocked model about 30 times and then gave up, while other models answered normally.
 *
 * Instead, keep the turn going on a model from a different family that the user already
 * configured (their own choices, never a hard-coded list), and say so in the status line.
 */

const BLOCKED = /blocked at the account level/i

/** Whether the error says the model's upstream account is blocked (balance or key), not a passing outage. */
export function blocked(error: SessionV1.Assistant["error"] | undefined): boolean {
  if (!error) return false
  const data = (error as { data?: Record<string, unknown> }).data
  if (!data) return false
  return [data.message, data.responseBody].some((value) => typeof value === "string" && BLOCKED.test(value))
}

/** Model family = the vendor prefix of the model id ("anthropic/claude-sonnet-5" → "anthropic"). */
export function family(modelID: string): string {
  const slash = modelID.indexOf("/")
  return (slash === -1 ? modelID : modelID.slice(0, slash)).toLowerCase()
}

type Ref = { providerID: string; modelID: string }

function parse(value: unknown): Ref | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash === trimmed.length - 1) return undefined
  return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) }
}

/**
 * Models to try, in order: `SENTE_FALLBACK_MODELS` (comma separated, "provider/model"),
 * then the configured small model, agent models and main model. Duplicates removed.
 * The caller still filters by the resolved model's family.
 */
export function candidates(
  cfg: { model?: string; small_model?: string; agent?: Record<string, { model?: string } | undefined> },
  env: Record<string, string | undefined> = process.env,
): Ref[] {
  const raw = [
    ...(env.SENTE_FALLBACK_MODELS ?? "").split(","),
    cfg.small_model,
    ...Object.values(cfg.agent ?? {}).map((agent) => agent?.model),
    cfg.model,
  ]
  const seen = new Set<string>()
  const out: Ref[] = []
  for (const value of raw) {
    const ref = parse(value)
    if (!ref) continue
    const key = `${ref.providerID}/${ref.modelID}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

export function note(from: string, to: string, lang: "ja" | "en"): string {
  return lang === "ja"
    ? `${from} の提供元が停止中のため ${to} に切り替えて続けます`
    : `${from} is unavailable upstream; continuing with ${to}`
}

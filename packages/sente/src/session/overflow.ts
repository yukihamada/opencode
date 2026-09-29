import type { Config } from "@/config/config"
import { ConfigV1 } from "@sente-ai/core/v1/config/config"
import { SessionV1 } from "@sente-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

/**
 * Ceiling on the context a single request may carry before auto-compaction,
 * independent of the model's window. Each agent step resends the entire
 * context, so with 1M-token models (gpt-6-astra, claude-fable-5.1, hy4 …) the
 * window-based threshold (~1M) let sessions grow to 300k–900k tokens per
 * request. Measured on one Mac's session DB (2026-09-07..29): 2,765 requests
 * at ≥300k tokens, max 912,439. 256k keeps every model whose window is at or
 * below ~276k on its existing threshold.
 */
export const DEFAULT_MAX_CONTEXT = 256_000

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  const window = input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  const cap = input.cfg.compaction?.max_context ?? DEFAULT_MAX_CONTEXT
  return cap > 0 ? Math.min(window, cap) : window
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}

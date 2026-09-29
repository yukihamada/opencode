/**
 * Usage modes: one switch for how much context each request may carry.
 *
 * - saver    (節約):   auto-compact at 128k tokens and prune old tool outputs
 * - standard (標準):   auto-compact at 256k tokens (default)
 * - max      (たっぷり): auto-compact only near the model's own context window
 *
 * Modes never pick models or touch pricing. An explicit token count
 * (SENTE_MAX_CONTEXT or `compaction.max_context`) beats the mode, and
 * SENTE_MODE beats `compaction.mode`.
 */

export const MODES = ["saver", "standard", "max"] as const
export type Mode = (typeof MODES)[number]

export const DEFAULT_MODE: Mode = "standard"

const SETTINGS: Record<Mode, { maxContext: number; prune: boolean; ja: string; en: string }> = {
  saver: { maxContext: 128_000, prune: true, ja: "節約", en: "Saver" },
  standard: { maxContext: 256_000, prune: false, ja: "標準", en: "Standard" },
  // 0 = no cap: compact only when the model's window is nearly full.
  max: { maxContext: 0, prune: false, ja: "たっぷり", en: "Max" },
}

const ALIASES: Record<string, Mode> = {
  saver: "saver",
  節約: "saver",
  standard: "standard",
  標準: "standard",
  max: "max",
  たっぷり: "max",
}

/** Accepts `saver|standard|max` (any case) and `節約|標準|たっぷり`. */
export function parse(input: string | undefined) {
  if (input === undefined) return undefined
  return ALIASES[input.trim().toLowerCase()]
}

/** Auto-compaction ceiling in tokens for a mode; 0 means "the model's window". */
export function maxContext(mode: Mode) {
  return SETTINGS[mode].maxContext
}

export function prune(mode: Mode) {
  return SETTINGS[mode].prune
}

export function label(mode: Mode, language: "ja" | "en") {
  return SETTINGS[mode][language]
}

/**
 * Picks the active mode: SENTE_MODE, then the config file, then standard.
 * An unrecognised SENTE_MODE is reported via `invalid` and ignored.
 */
export function resolve(input: { env?: string; config?: string }) {
  const fromEnv = parse(input.env)
  if (fromEnv) return { mode: fromEnv, source: "env" as const }
  const invalid = input.env !== undefined && input.env.trim() !== "" ? input.env : undefined
  const fromConfig = parse(input.config)
  if (fromConfig) return { mode: fromConfig, source: "config" as const, invalid }
  return { mode: DEFAULT_MODE, source: "default" as const, invalid }
}

/**
 * The context size at which auto-compaction starts, before the model's output
 * reserve is subtracted. An explicit `override` (from SENTE_MAX_CONTEXT or
 * `compaction.max_context`) beats the mode; 0 on either side means the window.
 */
export function threshold(input: { mode: Mode; override?: number; window: number }) {
  const cap = input.override ?? maxContext(input.mode)
  return cap > 0 ? Math.min(input.window, cap) : input.window
}

export * as UsageMode from "./usage-mode"

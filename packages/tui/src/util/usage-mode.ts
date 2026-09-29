import { UsageMode } from "@sente-ai/core/usage-mode"
import type { Language } from "../context/language"

export type ModeCommand = { type: "show" } | { type: "set"; mode: UsageMode.Mode } | { type: "invalid"; value: string }

/// `/mode`, `/mode 節約`, `/mode max` … を解釈する。`/mode` 以外(例: `/models`)は undefined。
export function parseModeCommand(input: string): ModeCommand | undefined {
  const match = /^\/mode(?:\s+(.*))?$/s.exec(input.trim())
  if (!match) return undefined
  const arg = match[1]?.trim()
  if (!arg) return { type: "show" }
  const mode = UsageMode.parse(arg)
  return mode ? { type: "set", mode } : { type: "invalid", value: arg }
}

export type ModeStatusInput = {
  /// 読み込み済み設定の compaction(SENTE_MODE / SENTE_MAX_CONTEXT 適用後)
  compaction?: { mode?: string; max_context?: number; prune?: boolean }
  env: { SENTE_MODE?: string; SENTE_MAX_CONTEXT?: string }
  /// 現在のモデルの文脈窓(不明なら undefined)
  window?: number
  language: Language
}

/// `/mode`(引数なし)で出す、現在のモードと実効閾値の説明。
export function describeMode(input: ModeStatusInput) {
  const text = (ja: string, en: string) => (input.language === "ja" ? ja : en)
  const resolved = UsageMode.resolve({ env: input.env.SENTE_MODE, config: input.compaction?.mode })
  const mode = resolved.mode
  const override = input.compaction?.max_context
  const format = (n: number) => n.toLocaleString(input.language === "ja" ? "ja-JP" : "en-US")
  const source = {
    env: text("環境変数 SENTE_MODE", "SENTE_MODE environment variable"),
    config: text("設定ファイル", "config file"),
    default: text("既定", "default"),
  }[resolved.source]
  const cap = override ?? UsageMode.maxContext(mode)
  const window = input.window
  const limit =
    cap > 0
      ? window && window < cap
        ? text(
            `${format(window)} tokens(このモデルの文脈窓が上限)`,
            `${format(window)} tokens (limited by this model's window)`,
          )
        : `${format(cap)} tokens`
      : window
        ? text(
            `モデルの文脈窓の上限まで(約 ${format(window)} tokens)`,
            `up to the model's window (~${format(window)} tokens)`,
          )
        : text("モデルの文脈窓の上限まで", "up to the model's window")
  const overrideBy = input.env.SENTE_MAX_CONTEXT?.trim() ? "SENTE_MAX_CONTEXT" : "compaction.max_context"
  const prune = input.compaction?.prune ?? UsageMode.prune(mode)
  return [
    text(`モード: ${UsageMode.label(mode, "ja")}(${source})`, `Mode: ${UsageMode.label(mode, "en")} (${source})`),
    text(`自動要約の閾値: ${limit}`, `Auto-compaction threshold: ${limit}`) +
      (override !== undefined ? text(` — ${overrideBy} が優先`, ` — set by ${overrideBy}`) : ""),
    text(`古いツール出力の整理: ${prune ? "ON" : "OFF"}`, `Prune old tool outputs: ${prune ? "on" : "off"}`),
    ...(resolved.invalid !== undefined
      ? [
          text(
            `SENTE_MODE=${resolved.invalid} は無効なので無視しています`,
            `Ignoring invalid SENTE_MODE=${resolved.invalid}`,
          ),
        ]
      : []),
  ].join("\n")
}

/// モード一覧の1行説明(選択ダイアログ・不正値の案内で使う)。
export function modeDescription(mode: UsageMode.Mode, language: Language) {
  const cap = UsageMode.maxContext(mode)
  const tokens = `${Math.round(cap / 1000)}k`
  if (language === "ja") {
    if (mode === "saver") return `${tokens} で自動要約・古いツール出力を整理`
    if (mode === "standard") return `${tokens} で自動要約(既定)`
    return "モデルの文脈窓の上限まで要約しない"
  }
  if (mode === "saver") return `Compact at ${tokens}, prune old tool outputs`
  if (mode === "standard") return `Compact at ${tokens} (default)`
  return "Compact only near the model's window"
}

/// 選択後・`/mode 節約` 実行後の通知文。SENTE_MODE が設定済みならそちらが優先される旨も伝える。
export function modeChangedMessage(mode: UsageMode.Mode, env: { SENTE_MODE?: string }, language: Language) {
  const text = (ja: string, en: string) => (language === "ja" ? ja : en)
  const base = text(
    `モードを「${UsageMode.label(mode, "ja")}」にしました(${modeDescription(mode, "ja")})`,
    `Mode set to ${UsageMode.label(mode, "en")} (${modeDescription(mode, "en")})`,
  )
  const envMode = UsageMode.parse(env.SENTE_MODE)
  if (!envMode || envMode === mode) return base
  return (
    base +
    "\n" +
    text(
      `ただし環境変数 SENTE_MODE=${env.SENTE_MODE} が優先されます`,
      `Note: SENTE_MODE=${env.SENTE_MODE} still takes precedence`,
    )
  )
}

export function invalidModeMessage(value: string, language: Language) {
  return language === "ja"
    ? `「${value}」は使えません。/mode 節約 | 標準 | たっぷり(saver | standard | max)`
    : `Unknown mode "${value}". Use /mode saver | standard | max (節約 | 標準 | たっぷり)`
}

/// 自動要約に使える文脈窓(sente/src/session/overflow.ts の usable() と同じ計算・閾値適用前)。
export function usableWindow(limit: { context: number; input?: number; output: number }, reserved?: number) {
  if (!limit.context) return undefined
  const output = Math.min(limit.output, 32_000) || 32_000
  return limit.input
    ? Math.max(0, limit.input - (reserved ?? Math.min(20_000, output)))
    : Math.max(0, limit.context - output)
}

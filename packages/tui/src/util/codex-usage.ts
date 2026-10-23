export interface CodexUsageWindow {
  usedPercent: number | "NaN" | "Infinity" | "-Infinity"
  windowDurationMins?: number | "NaN" | "Infinity" | "-Infinity"
  resetsAt?: number | "NaN" | "Infinity" | "-Infinity"
}

export interface CodexUsageLimit {
  name?: string
  allowed?: boolean
  limitReached?: boolean
  primary?: CodexUsageWindow
  secondary?: CodexUsageWindow
}

export type CodexUsageReason = "cli_missing" | "not_authenticated" | "unavailable"

export interface CodexUsage {
  authenticated: boolean
  available: boolean
  planType?: string
  limits: CodexUsageLimit[]
  reason?: CodexUsageReason
}

export function codexUsageLanguage() {
  return (process.env.TE_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "en").startsWith(
    "ja",
  )
    ? "ja"
    : "en"
}

export function formatCodexWindowDuration(mins: number, language: string) {
  const locale = language === "ja" ? "ja-JP" : "en-US"
  if (mins % 10080 === 0) {
    return new Intl.NumberFormat(locale, { style: "unit", unit: "week", unitDisplay: "short" }).format(mins / 10080)
  }
  if (mins % 1440 === 0) {
    return new Intl.NumberFormat(locale, { style: "unit", unit: "day", unitDisplay: "short" }).format(mins / 1440)
  }
  if (mins % 60 === 0) {
    return new Intl.NumberFormat(locale, { style: "unit", unit: "hour", unitDisplay: "short" }).format(mins / 60)
  }
  return new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "short" }).format(mins)
}

export function formatCodexUsageWindow(window: CodexUsageWindow, language: string) {
  const used = typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent) ? window.usedPercent : 0
  const remaining = Math.min(100, Math.max(0, 100 - used))
  const duration =
    typeof window.windowDurationMins === "number" && Number.isFinite(window.windowDurationMins)
      ? formatCodexWindowDuration(window.windowDurationMins, language)
      : undefined
  const reset =
    typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)
      ? new Date(window.resetsAt * 1000).toLocaleString(language === "ja" ? "ja-JP" : "en-US", {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : undefined
  return { remaining, duration, reset }
}

export function codexUsageLabels(language: string) {
  return language === "ja"
    ? {
        title: "Codex サブスク残量",
        remaining: "残り",
        reset: "リセット",
        unavailable: "残量を取得できません（一時的な障害の可能性があります）",
        signinRequired: "ChatGPT ブラウザログインでのみ表示されます",
        cliMissing:
          "公式 Codex CLI（codex）が見つかりません。インストール: npm i -g @openai/codex（https://developers.openai.com/codex/cli）",
        notAuthenticated: "公式 Codex CLI で未ログインです。`codex login` を実行してください",
        plan: "プラン",
      }
    : {
        title: "Codex subscription quota",
        remaining: "remaining",
        reset: "resets",
        unavailable: "Quota unavailable right now (temporary upstream issue)",
        signinRequired: "Only available with ChatGPT browser sign-in",
        cliMissing:
          "Official Codex CLI (`codex`) not found. Install: npm i -g @openai/codex (https://developers.openai.com/codex/cli)",
        notAuthenticated: "Not signed in to the official Codex CLI. Run `codex login`",
        plan: "Plan",
      }
}

export function codexUsageReasonLabel(reason: CodexUsageReason | undefined, language: string) {
  const labels = codexUsageLabels(language)
  if (reason === "cli_missing") return labels.cliMissing
  if (reason === "not_authenticated") return labels.notAuthenticated
  return labels.unavailable
}

export function claudeUsageLabels(language: string) {
  return language === "ja"
    ? {
        title: "Claude サブスク残量",
        automated:
          "自動取得には未対応です。公式 Claude Code CLI の /usage コマンドで確認できます（Senteは起動するだけで、トークンは読み取り・保存しません）",
        open: "公式 Claude Code を /usage で開く",
        missing:
          "公式 Claude Code CLI（claude）が見つかりません。インストール: npm i -g @anthropic-ai/claude-code（https://code.claude.com/docs/en/setup）",
        failed: (detail: string) => `公式 Claude Code CLI を起動できませんでした: ${detail}`,
        exited: (code: number) => `公式 Claude Code CLI がコード ${code} で終了しました`,
        hint: "手動: /connect → Claude Code サブスク（公式CLI）→ /usage",
      }
    : {
        title: "Claude subscription quota",
        automated:
          "Automated quota reading is not supported. Check it with the /usage command in the official Claude Code CLI (Sente only launches it — tokens are never read or stored)",
        open: "Open official Claude Code with /usage",
        missing:
          "Official Claude Code CLI (`claude`) not found. Install: npm i -g @anthropic-ai/claude-code (https://code.claude.com/docs/en/setup)",
        failed: (detail: string) => `Could not launch the official Claude Code CLI: ${detail}`,
        exited: (code: number) => `Official Claude Code CLI exited with code ${code}`,
        hint: "Manual: /connect → Claude Code subscription (official CLI) → /usage",
      }
}

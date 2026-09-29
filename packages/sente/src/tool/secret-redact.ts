// 🔴2026-09-25 実障害: `awk -F'[:,]' … ~/.config/teai/credentials` がキー全文をツール出力に出し、
// それを見たエージェントがキーを失効 → 稼働中の Sente 全セッションがデモモードに落ちた。
// ツール出力はモデルに送られ、セッションDBにも残る。既知のキー形式と、秘密っぽい環境変数の実値を
// ツール出力の段階で伏せる(先頭数文字だけ残してどのキーかは分かるようにする)。
// 無効化: SENTE_NO_SECRET_REDACT=1

const PATTERNS: RegExp[] = [
  /\b(?:te|cw)_[A-Za-z0-9]{24,}\b/g, // teai.io
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
  /\bsk-or-v1-[A-Za-z0-9]{32,}\b/g, // OpenRouter
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g, // OpenAI
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google
  /\bsk_live_[A-Za-z0-9]{24,}\b/g, // Stripe
  /\brk_live_[A-Za-z0-9]{24,}\b/g,
]

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i

function mask(value: string) {
  return value.slice(0, Math.min(8, Math.floor(value.length / 4))) + "…[REDACTED]"
}

function envSecrets(env: Record<string, string | undefined>) {
  return Object.entries(env)
    // Token-shaped values only (letters and digits, no path separators) so e.g. GPG_KEY_PATH=/Users/… never masks paths.
    .filter(([name, value]) => SECRET_ENV.test(name) && !!value && /^[A-Za-z0-9_\-.+=]{16,}$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value))
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length)
}

export function redact(text: string, env: Record<string, string | undefined> = process.env): string {
  if (!text || env.SENTE_NO_SECRET_REDACT === "1") return text
  let out = text
  for (const value of envSecrets(env)) {
    if (out.includes(value)) out = out.split(value).join(mask(value))
  }
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match) => mask(match))
  }
  return out
}

/**
 * Redacts every string inside tool metadata (shell live output, read's preview/display text, edit diffs…).
 * Metadata is persisted in the session DB and rendered in the TUI; the 2026-09-25 leak was read back from the DB.
 */
export function redactMetadata<M>(metadata: M, env?: Record<string, string | undefined>): M {
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return redact(value, env)
    if (depth > 8 || value === null || typeof value !== "object") return value
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1))
    if (Object.getPrototypeOf(value) !== Object.prototype) return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, depth + 1)]))
  }
  return walk(metadata, 0) as M
}

export * as SecretRedact from "./secret-redact"

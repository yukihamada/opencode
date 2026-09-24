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
    .filter(([name, value]) => SECRET_ENV.test(name) && value && value.length >= 16 && !/\s/.test(value))
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

/** Redacts every string field named `output` (the shell tool's live preview) in tool metadata. */
export function redactMetadata<M extends Record<string, any> | undefined>(metadata: M, env?: Record<string, string | undefined>): M {
  if (!metadata || typeof metadata.output !== "string") return metadata
  return { ...metadata, output: redact(metadata.output, env) }
}

export * as SecretRedact from "./secret-redact"

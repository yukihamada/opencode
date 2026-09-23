// teai.io account helpers for the Sente TUI (/login).
//
// The `te` launcher keeps the API key in `$TE_CONFIG_DIR/credentials`
// (default `~/.config/teai/credentials`) as a one-line `TEAI_API_KEY=te_...`
// shell fragment and exports it into the process environment before the
// engine starts. `/login` writes the same file so `te whoami`, MCP tools and
// the next launch all see the new key, then asks the engine to re-read its
// environment so the running session switches without a restart.

import path from "path"
import os from "os"
import { chmod, mkdir, rename } from "fs/promises"

export const TEAI_KEY_ENV = "TEAI_API_KEY"
export const TEAI_DEFAULT_API = "https://api.teai.io"
export const TEAI_DEFAULT_SITE = "https://teai.io"

export type TeaiEnv = Record<string, string | undefined>

export function apiBase(env: TeaiEnv = process.env) {
  return (env.TEAI_API || TEAI_DEFAULT_API).replace(/\/+$/, "")
}

export function siteBase(env: TeaiEnv = process.env) {
  return (env.TEAI_SITE || TEAI_DEFAULT_SITE).replace(/\/+$/, "")
}

/** Directory the `te` launcher uses for credentials/config (TE_CONFIG_DIR wins). */
export function configDir(env: TeaiEnv = process.env, home = os.homedir()) {
  const dir = env.TE_CONFIG_DIR?.trim()
  if (dir) return dir
  return path.join(home, ".config", "teai")
}

export function credentialsPath(env: TeaiEnv = process.env, home = os.homedir()) {
  return path.join(configDir(env, home), "credentials")
}

/** Accept the key exactly as pasted: trims whitespace and a leading `TEAI_API_KEY=`. */
export function normalizeKey(input: string) {
  const trimmed = input.trim().replace(/^export\s+/, "")
  const match = /^TEAI_API_KEY\s*=\s*["']?([^"'\s]+)["']?$/.exec(trimmed)
  return (match ? match[1] : trimmed).trim()
}

export function looksLikeKey(key: string) {
  return /^te_[A-Za-z0-9_-]{8,}$/.test(key)
}

/** Read TEAI_API_KEY out of a credentials file body (shell `KEY=value` lines). */
export function parseCredentials(text: string) {
  let key: string | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const match = /^(?:export\s+)?TEAI_API_KEY\s*=\s*["']?([^"'\s]*)["']?/.exec(line)
    if (match) key = match[1] || undefined
  }
  return key
}

/** Restore /login on direct engine starts, before config expansion or worker creation. */
export async function loadCredentials(env: TeaiEnv = process.env, home = os.homedir()) {
  // Match the launcher's explicit per-process override. Never source this as shell code.
  if (env[TEAI_KEY_ENV] || env.SENTE_SCRUB_KEY) return
  const text = await Bun.file(credentialsPath(env, home))
    .text()
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    })
  const key = parseCredentials(text)
  if (key) env[TEAI_KEY_ENV] = key
}

/** Replace all key assignments so a later legacy duplicate cannot undo /login. */
export function renderCredentials(existing: string, key: string) {
  const lines = existing ? existing.split(/\r?\n/) : []
  if (lines.length && lines[lines.length - 1] === "") lines.pop()
  let replaced = false
  const next = lines.flatMap((raw) => {
    if (/^\s*(?:export\s+)?TEAI_API_KEY\s*=/.test(raw)) {
      if (replaced) return []
      replaced = true
      return [`TEAI_API_KEY=${key}`]
    }
    return [raw]
  })
  if (!replaced) next.push(`TEAI_API_KEY=${key}`)
  return next.join("\n") + "\n"
}

export async function saveCredentials(key: string, file = credentialsPath()) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const existing = await Bun.file(file)
    .text()
    .catch(() => "")
  const temporary = `${file}.${process.pid}.tmp`
  await Bun.write(temporary, renderCredentials(existing, key))
  await chmod(temporary, 0o600)
  await rename(temporary, file)
  return file
}

export type TeaiAccount = {
  email?: string
  display_name?: string
  plan?: string
  credits_remaining?: number
}

export type VerifyResult =
  | { ok: true; account: TeaiAccount }
  | { ok: false; reason: "invalid" | "network"; detail?: string }

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

/** Exchange a short-lived email session for a revocable, persistent CLI API key. */
export async function durableKey(
  login: { token: string; apiKey?: string },
  opts: { api?: string; fetch?: Fetcher } = {},
) {
  if (login.apiKey && looksLikeKey(login.apiKey)) return login.apiKey
  const response = await (opts.fetch ?? fetch)(`${opts.api ?? apiBase()}/api/v1/apikeys`, {
    method: "POST",
    headers: { Authorization: `Bearer ${login.token}`, "Content-Type": "application/json", "X-Sente-Client": "sente" },
    body: JSON.stringify({ name: `sente-cli-${os.hostname().slice(0, 60)}` }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => undefined)
  if (!response.ok || body?.ok !== true || typeof body.api_key !== "string" || !looksLikeKey(body.api_key)) {
    // Never silently save the 30-day token as if login were persistent. Do not retry this POST.
    throw new Error(accountText().keyFailed)
  }
  return body.api_key as string
}

export function accountText(env: TeaiEnv = process.env) {
  const ja = /^(ja)(_|-|\b)/i.test(env.LC_ALL || env.LC_MESSAGES || env.LANG || "en")
  return ja ? {
    title: "teai.io アカウント", loading: "認証状態を確認中…", signedIn: "ログイン済み", signedOut: "未ログイン",
    invalid: "認証情報が失効しています。/login で再ログインしてください。",
    network: "通信を確認できません。ログイン情報は保持しています。",
    credits: "残高", low: "残高不足（ログインは有効）", unknown: "未確認", source: "認証情報の取得元",
    saved: "保存済みログイン", env: "環境変数 TEAI_API_KEY", conflict: "環境変数が保存済みログインより優先されています。",
    temporary: "短期セッショントークンを利用中です。/login で端末用キーへ切り替えてください。",
    persistent: "端末用APIキー（ダッシュボードで失効可能）", hint: "/login: 再ログイン · Esc: 閉じる",
    failed: "保存済みログイン情報を読み取れません。", remote: "接続先エンジンの認証状態はこの画面では未確認です。",
    keyFailed: "端末用キーを発行できませんでした。既存のログインは変更していません。再ログインしてください。",
    verifyFailed: "端末用キーを確認できませんでした。既存のログインは変更していません。/login で再試行してください。",
    protected: "保護モード中です。この画面では実キーを読み込まず、アカウント確認を行いません。",
  } : {
    title: "teai.io account", loading: "Checking authentication…", signedIn: "Logged in", signedOut: "Not logged in",
    invalid: "Credentials expired or revoked. Use /login to sign in again.",
    network: "Connection unavailable. Saved login has been kept.", credits: "Credits", low: "Insufficient credits (still logged in)",
    unknown: "Unknown", source: "Credential source", saved: "Saved login", env: "Environment TEAI_API_KEY",
    conflict: "The environment key overrides your saved login.",
    temporary: "Using a short-lived session token. Use /login to switch to a persistent CLI key.",
    persistent: "CLI API key (revocable in the dashboard)", hint: "/login: sign in again · Esc: close",
    failed: "Could not read saved credentials.", remote: "Authentication of the attached engine is not verified by this screen.",
    keyFailed: "Could not issue a CLI key. Existing login was not changed. Sign in again.",
    verifyFailed: "Could not verify the CLI key. Existing login was not changed. Try /login again.",
    protected: "Protected mode: this screen does not load the real key or query the account.",
  }
}

/** No secrets returned to the UI; no key minting or login writes on status checks. */
export async function accountStatus(opts: { env?: TeaiEnv; home?: string; fetch?: Fetcher } = {}) {
  const env = opts.env ?? process.env
  if (env.SENTE_SCRUB_KEY) return { state: "protected" as const, conflict: false, source: "saved" }
  const saved = parseCredentials(await Bun.file(credentialsPath(env, opts.home)).text().catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""
    throw new Error(accountText(env).failed)
  }))
  const key = env.TEAI_API_KEY || saved
  const conflict = Boolean(env.TEAI_API_KEY && saved && env.TEAI_API_KEY !== saved)
  const source = env.TEAI_API_KEY && env.TEAI_API_KEY !== saved ? "env" : "saved"
  if (!key) return { state: "missing" as const, conflict, source }
  const result = await verifyKey(key, { api: apiBase(env), fetch: opts.fetch })
  if (!result.ok) return { state: result.reason, conflict, source }
  return { state: "authenticated" as const, conflict, source, account: result.account, temporary: !looksLikeKey(key) }
}

/** Check a key against /api/v1/auth/me. Never throws. */
export async function verifyKey(key: string, opts: { api?: string; fetch?: Fetcher; timeoutMs?: number } = {}) {
  const api = opts.api ?? apiBase()
  const doFetch: Fetcher = opts.fetch ?? ((url, init) => fetch(url, init))
  try {
    const response = await doFetch(`${api}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    })
    const body = (await response.json().catch(() => undefined)) as
      | (TeaiAccount & { authenticated?: boolean; error?: unknown })
      | undefined
    if (response.ok && body?.authenticated === true) {
      return {
        ok: true,
        account: {
          email: body.email,
          display_name: body.display_name,
          plan: body.plan,
          credits_remaining: typeof body.credits_remaining === "number" ? body.credits_remaining : undefined,
        },
      } satisfies VerifyResult
    }
    if (response.status >= 500 || response.status === 429 || (response.ok && !body)) {
      return { ok: false, reason: "network", detail: `HTTP ${response.status}` } satisfies VerifyResult
    }
    return { ok: false, reason: "invalid", detail: `HTTP ${response.status}` } satisfies VerifyResult
  } catch (error) {
    return {
      ok: false,
      reason: "network",
      detail: error instanceof Error ? error.message : String(error),
    } satisfies VerifyResult
  }
}

export function formatCredits(credits: number | undefined) {
  if (credits === undefined) return "残高 未確認"
  return `残高 ${credits.toLocaleString("en-US")}cr`
}

export function looksLikeEmail(input: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.trim()) && input.trim().length <= 254
}

export function normalizeCode(input: string) {
  return input.trim().replace(/[^0-9]/g, "")
}

export type EmailCodeResult = { ok: true } | { ok: false; reason: "invalid" | "network"; detail?: string }

/** Ask teai.io to email a 6-digit login code. Never throws. */
export async function requestEmailCode(
  email: string,
  opts: { api?: string; fetch?: Fetcher; timeoutMs?: number } = {},
): Promise<EmailCodeResult> {
  const api = opts.api ?? apiBase()
  const doFetch: Fetcher = opts.fetch ?? ((url, init) => fetch(url, init))
  try {
    const response = await doFetch(`${api}/api/v1/auth/email`, {
      method: "POST",
      // X-Sente-Client marks this as a CLI request: the server skips the
      // browser-only Turnstile widget for tagged CLI calls (rate limits and
      // the verify-side signup guards still apply).
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Sente-Client": "sente",
      },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    })
    if (response.ok) return { ok: true }
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
    const detail = body?.error ?? `HTTP ${response.status}`
    if (response.status >= 500) return { ok: false, reason: "network", detail }
    return { ok: false, reason: "invalid", detail }
  } catch (error) {
    return { ok: false, reason: "network", detail: error instanceof Error ? error.message : String(error) }
  }
}

export type VerifyEmailResult =
  | { ok: true; token: string; apiKey?: string; account: TeaiAccount }
  | { ok: false; reason: "invalid" | "network"; detail?: string }

/** Redeem the 6-digit code. Returns the session token and, for brand-new accounts, the auto-issued API key. */
export async function verifyEmailCode(
  email: string,
  code: string,
  opts: { api?: string; fetch?: Fetcher; timeoutMs?: number } = {},
): Promise<VerifyEmailResult> {
  const api = opts.api ?? apiBase()
  const doFetch: Fetcher = opts.fetch ?? ((url, init) => fetch(url, init))
  try {
    const response = await doFetch(`${api}/api/v1/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email, code }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    })
    const body = (await response.json().catch(() => undefined)) as
      | { ok?: boolean; token?: string; api_key?: string; email?: string; error?: string }
      | undefined
    if (response.ok && body?.token) {
      return {
        ok: true,
        token: body.token,
        apiKey: body.api_key,
        account: { email: body.email ?? email },
      }
    }
    const detail = body?.error ?? `HTTP ${response.status}`
    if (response.status >= 500) return { ok: false, reason: "network", detail }
    return { ok: false, reason: "invalid", detail }
  } catch (error) {
    return { ok: false, reason: "network", detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Sente-specific advice appended under teai.io account errors. The server's
 * text already says what happened; this says what to press next.
 * Returns undefined for every other error so unrelated failures stay untouched.
 */
export function loginHint(message: string | undefined, env: TeaiEnv = process.env) {
  if (!message) return undefined
  const site = siteBase(env)
  // Demo/anonymous: the engine sent no usable key (fresh install, revoked key,
  // or the launcher started before `te login` wrote the file).
  if (message.includes("こちらはデモです") || /アカウント登録から/.test(message)) {
    return `→ /login で teai.io の API キー(te_…)を貼ると、このセッションのまま切り替わります。キー発行: ${site}/dashboard#api-keys`
  }
  if (/api_key_monthly_limit_exceeded|reached its monthly limit/i.test(message)) {
    return `→ このキーの月次上限です。${site}/dashboard#api-keys で上限を上げる/外す、または /login で別のキーに切り替えられます。`
  }
  if (
    /insufficient[_ ]credits|insufficient_quota|credits? (?:exhausted|remaining: 0)|クレジット(?:が|残高が)?\s*(?:不足|0)/i.test(
      message,
    )
  ) {
    return `→ teai.io の残高不足です。チャージ: ${site}/pricing ・ 別アカウントのキーに切り替える: /login`
  }
  if (/invalid api key|invalid_api_key|api key.*(invalid|revoked|expired)|unauthorized/i.test(message)) {
    return `→ キーが無効です。${site}/dashboard#api-keys で発行し直し、/login で貼り直してください。`
  }
  return undefined
}

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
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const match = /^(?:export\s+)?TEAI_API_KEY\s*=\s*["']?([^"'\s]*)["']?/.exec(line)
    if (match) return match[1] || undefined
  }
  return undefined
}

/** Replace (or append) the TEAI_API_KEY line, keeping every other line intact. */
export function renderCredentials(existing: string, key: string) {
  const lines = existing ? existing.split(/\r?\n/) : []
  if (lines.length && lines[lines.length - 1] === "") lines.pop()
  let replaced = false
  const next = lines.map((raw) => {
    if (/^\s*(?:export\s+)?TEAI_API_KEY\s*=/.test(raw) && !replaced) {
      replaced = true
      return `TEAI_API_KEY=${key}`
    }
    return raw
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
    if (response.status >= 500) {
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
      headers: { "Content-Type": "application/json", Accept: "application/json" },
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

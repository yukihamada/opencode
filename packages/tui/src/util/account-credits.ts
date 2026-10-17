import type { Provider } from "@sente-ai/sdk/v2"

export const CREDITS_PER_USD = 900

export function formatCreditAmount(value: number, language: string, unit: "cr" | "USD" = "cr") {
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: 2 })
  const money = new Intl.NumberFormat(language, { style: "currency", currency: "USD" })
  if (unit === "USD") return `${money.format(value)} (≈${number.format(value * CREDITS_PER_USD)} cr)`
  return `${number.format(value)} cr (≈${money.format(value / CREDITS_PER_USD)})`
}

export type AccountCredits = {
  remaining: number
  used: number
}

export function creditAccount(provider: Provider | undefined) {
  if (!provider) return
  const key = provider.options.apiKey ?? provider.key
  if (typeof key !== "string" || !key.trim()) return
  const base = provider.options.baseURL ?? Object.values(provider.models)[0]?.api.url ?? "https://api.teai.io"
  if (typeof base !== "string") return
  const url = URL.parse(base)
  if (!url || url.username || url.password) return
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return
  return { key, url: new URL("/api/v1/auth/me", url.origin).href }
}

export async function fetchAccountCredits(account: { key: string; url: string }, signal: AbortSignal): Promise<AccountCredits> {
  const response = await fetch(account.url, {
    headers: { Authorization: `Bearer ${account.key}` },
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
  })
  if (!response.ok) throw new Error("Credit account request failed")
  const data = await response.json()
  if (data?.authenticated !== true ||
    typeof data.credits_remaining !== "number" || !Number.isFinite(data.credits_remaining) ||
    typeof data.credits_used !== "number" || !Number.isFinite(data.credits_used)) {
    throw new Error("Credit account response is unavailable")
  }
  return { remaining: data.credits_remaining, used: data.credits_used }
}

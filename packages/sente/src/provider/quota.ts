/**
 * teai.io の「API キー上限到達」(HTTP 402) を解釈する。
 *
 * teai は分/時/日/月ごとのクレジット上限を超えたキーに 402 を返す
 * (`error.code` = api_key_{minute,hourly,daily,monthly}_limit_exceeded)。
 * 窓は UTC の分/時/日/月の頭で区切られる(teai.io LimitPeriod::window_start)ので、
 * 再開可能時刻は「次の窓の頭」として手元で計算できる。Retry-After ヘッダは来ない。
 *
 * 402 は待っても即座には直らない(同じ窓の中では何度送っても 402)。再送を
 * 連打すると上限に達した鍵で毎回リクエストが飛び、supervisor(te loop / launchd)が
 * 再起動を繰り返す原因になる。ここで「上限到達」と判定したものは再試行しない。
 */

export type QuotaPeriod = "minute" | "hour" | "day" | "month" | "balance"

export type Quota = {
  period: QuotaPeriod
  code: string
  /** 再開可能になる時刻(epoch ms)。残高不足など時間で直らないものは undefined */
  resetAt?: number
}

const CODE_PERIOD: Record<string, QuotaPeriod> = {
  api_key_minute_limit_exceeded: "minute",
  api_key_hourly_limit_exceeded: "hour",
  api_key_daily_limit_exceeded: "day",
  api_key_monthly_limit_exceeded: "month",
}

/**
 * 402 でも上限/残高ではないもの。teai はキー無し(匿名)の呼び出しにデモ文言付きの 402 を返す
 * (`code` = anonymous_demo_only, `type` = signup_required)。これは「ログインが必要」であって
 * 残高不足ではないので、文言を差し替えず(TUI が原因別の案内を出す)Quota 扱いもしない。
 */
function signupRequired(body: any, text: string) {
  return body?.error?.code === "anonymous_demo_only" || body?.error?.type === "signup_required" || /anonymous_demo_only/.test(text)
}

const MESSAGE_PERIOD: Array<[RegExp, QuotaPeriod]> = [
  [/reached its per-minute limit/i, "minute"],
  [/reached its hourly limit/i, "hour"],
  [/reached its daily limit/i, "day"],
  [/reached its monthly limit/i, "month"],
]

function json(value: unknown): any {
  if (typeof value !== "string") return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/** 次の UTC 窓の頭(teai の window_start と同じ区切り) */
export function nextWindowStart(period: Exclude<QuotaPeriod, "balance">, now: number): number {
  const d = new Date(now)
  switch (period) {
    case "minute":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes() + 1)
    case "hour":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1)
    case "day":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
    case "month":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  }
}

/**
 * 402 の応答から上限の種類を取り出す。402 以外・判定できないものは undefined。
 * 本文の code を優先し、無ければ英文メッセージから推定する。
 */
export function detect(input: { statusCode?: number; responseBody?: string; message?: string }, now = Date.now()) {
  if (input.statusCode !== 402) return undefined
  const body = json(input.responseBody)
  const code = typeof body?.error?.code === "string" ? body.error.code : ""
  const text = [
    typeof body?.error?.message === "string" ? body.error.message : "",
    input.message ?? "",
    input.responseBody ?? "",
  ].join("\n")
  if (signupRequired(body, text)) return undefined
  const period =
    CODE_PERIOD[code] ??
    MESSAGE_PERIOD.find(([pattern]) => pattern.test(text))?.[1] ??
    // 402 で窓が分からないもの = 残高不足(insufficient credits 等)。時間では直らない
    "balance"
  return {
    period,
    code: code || (period === "balance" ? "insufficient_credits" : `api_key_${period}_limit_exceeded`),
    resetAt: period === "balance" ? undefined : nextWindowStart(period, now),
  } satisfies Quota
}

export function language(env: Record<string, string | undefined> = process.env): "ja" | "en" {
  const lang = env.SENTE_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || ""
  return /^ja/i.test(lang) ? "ja" : "en"
}

function clock(at: number, lang: "ja" | "en", timeZone?: string) {
  return new Intl.DateTimeFormat(lang === "ja" ? "ja-JP" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(at))
}

function wait(ms: number, lang: "ja" | "en") {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  if (minutes < 120) return lang === "ja" ? `約${minutes}分後` : `in about ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return lang === "ja" ? `約${hours}時間後` : `in about ${hours} h`
  const days = Math.round(hours / 24)
  return lang === "ja" ? `約${days}日後` : `in about ${days} days`
}

const LABEL = {
  ja: { minute: "1分あたり", hour: "1時間あたり", day: "1日あたり", month: "月間" },
  en: { minute: "per-minute", hour: "hourly", day: "daily", month: "monthly" },
} as const

/**
 * ユーザー向けの説明。何の上限か・いつ再開できるか・作業は保存済みで再開方法は何か。
 */
export function describe(
  quota: Quota,
  opts: { now?: number; lang?: "ja" | "en"; timeZone?: string; dashboard?: string } = {},
) {
  const now = opts.now ?? Date.now()
  const lang = opts.lang ?? language()
  const dashboard = opts.dashboard ?? "https://teai.io/dashboard#api-keys"
  if (quota.period === "balance") {
    return lang === "ja"
      ? `teai.io の残高が不足したため停止しました(自動再試行はしません)。作業内容はセッションに保存済みです。チャージ後に te resume で続きから再開できます: https://teai.io/pricing`
      : `Stopped: your teai.io balance is too low (no automatic retry). Your work is saved in this session — top up, then run te resume to continue: https://teai.io/pricing`
  }
  const at = quota.resetAt ?? now
  const label = LABEL[lang][quota.period]
  return lang === "ja"
    ? `この API キーの${label}の利用上限に達したため停止しました(自動再試行はしません)。${clock(at, lang, opts.timeZone)}(${wait(at - now, lang)})から再開できます。作業内容はセッションに保存済みです。再開: te resume ・上限の変更: ${dashboard}`
    : `Stopped: this API key hit its ${label} usage limit (no automatic retry). You can resume at ${clock(at, lang, opts.timeZone)} (${wait(at - now, lang)}). Your work is saved in this session. Resume with: te resume · change the limit: ${dashboard}`
}

export * as ProviderQuota from "./quota"

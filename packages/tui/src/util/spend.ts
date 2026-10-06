import { terminalLocale } from "./locale"

/**
 * Status-line spend: "this turn / today", shown in yen.
 *
 * Costs are recorded per assistant message in USD from the configured model rate
 * (an estimate, not a billed amount). teai.io sells credits at ¥1 = 6cr and prices
 * usage at 900cr per USD of model rate, so one USD of recorded cost is about ¥150.
 */
export const CREDITS_PER_YEN = 6
export const CREDITS_PER_USD = 900

export function yen(usd: number) {
  return (usd * CREDITS_PER_USD) / CREDITS_PER_YEN
}

type SpendMessage = { role: string; cost?: number; time: { created: number } }
type SpendSession = { id: string; cost?: number; time: { created: number; updated: number } }

function cost(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/** Local midnight of the day `now` falls in. */
export function startOfDay(now: number) {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Cost of every model call made for the latest user message. Undefined before the first one. */
export function turnCost(messages: readonly SpendMessage[]) {
  const start = messages.findLastIndex((message) => message.role === "user")
  if (start < 0) return undefined
  return messages.slice(start + 1).reduce((sum, message) => sum + (message.role === "assistant" ? cost(message.cost) : 0), 0)
}

/**
 * Today's spend across the sessions this screen knows about.
 *
 * - started today: the session total is all today's.
 * - started earlier, messages loaded: only the calls made since midnight.
 * - started earlier, used today, messages not loaded: today's share is unknown, so the
 *   result is marked `partial` (a lower bound) instead of guessing.
 */
export function todayCost(input: {
  sessions: readonly SpendSession[]
  messages: Readonly<Record<string, readonly SpendMessage[] | undefined>>
  now: number
}) {
  const since = startOfDay(input.now)
  let usd = 0
  let partial = false
  for (const session of input.sessions) {
    if (session.time.updated < since) continue
    if (session.time.created >= since) {
      usd += cost(session.cost)
      continue
    }
    const loaded = input.messages[session.id]
    if (!loaded) {
      if (cost(session.cost) > 0) partial = true
      continue
    }
    for (const message of loaded) {
      if (message.role === "assistant" && message.time.created >= since) usd += cost(message.cost)
    }
  }
  return { usd, partial }
}

const labels = {
  ja: { turn: "今回", today: "今日" },
  en: { turn: "turn", today: "today" },
}

export function formatYen(usd: number, locale = terminalLocale()) {
  const value = yen(usd)
  // Sub-¥10 turns are common on cheap models; one decimal keeps them from all reading "¥0".
  const digits = value > 0 && value < 10 ? 1 : 0
  // Plain "¥" + localized digits: Intl's ja-JP currency style emits the full-width "￥",
  // which takes two terminal columns and breaks the status line's alignment.
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: digits })
  return `¥${number.format(value)}`
}

/** "今回 ¥12 / 今日 ¥340" — undefined when nothing has been spent (free or unpriced models). */
export function spendLabel(
  input: { turn: number | undefined; today: { usd: number; partial: boolean } },
  locale = terminalLocale(),
) {
  if (cost(input.turn) === 0 && input.today.usd === 0 && !input.today.partial) return undefined
  const text = labels[locale.startsWith("ja") ? "ja" : "en"]
  const today = `${text.today} ${formatYen(input.today.usd, locale)}${input.today.partial ? "+" : ""}`
  if (input.turn === undefined) return today
  return `${text.turn} ${formatYen(input.turn, locale)} / ${today}`
}

import type { Language } from "../context/language"

// `/btw <question>` (alias `/side`): a quick side question about the running
// session. It is answered by a separate, tool-less request on the server and
// shown in a closable panel; nothing is added to the session.

export type BtwCommand = { type: "ask"; question: string } | { type: "empty" }

/** Parses `/btw …` and `/side …`. Other input (including `/btwx`) is undefined. */
export function parseBtwCommand(input: string): BtwCommand | undefined {
  const match = /^\/(?:btw|side)(?:\s+([\s\S]*))?$/.exec(input.trim())
  if (!match) return undefined
  const question = match[1]?.trim()
  return question ? { type: "ask", question } : { type: "empty" }
}

/**
 * Side answers are not session messages, so their cost is not in any session
 * total. The TUI keeps them in its KV state (`btw_spend`) so the status line's
 * "this turn / today" still includes them.
 */
export const SPEND_KEY = "btw_spend"
export type BtwSpend = { session: string; usd: number; time: number }

const KEEP_MS = 2 * 24 * 60 * 60 * 1000

function entries(value: unknown): BtwSpend[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is BtwSpend =>
      typeof item === "object" &&
      item !== null &&
      typeof item.session === "string" &&
      typeof item.usd === "number" &&
      Number.isFinite(item.usd) &&
      item.usd > 0 &&
      typeof item.time === "number",
  )
}

/** Appends one side answer's cost and drops entries older than two days. */
export function recordSpend(value: unknown, entry: BtwSpend) {
  const list = entries(value).filter((item) => entry.time - item.time < KEEP_MS)
  return entry.usd > 0 && Number.isFinite(entry.usd) ? [...list, entry] : list
}

/** Side cost since `since`, optionally only for one session. */
export function spendSince(value: unknown, input: { since: number; session?: string }) {
  return entries(value)
    .filter((item) => item.time >= input.since && (input.session === undefined || item.session === input.session))
    .reduce((sum, item) => sum + item.usd, 0)
}

const texts = {
  ja: {
    title: "ちょっと質問 (/btw)",
    thinking: "考え中…(メインの作業は止めていません)",
    empty: "回答が空でした。質問を変えるか、もう一度お試しください。",
    failed: "回答できませんでした",
    noSession: "/btw は会話を始めてから使えます。先に依頼を送ってください。",
    usage: "使い方: /btw <質問>  — 作業を止めずに、今の会話について横から質問します(履歴には残りません)",
    note: "履歴には残りません・読み取り専用",
    close: "esc で閉じる",
    retry: "r で再試行",
    command: "ちょっと質問(/btw <質問>・作業を止めず・履歴に残さない)",
  },
  en: {
    title: "Side question (/btw)",
    thinking: "Thinking… (the main task keeps running)",
    empty: "The answer was empty. Rephrase the question or try again.",
    failed: "Could not answer",
    noSession: "/btw needs a conversation. Send a request first.",
    usage: "Usage: /btw <question>  — ask about the current session without stopping it (not saved to history)",
    note: "Not saved to history · read-only",
    close: "esc to close",
    retry: "r to retry",
    command: "Side question (/btw <question>; does not stop the task or touch history)",
  },
}

export function btwText(language: Language) {
  return texts[language]
}

export type BtwResult =
  | { type: "answer"; text: string; usd: number; model: string }
  | { type: "empty"; usd: number; model: string }
  | { type: "error"; message: string }

type BtwClient = {
  session: {
    btw: (
      input: { sessionID: string; question: string },
      options?: { signal?: AbortSignal },
    ) => Promise<{
      data?: { text: string; providerID: string; modelID: string; cost: number; error?: string }
      error?: unknown
    }>
  }
}

function message(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (typeof error === "object" && error !== null) {
    const data = "data" in error ? (error as { data?: { message?: unknown } }).data : undefined
    if (typeof data?.message === "string") return data.message
    if ("message" in error && typeof error.message === "string") return error.message
    return JSON.stringify(error)
  }
  return String(error)
}

/** One side request. Never throws: transport and provider failures become `error`. */
export async function askBtw(
  client: BtwClient,
  input: { sessionID: string; question: string; signal?: AbortSignal },
): Promise<BtwResult> {
  const response = await client.session
    .btw({ sessionID: input.sessionID, question: input.question }, { signal: input.signal })
    .catch((error: unknown) => ({ data: undefined, error }))
  if (!response.data) return { type: "error", message: message(response.error ?? "no response") }
  const data = response.data
  if (data.error) return { type: "error", message: data.error }
  const model = data.modelID ? `${data.providerID}/${data.modelID}` : ""
  const usd = Number.isFinite(data.cost) && data.cost > 0 ? data.cost : 0
  if (!data.text.trim()) return { type: "empty", usd, model }
  return { type: "answer", text: data.text.trim(), usd, model }
}

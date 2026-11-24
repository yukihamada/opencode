import type { Language } from "../context/language"
import { formatSpend } from "./spend"

// `/btw <question>` (alias `/side`): a quick side question about the running
// session. It is answered by a separate, tool-less request on the server and
// shown in a closable panel; nothing is added to the conversation. The server
// records its cost on the session (metadata `btw_spend`), which the status
// line, the sidebar and the cost limit all read.

export type BtwCommand = { type: "ask"; question: string } | { type: "empty" }

/** Parses `/btw …` and `/side …`. Other input (including `/btwx`) is undefined. */
export function parseBtwCommand(input: string): BtwCommand | undefined {
  const match = /^\/(?:btw|side)(?:\s+([\s\S]*))?$/.exec(input.trim())
  if (!match) return undefined
  const question = match[1]?.trim()
  return question ? { type: "ask", question } : { type: "empty" }
}

/** One line for the panel header; the full question was already typed by the user. */
export function questionPreview(question: string, width: number) {
  const line = question.replace(/\s+/g, " ").trim()
  const max = Math.max(10, width)
  return Bun.stringWidth(line) <= max ? line : truncateWidth(line, max - 1) + "…"
}

function truncateWidth(text: string, width: number) {
  let out = ""
  for (const char of text) {
    if (Bun.stringWidth(out + char) > width) break
    out += char
  }
  return out
}

type Meta = { usd: number; model: string; fallback: boolean }
export type BtwResult =
  | ({ type: "answer"; text: string } & Meta)
  | ({ type: "empty" } & Meta)
  | ({ type: "error"; message: string; text: string } & Meta)
  | { type: "approval"; spent: number; limit: number; estimate?: number; model: string; fallback: boolean }

export type BtwModelRef = { providerID: string; modelID: string }

type BtwClient = {
  session: {
    btw: (
      input: { sessionID: string; question: string; main?: BtwModelRef; approve?: boolean },
      options?: { signal?: AbortSignal },
    ) => Promise<{
      data?: {
        text: string
        providerID: string
        modelID: string
        cost: number
        fallback?: boolean
        approval?: { spent: number; limit: number; estimate?: number }
        error?: string
      }
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

/** One side request. Never throws: transport and provider failures become `error` (keeping any partial answer). */
export async function askBtw(
  client: BtwClient,
  input: { sessionID: string; question: string; main?: BtwModelRef; approve?: boolean; signal?: AbortSignal },
): Promise<BtwResult> {
  const response = await client.session
    .btw(
      {
        sessionID: input.sessionID,
        question: input.question,
        ...(input.main ? { main: input.main } : {}),
        ...(input.approve ? { approve: true } : {}),
      },
      { signal: input.signal },
    )
    .catch((error: unknown) => ({ data: undefined, error }))
  const empty = { usd: 0, model: "", fallback: false }
  if (!response.data) return { type: "error", message: message(response.error ?? "no response"), text: "", ...empty }
  const data = response.data
  const model = data.modelID ? `${data.providerID}/${data.modelID}` : ""
  if (data.approval) return { type: "approval", ...data.approval, model, fallback: !!data.fallback }
  const meta = { usd: Number.isFinite(data.cost) && data.cost > 0 ? data.cost : 0, model, fallback: !!data.fallback }
  if (data.error) return { type: "error", message: data.error, text: data.text.trim(), ...meta }
  if (!data.text.trim()) return { type: "empty", ...meta }
  return { type: "answer", text: data.text.trim(), ...meta }
}

const texts = {
  ja: {
    title: "ちょっと質問 (/btw)",
    thinking: "考え中…(メインの作業は止めていません)",
    empty: "回答が空でした。質問を変えるか、もう一度お試しください。",
    failed: "回答できませんでした",
    partial: "途中まで届いた回答:",
    noSession: "/btw は会話を始めてから使えます。先に依頼を送ってください。",
    usage: "使い方: /btw <質問>  — 作業を止めずに、今の会話について横から質問します(履歴には残りません)",
    note: "履歴には残りません・読み取り専用",
    close: "esc で閉じる",
    retry: "r で再試行",
    command: "ちょっと質問(/btw <質問>・作業を止めず・履歴に残さない)",
    fallback: (model: string) => `小型モデルが無いため、メインのモデル ${model} で答えています(費用が高めです)`,
    approval: (spent: number, limit: number, estimate?: number) =>
      `この会話の記録済み費用 ${formatSpend(spent, "ja")} に今回の見積${estimate === undefined ? "(不明)" : ` ${formatSpend(estimate, "ja")}`}を足すと、確認ライン ${formatSpend(limit, "ja")} を超えます。`,
    approve: "y で今回だけ実行 / esc でやめる",
    approvalModel: (model: string) => `使うモデル: ${model}`,
  },
  en: {
    title: "Side question (/btw)",
    thinking: "Thinking… (the main task keeps running)",
    empty: "The answer was empty. Rephrase the question or try again.",
    failed: "Could not answer",
    partial: "Partial answer received:",
    noSession: "/btw needs a conversation. Send a request first.",
    usage: "Usage: /btw <question>  — ask about the current session without stopping it (not saved to history)",
    note: "Not saved to history · read-only",
    close: "esc to close",
    retry: "r to retry",
    command: "Side question (/btw <question>; does not stop the task or touch history)",
    fallback: (model: string) => `No small model is available, so the main model ${model} answered (more expensive)`,
    approval: (spent: number, limit: number, estimate?: number) =>
      `Recorded cost ${formatSpend(spent, "en")} plus this call's estimate${estimate === undefined ? " (unknown)" : ` ${formatSpend(estimate, "en")}`} crosses the ${formatSpend(limit, "en")} approval line.`,
    approve: "y to run once / esc to cancel",
    approvalModel: (model: string) => `Model: ${model}`,
  },
}

export function btwText(language: Language) {
  return texts[language]
}

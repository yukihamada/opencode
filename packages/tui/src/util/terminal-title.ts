import type { Message, SessionStatus, Todo } from "@sente-ai/sdk/v2"
import stripAnsi from "strip-ansi"
import { terminalLocale } from "./locale"
import { isDefaultTitle } from "./session"

export type TerminalTaskState =
  | "ready"
  | "working"
  | "permission"
  | "question"
  | "retry"
  | "done"
  | "incomplete"
  | "stopped"
  | "error"
  | "loading"

type Language = "ja" | "en"

const labels: Record<Language, Record<TerminalTaskState, string>> = {
  ja: {
    ready: "待機",
    working: "実行中",
    permission: "確認待ち",
    question: "回答待ち",
    retry: "再試行",
    done: "完了",
    incomplete: "途中で停止",
    stopped: "停止",
    error: "エラー",
    loading: "読込中",
  },
  en: {
    ready: "Ready",
    working: "Working",
    permission: "Approval needed",
    question: "Answer needed",
    retry: "Retrying",
    done: "Done",
    incomplete: "Stopped early",
    stopped: "Stopped",
    error: "Error",
    loading: "Loading",
  },
}
// 🔔 marks the states where the task is waiting for the user, so a tab can be read at a glance.
const icons: Record<TerminalTaskState, string> = {
  ready: "○",
  working: "⏳",
  permission: "🔔❓",
  question: "🔔❓",
  retry: "↻",
  done: "🔔✅",
  incomplete: "🔔⚠️",
  stopped: "⏸",
  error: "🔔🔴",
  loading: "…",
}

function language(locale: string): Language {
  return locale.toLowerCase().startsWith("ja") ? "ja" : "en"
}

function defaultLocale() {
  return process.env.TE_LANG || terminalLocale()
}

export function terminalTaskState(input: {
  status?: SessionStatus
  messages?: readonly Message[]
  todos?: readonly Todo[]
  permission?: boolean
  question?: boolean
  error?: string
}): TerminalTaskState {
  if (input.permission) return "permission"
  if (input.question) return "question"
  if (input.error) return input.error === "MessageAbortedError" ? "stopped" : "error"
  if (input.status?.type === "retry") return "retry"
  if (input.status?.type === "busy") return "working"
  if (!input.messages) return "loading"
  const last = input.messages.at(-1)
  if (!last) return "ready"
  if (last.role === "user") return "stopped"
  if (last.error) return last.error.name === "MessageAbortedError" ? "stopped" : "error"
  if (!last.time.completed || !last.finish || ["tool-calls", "unknown"].includes(last.finish)) return "incomplete"
  if (input.todos?.some((todo) => todo.status === "pending" || todo.status === "in_progress")) return "incomplete"
  return "done"
}

/** States that hand the turn back to the user and are worth a terminal bell. */
export function terminalNeedsAttention(state: TerminalTaskState) {
  return ["permission", "question", "done", "incomplete", "error"].includes(state)
}

export function terminalIsRunning(state: TerminalTaskState) {
  return state === "working" || state === "retry"
}

function span(ms: number, lang: Language, exact: boolean) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) {
    const shown = exact ? seconds : Math.floor(seconds / 10) * 10
    return lang === "ja" ? `${shown}秒` : `${shown}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = seconds % 60
    if (exact && rest) return lang === "ja" ? `${minutes}分${rest}秒` : `${minutes}m ${rest}s`
    return lang === "ja" ? `${minutes}分` : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (lang === "ja") return rest ? `${hours}時間${rest}分` : `${hours}時間`
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

function estimate(ms: number, lang: Language) {
  if (ms < 60_000) return lang === "ja" ? "1分未満" : "<1m"
  return span(Math.round(ms / 60_000) * 60_000, lang, false)
}

function median(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** How long each finished turn of this session took: user message to the last completed reply. */
function turnDurations(messages: readonly Message[], before: number) {
  const result: number[] = []
  let started: number | undefined
  let completed: number | undefined
  const close = () => {
    if (started !== undefined && completed !== undefined && completed > started) result.push(completed - started)
  }
  for (const message of messages.slice(0, before)) {
    if (message.role === "user") {
      close()
      started = message.time.created
      completed = undefined
      continue
    }
    if (message.time.completed) completed = message.time.completed
  }
  close()
  return result
}

/**
 * Progress of the running turn, e.g. "3/7 · 残り約4分 · 経過2分".
 * The remaining time comes from the todo list when at least one item is finished; otherwise the
 * typical length of earlier turns in this session is shown as a guide. Both are estimates.
 */
export function terminalTaskProgress(
  input: { now: number; messages?: readonly Message[]; todos?: readonly Todo[]; exact?: boolean },
  locale = defaultLocale(),
) {
  const lang = language(locale)
  const messages = input.messages ?? []
  const index = messages.findLastIndex((message) => message.role === "user")
  if (index < 0) return
  const elapsed = Math.max(0, input.now - messages[index].time.created)
  const parts: string[] = []

  const todos = (input.todos ?? []).filter((todo) => todo.status !== "cancelled")
  const finished = todos.filter((todo) => todo.status === "completed").length
  if (todos.length > 0 && finished < todos.length) {
    parts.push(`${finished}/${todos.length}`)
    if (finished > 0) {
      const left = estimate((elapsed / finished) * (todos.length - finished), lang)
      parts.push(lang === "ja" ? `残り約${left}` : `~${left} left`)
    }
  }
  if (parts.length < 2) {
    const earlier = turnDurations(messages, index)
    if (earlier.length >= 2) {
      const typical = median(earlier)
      if (elapsed < typical) parts.push(lang === "ja" ? `目安${estimate(typical, lang)}` : `usually ${estimate(typical, lang)}`)
    }
  }
  if (input.exact || elapsed >= 10_000) {
    const shown = span(elapsed, lang, Boolean(input.exact))
    parts.push(lang === "ja" ? `経過${shown}` : `${shown} elapsed`)
  }
  return parts.length ? parts.join(" · ") : undefined
}

export function terminalTaskTitle(state: TerminalTaskState, title?: string, progress?: string, locale = defaultLocale()) {
  const clean = stripAnsi(title ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .trim()
  const name = !clean || isDefaultTitle(clean) ? "Sente" : clean
  const chars = Array.from(name)
  const short = chars.length > 40 ? chars.slice(0, 39).join("") + "…" : name
  const detail = progress ? ` ${progress}` : ""
  return `${icons[state]} ${labels[language(locale)][state]}${detail} | ${short}`
}

import type { Message, SessionStatus, Todo } from "@sente-ai/sdk/v2"
import stripAnsi from "strip-ansi"
import { terminalLocale } from "./locale"
import { isDefaultTitle } from "./session"

type State = "ready" | "working" | "permission" | "question" | "retry" | "done" | "stopped" | "error" | "loading"

const labels = {
  ja: {
    ready: "待機",
    working: "実行中",
    permission: "確認待ち",
    question: "回答待ち",
    retry: "再試行",
    done: "完了",
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
    stopped: "Stopped",
    error: "Error",
    loading: "Loading",
  },
}
const icons: Record<State, string> = {
  ready: "○",
  working: "●",
  permission: "⏳",
  question: "⏳",
  retry: "↻",
  done: "✅",
  stopped: "⏸",
  error: "🔴",
  loading: "…",
}

export function terminalTaskState(input: {
  status?: SessionStatus
  messages?: readonly Message[]
  todos?: readonly Todo[]
  permission?: boolean
  question?: boolean
  error?: string
}): State {
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
  if (!last.time.completed || !last.finish || ["tool-calls", "unknown"].includes(last.finish)) return "stopped"
  if (input.todos?.some((todo) => todo.status === "pending" || todo.status === "in_progress")) return "stopped"
  return "done"
}

export function terminalTaskTitle(state: State, title?: string, locale = process.env.TE_LANG || terminalLocale()) {
  const language = locale.toLowerCase().startsWith("ja") ? "ja" : "en"
  const clean = stripAnsi(title ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .trim()
  const name = !clean || isDefaultTitle(clean) ? "Sente" : clean
  const chars = Array.from(name)
  const short = chars.length > 40 ? chars.slice(0, 39).join("") + "…" : name
  return `${icons[state]} ${labels[language][state]} | ${short}`
}

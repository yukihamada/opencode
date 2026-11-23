import type { Language } from "../context/language"

// The server keeps a session's /goal in `metadata.goal` (packages/sente/src/session/goal.ts).
// The TUI only reads it for the footer and notices, and removes it for `/goal clear`.
const METADATA_KEY = "goal"

export type GoalInfo = {
  id: string
  objective: string
  status: "active" | "complete" | "paused"
  rounds: number
  maxRounds: number
  reason?: string
}

export function readGoal(metadata: Record<string, unknown> | undefined): GoalInfo | undefined {
  const raw = metadata?.[METADATA_KEY]
  if (!raw || typeof raw !== "object") return undefined
  const goal = raw as Partial<GoalInfo>
  if (typeof goal.id !== "string" || typeof goal.objective !== "string") return undefined
  if (goal.status !== "active" && goal.status !== "complete" && goal.status !== "paused") return undefined
  return {
    id: goal.id,
    objective: goal.objective,
    status: goal.status,
    rounds: typeof goal.rounds === "number" ? goal.rounds : 0,
    maxRounds: typeof goal.maxRounds === "number" ? goal.maxRounds : 20,
    reason: typeof goal.reason === "string" ? goal.reason : undefined,
  }
}

export function withoutGoal(metadata: Record<string, unknown> | undefined) {
  const next = { ...metadata }
  delete next[METADATA_KEY]
  return next
}

/// `/goal`(表示)と `/goal clear` は手元で処理する。条件付きと resume はサーバーの goal コマンドへ送る。
export function parseGoalCommand(input: string): { type: "show" } | { type: "clear" } | undefined {
  const match = /^\/goal(?:\s+(.*))?$/s.exec(input.trim())
  if (!match) return undefined
  const arg = match[1]?.trim().toLowerCase()
  if (!arg) return { type: "show" }
  if (["clear", "off", "stop", "cancel", "解除", "クリア"].includes(arg)) return { type: "clear" }
  return undefined
}

/// 入力欄の下に出す短い表示。進行中だけ出す。
export function goalLabel(goal: GoalInfo | undefined, language: Language) {
  if (goal?.status !== "active") return
  return language === "ja" ? `ゴール ${goal.rounds}/${goal.maxRounds}` : `goal ${goal.rounds}/${goal.maxRounds}`
}

export function describeGoal(goal: GoalInfo | undefined, language: Language) {
  const usage =
    language === "ja"
      ? "使い方: /goal <完了条件> | /goal clear | /goal resume"
      : "Usage: /goal <condition> | /goal clear | /goal resume"
  if (!goal) return language === "ja" ? `ゴールは設定されていません。\n${usage}` : `No goal is set.\n${usage}`
  const head =
    language === "ja"
      ? { active: "ゴール進行中", complete: "ゴール達成", paused: "ゴール停止中" }[goal.status]
      : { active: "Goal active", complete: "Goal met", paused: "Goal paused" }[goal.status]
  const progress =
    language === "ja" ? `継続 ${goal.rounds}/${goal.maxRounds}回` : `${goal.rounds}/${goal.maxRounds} rounds`
  return [`${head} (${progress}): ${goal.objective}`, goal.reason].filter(Boolean).join("\n")
}

/// 進行中のゴールが終わった時の通知。それ以外の変化では出さない。
export function goalSettledNotice(previous: GoalInfo | undefined, next: GoalInfo | undefined, language: Language) {
  if (previous?.status !== "active" || !next || next.id !== previous.id || next.status === "active") return
  const head =
    next.status === "complete"
      ? language === "ja"
        ? "ゴール達成"
        : "Goal met"
      : language === "ja"
        ? "ゴール停止"
        : "Goal paused"
  return {
    variant: next.status === "complete" ? ("success" as const) : ("warning" as const),
    message: `${head}: ${next.reason ?? next.objective}`,
  }
}

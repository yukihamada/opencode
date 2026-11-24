import type { Language } from "../context/language"

// The server keeps a session's /goal in `metadata.goal` (packages/sente/src/session/goal.ts).
// The TUI only reads it, for the label under the prompt, `/goal` and the end notice.
// Setting, resuming and clearing go to the server's `goal` command.
const METADATA_KEY = "goal"

/// Same text as the built-in command's description in packages/sente/src/command/index.ts.
export const BUILTIN_GOAL_DESCRIPTION =
  "完了条件を満たすまで自律で続ける / keep working until a condition is met [clear|resume]"

export type GoalInfo = {
  id: string
  objective: string
  status: "active" | "complete" | "paused"
  rounds: number
  maxRounds: number
  reason?: string
  budget: number
  spent: number
  judgeCost: number
}

const num = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback

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
    rounds: num(goal.rounds, 0),
    maxRounds: num(goal.maxRounds, 20),
    reason: typeof goal.reason === "string" ? goal.reason : undefined,
    budget: num(goal.budget, 3),
    spent: num(goal.spent, 0),
    judgeCost: num(goal.judgeCost, 0),
  }
}

/// `/goal` を手元で表示する。組み込みの goal コマンドか、ゴールが既にある時だけ。
/// 利用者独自の goal コマンドなら引数なしでもそのコマンドとして送る。
export function showsGoalLocally(input: string, command: { description?: string } | undefined, hasGoal: boolean) {
  if (!/^\/goal\s*$/.test(input.trim())) return false
  return hasGoal || !command || command.description === BUILTIN_GOAL_DESCRIPTION
}

const money = (value: number) => `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`

export function costLine(goal: GoalInfo, language: Language) {
  return language === "ja"
    ? `費用 ${money(goal.spent)} / 予算 ${money(goal.budget)}（うち判定 ${money(goal.judgeCost)}）`
    : `cost ${money(goal.spent)} of ${money(goal.budget)} (reviews ${money(goal.judgeCost)})`
}

/// 入力欄の下に出す短い表示。進行中だけ出す。
export function goalLabel(goal: GoalInfo | undefined, language: Language) {
  if (goal?.status !== "active") return
  const rounds = `${goal.rounds}/${goal.maxRounds}`
  return language === "ja"
    ? `ゴール ${rounds} · ${money(goal.spent)}/${money(goal.budget)}`
    : `goal ${rounds} · ${money(goal.spent)}/${money(goal.budget)}`
}

export function describeGoal(goal: GoalInfo | undefined, language: Language) {
  const usage =
    language === "ja"
      ? "使い方: /goal [--budget $N] [--max-rounds N] <完了条件> | /goal clear | /goal resume"
      : "Usage: /goal [--budget $N] [--max-rounds N] <condition> | /goal clear | /goal resume"
  if (!goal) return language === "ja" ? `ゴールは設定されていません。\n${usage}` : `No goal is set.\n${usage}`
  const head =
    language === "ja"
      ? { active: "ゴール進行中", complete: "ゴール達成", paused: "ゴール停止中" }[goal.status]
      : { active: "Goal active", complete: "Goal met", paused: "Goal paused" }[goal.status]
  const progress =
    language === "ja" ? `継続 ${goal.rounds}/${goal.maxRounds}回` : `${goal.rounds}/${goal.maxRounds} rounds`
  return [`${head} (${progress}, ${costLine(goal, language)}): ${goal.objective}`, goal.reason]
    .filter(Boolean)
    .join("\n")
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
    message: `${head}: ${next.reason ?? next.objective}\n${costLine(next, language)}`,
  }
}

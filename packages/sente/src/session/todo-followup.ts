export * as SessionTodoFollowup from "./todo-followup"

import { ProviderQuota } from "@/provider/quota"
import type { Info } from "./todo"

/**
 * Nudge the model to keep working when a turn ends while the todo list still has
 * unfinished items. The list used to be left stale: the turn finished, the
 * session looked done, but pending/in_progress todos were never closed.
 *
 * Bounded like output-limit continuation, because each follow-up is a billed
 * request and a model that never closes its todos must not loop forever.
 */
export const MAX_TODO_FOLLOWUPS = 2

/** `SENTE_TODO_FOLLOWUP=0` (or false/off/no) turns the follow-up off. */
export function enabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.SENTE_TODO_FOLLOWUP
  if (raw === undefined || raw.trim() === "") return true
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase())
}

/** Whether one more follow-up is allowed. `count` is the number already done. */
export function canFollowup(count: number, env: Record<string, string | undefined> = process.env): boolean {
  if (!enabled(env)) return false
  return Number.isInteger(count) && count >= 0 && count < MAX_TODO_FOLLOWUPS
}

/** Todos that still need work: not completed and not cancelled. */
export function unfinished(todos: ReadonlyArray<Info>): Info[] {
  return todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled")
}

export function note(count: number, remaining: number, lang: "ja" | "en" = ProviderQuota.language()): string {
  return lang === "ja"
    ? `未完了の作業が${remaining}件残っています。続行します（${count}/${MAX_TODO_FOLLOWUPS}回目）`
    : `${remaining} todo item(s) still open; continuing (${count}/${MAX_TODO_FOLLOWUPS})`
}

/** Synthetic user message that asks the model to finish or close its open todos. */
export function followupPrompt(
  todos: ReadonlyArray<Info>,
  lang: "ja" | "en" = ProviderQuota.language(),
): string {
  const list = todos.map((todo) => `- [${todo.status}] ${todo.content}`).join("\n")
  return lang === "ja"
    ? [
        "作業一覧に未完了の項目が残っています。",
        list,
        "",
        "残りを続けて完了させてください。実際に完了した項目は completed に、もう不要な項目は cancelled に更新し、最後に todowrite で作業一覧を最新にしてください。作業が本当に終わっていないのに completed にしないでください。",
      ].join("\n")
    : [
        "Your todo list still has unfinished items.",
        list,
        "",
        "Continue and finish the remaining work. Mark items that are truly done as completed and items that are no longer needed as cancelled, then update the list with todowrite. Do not mark work completed if it is not actually finished.",
      ].join("\n")
}

export * as SessionOutputLimit from "./output-limit"

import { ProviderQuota } from "@/provider/quota"

/**
 * Automatic continuation when a turn stops because the model hit its output
 * token limit (`finish === "length"`).
 *
 * The stream used to end the turn with a `MessageOutputLengthError` and wait
 * for someone to type "continue". The model usually has more to say, so run
 * the turn again with a synthetic user message that tells it to pick up where
 * it stopped — a bounded number of times, so a model that keeps producing
 * over-long turns cannot loop forever (each continuation is a billed request).
 */
export const MAX_OUTPUT_CONTINUES = 3

/** Whether one more continuation is allowed. `count` is the number already done. */
export function canContinue(count: number): boolean {
  return Number.isInteger(count) && count >= 0 && count < MAX_OUTPUT_CONTINUES
}

export function continueNote(count: number, lang: "ja" | "en" = ProviderQuota.language()): string {
  return lang === "ja"
    ? `出力上限に達したため自動で続きを生成します（${count}/${MAX_OUTPUT_CONTINUES}回目）`
    : `Output limit reached; continuing automatically (${count}/${MAX_OUTPUT_CONTINUES})`
}

/** Synthetic user message that asks the model to resume an over-long answer. */
export function continuePrompt(lang: "ja" | "en" = ProviderQuota.language()): string {
  return lang === "ja"
    ? "前回の回答が出力トークン上限に達して途中で切れました。切れた箇所の続きから再開してください。最初からやり直したり、同じ内容を繰り返したりしないでください。"
    : "Your previous response was cut off because it hit the output token limit. Resume from exactly where it stopped. Do not start over or repeat what you already wrote."
}

export * as DataPolicy from "./data-policy"

import type { ConfigV1 } from "@sente-ai/core/v1/config/config"
import { SessionV1 } from "@sente-ai/core/v1/session"
import { Glob } from "@sente-ai/core/util/glob"
import type { ModelMessage } from "ai"

export const BlockedError = SessionV1.DataPolicyBlockedError

export type Result = {
  readonly text: string
  readonly blocked: boolean
  readonly warnings: string[]
}

export type MessageResult = {
  readonly messages: ModelMessage[]
  readonly blocked: boolean
  readonly warnings: string[]
}

export function messages(list: ModelMessage[], config: ConfigV1.Info["dataPolicy"]): MessageResult {
  const warnings: string[] = []
  let blocked = false

  const messages = list.map((message): ModelMessage => {
    if (typeof message.content === "string") {
      const result = apply(message.content, config)
      warnings.push(...result.warnings)
      blocked ||= result.blocked
      return { ...message, content: result.text } as ModelMessage
    }
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "text") return part
        const result = apply(part.text, config)
        warnings.push(...result.warnings)
        blocked ||= result.blocked
        return { ...part, text: result.text }
      }),
    } as ModelMessage
  })

  return { messages, blocked, warnings }
}

export function apply(text: string, config: ConfigV1.Info["dataPolicy"]): Result {
  const mode = config?.mode ?? "off"
  if (mode === "off") return { text, blocked: false, warnings: [] }

  const masked = (config?.maskPatterns ?? []).reduce(
    (current, rule) => current.replace(new RegExp(rule.pattern, "g"), rule.replacement),
    text,
  )

  const warnings = (config?.denyPatterns ?? [])
    .filter((pattern) => new RegExp(pattern).test(masked))
    .map((pattern) => `data policy deny pattern matched: ${pattern}`)

  return {
    text: masked,
    blocked: mode === "block" && warnings.length > 0,
    warnings,
  }
}

export function blockedPath(filepath: string, config: ConfigV1.Info["dataPolicy"]): boolean {
  if ((config?.mode ?? "off") === "off") return false
  return (config?.denyPaths ?? []).some((pattern) => Glob.match(pattern, filepath))
}

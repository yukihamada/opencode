import type { AssistantMessage, Part, Provider } from "@sente-ai/sdk/v2"
import { name } from "./model"

export type ActualModel = {
  readonly model: string
  readonly reason?: string
}

const labels = {
  ja: { requested: "要求" },
  en: { requested: "requested" },
}

export function language() {
  return (process.env.TE_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "en").startsWith(
    "ja",
  )
    ? "ja"
    : "en"
}

export function requestedLabel() {
  return labels[language()].requested
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function actualModel(parts: readonly Part[]): ActualModel | undefined {
  const part = parts.findLast((part) => part.type === "step-finish")
  if (!part || part.type !== "step-finish") return
  const metadata: unknown = (part as { metadata?: unknown }).metadata
  if (!isRecord(metadata)) return
  const model = metadata.actualModel
  if (typeof model !== "string" || model.length === 0) return
  const reason = metadata.routeReason
  return { model, ...(typeof reason === "string" ? { reason } : {}) }
}

export function displayModel(input: {
  providers: Provider[] | ReadonlyMap<string, Provider> | undefined
  message: Pick<AssistantMessage, "providerID" | "modelID">
  parts: readonly Part[]
}) {
  const requested = name(input.providers, input.message.providerID, input.message.modelID)
  const actual = actualModel(input.parts)
  if (!actual || actual.model === input.message.modelID) return { label: requested, actual: undefined }
  const label = `${actual.model} (${requestedLabel()}: ${requested})`
  return { label: actual.reason ? `${label} · ${actual.reason}` : label, actual }
}

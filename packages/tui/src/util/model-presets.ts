import type { Model } from "@sente-ai/sdk/v2"
import { terminalLocale } from "./locale"

export const modelPresets = [
  { id: "everyday", ja: "お手軽", en: "Everyday", seed: "z-ai/glm-5.3-flash", family: /^z-ai\/glm-(\d+(?:\.\d+)*?)-flash$/, input: 0.07, output: 0.25 },
  { id: "coding", ja: "コツコツ開発", en: "Code", seed: "deepseek/deepseek-v4.1-flash", family: /^deepseek\/deepseek-v(\d+(?:\.\d+)*)-flash$/, input: 0.3, output: 1.2 },
  { id: "building", ja: "じっくり開発", en: "Build", seed: "tencent/hy4-preview", family: /^tencent\/hy(\d+(?:\.\d+)*)(?:-preview)?$/, input: 0.834, output: 2.501 },
  { id: "perspective", ja: "別の視点", en: "Another perspective", seed: "moonshotai/kimi-k3", family: /^moonshotai\/kimi-k(\d+(?:\.\d+)*)$/, input: 3, output: 15 },
  { id: "expert", ja: "難しい相談・設計", en: "Hard problems & design", seed: "openai/gpt-6-astra", family: /^openai\/gpt-(\d+(?:\.\d+)*)-astra$/, input: 10, output: 50 },
] as const

type Baseline = Pick<Model, "cost" | "capabilities" | "limit">
export type ModelFavorite = {
  providerID: string
  modelID: string
  presetID?: string
  baseline?: Baseline
}

export function presetName(id: string | undefined, locale = terminalLocale()) {
  const preset = modelPresets.find((item) => item.id === id)
  return preset?.[locale.startsWith("ja") ? "ja" : "en"]
}

export function presetLabels(locale = terminalLocale()) {
  return locale.startsWith("ja")
    ? { automatic: "同系列の後継へ自動更新", unavailable: "条件を満たすモデルがありません", section: "用途で選ぶ" }
    : { automatic: "Auto-update within this family", unavailable: "No eligible model available", section: "Choose by task" }
}

// Favorites keep a stable role and a concrete last-known model. Requests always use
// concrete IDs; an already selected conversation is never switched underneath it.
export function updateModelFavorite(item: ModelFavorite, models: Record<string, Model>, now = Date.now()): ModelFavorite {
  if (item.providerID !== "teai") return item
  const preset = modelPresets.find((preset) => item.presetID ? preset.id === item.presetID : preset.seed === item.modelID)
  if (!preset) return item
  const current = models[item.modelID]
  const baseline = item.baseline ?? current
  if (!baseline) return { ...item, presetID: preset.id }
  const saved: Baseline = JSON.parse(JSON.stringify({ cost: baseline.cost, capabilities: baseline.capabilities, limit: baseline.limit }))
  const candidates = Object.values(models).filter((model) => {
    if (!preset.family.test(model.id) || model.status !== "active") return false
    const release = Date.parse(model.release_date)
    if (!Number.isFinite(release) || release > now) return false
    const version = compareVersion(model.id, item.modelID, preset.family)
    if (version < 0 || (version === 0 && !(item.modelID.endsWith("-preview") && !model.id.endsWith("-preview")))) return false
    if (current && release < Date.parse(current.release_date)) return false
    if (!withinBudget(model, Math.min(preset.input, baseline.cost.input), Math.min(preset.output, baseline.cost.output))) return false
    return compatible(model, baseline)
  }).sort((a, b) => compareVersion(b.id, a.id, preset.family) || Number(a.id.endsWith("-preview")) - Number(b.id.endsWith("-preview")) || a.id.localeCompare(b.id))
  const next = candidates[0]
  if (!next) return { ...item, presetID: preset.id, baseline: saved }
  return {
    ...item,
    presetID: preset.id,
    modelID: next.id,
    baseline: JSON.parse(JSON.stringify({ cost: next.cost, capabilities: next.capabilities, limit: next.limit })),
  }
}

// A saved role stays selectable while its model is offered. The baseline only limits
// automatic moves to a successor: a catalog reprice once left a single usable preset.
export function availableFavorite(_item: ModelFavorite, model: Model | undefined) {
  return !!model && model.status !== "deprecated" && model.status !== "alpha"
}

function compatible(model: Model, baseline: Baseline) {
  if (!(model.limit.context >= baseline.limit.context && model.limit.output >= baseline.limit.output)) return false
  if (!((model.limit.input ?? model.limit.context) >= (baseline.limit.input ?? baseline.limit.context))) return false
  for (const key of ["toolcall", "reasoning", "attachment", "temperature"] as const) {
    if (baseline.capabilities[key] && !model.capabilities[key]) return false
  }
  for (const direction of ["input", "output"] as const) {
    for (const key of ["text", "image", "audio", "video", "pdf"] as const) {
      if (baseline.capabilities[direction][key] && !model.capabilities[direction][key]) return false
    }
  }
  return model.capabilities.toolcall && model.capabilities.input.text && model.capabilities.output.text
}

function withinBudget(model: Model, input: number, output: number) {
  const rates = [model.cost, ...(model.cost.tiers ?? []), ...(model.cost.experimentalOver200K ? [model.cost.experimentalOver200K] : [])]
  return rates.every((cost) => Number.isFinite(cost.input) && Number.isFinite(cost.output) && cost.input > 0 && cost.output > 0 && cost.input <= input && cost.output <= output)
}

function compareVersion(a: string, b: string, family: RegExp) {
  const av = family.exec(a)?.[1].split(".").map(Number) ?? []
  const bv = family.exec(b)?.[1].split(".").map(Number) ?? []
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0)
    if (diff) return diff
  }
  return 0
}

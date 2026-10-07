import { describe, expect, test } from "bun:test"
import type { Model } from "@sente-ai/sdk/v2"
import { availableFavorite, modelPresets, presetName, updateModelFavorite } from "../../src/util/model-presets"

function model(id = "deepseek/deepseek-v4.1-flash"): Model {
  return {
    id, providerID: "teai", name: id, api: { id, url: "https://example.test", npm: "@ai-sdk/openai-compatible" },
    capabilities: {
      temperature: true, reasoning: true, attachment: true, toolcall: true, interleaved: false,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    cost: { input: 0.3, output: 1.2, cache: { read: 0, write: 0 } },
    limit: { context: 1048576, output: 32768 }, status: "active", release_date: "2026-09-10", options: {}, headers: {},
  }
}
const now = Date.parse("2026-09-29")
const favorite = { providerID: "teai", modelID: "deepseek/deepseek-v4.1-flash" }

describe("task favorites", () => {
  test("migrates only the five seeds, preserving ordinary and other-provider favorites", () => {
    for (const preset of modelPresets) {
      const seed = model(preset.seed)
      expect(updateModelFavorite({ providerID: "teai", modelID: seed.id }, { [seed.id]: seed }, now).presetID).toBe(preset.id)
      expect(presetName(preset.id, "ja-JP")).toBe(preset.ja)
      expect(presetName(preset.id, "en-US")).toBe(preset.en)
    }
    const ordinary = { ...favorite, modelID: "another/model" }
    expect(updateModelFavorite(ordinary, {}, now)).toBe(ordinary)
    const other = { ...favorite, providerID: "openrouter" }
    expect(updateModelFavorite(other, {}, now)).toBe(other)
  })

  test("selects the newest numeric version, persists the role and is idempotent", () => {
    const seed = model()
    const next = model("deepseek/deepseek-v4.10-flash")
    const models = { [seed.id]: seed, [next.id]: next, "deepseek/deepseek-v4.9-flash": model("deepseek/deepseek-v4.9-flash") }
    const result = updateModelFavorite(favorite, models, now)
    expect(result.modelID).toBe(next.id)
    expect(result.presetID).toBe("coding")
    expect(updateModelFavorite(result, models, now)).toEqual(result)
    expect(favorite.modelID).toBe(seed.id)
  })

  test.each(["price", "tier", "unknownPrice", "nan", "tools", "images", "context", "output", "input", "future", "undated", "experimental", "deprecated"])("rejects %s regressions", (kind) => {
    const seed = model()
    const next = model("deepseek/deepseek-v5-flash")
    if (kind === "price") next.cost.input = 0.31
    if (kind === "tier") next.cost.experimentalOver200K = { ...next.cost, output: 3 }
    if (kind === "unknownPrice") next.cost.input = 0
    if (kind === "nan") next.cost.output = NaN
    if (kind === "tools") next.capabilities.toolcall = false
    if (kind === "images") next.capabilities.input.image = false
    if (kind === "context") next.limit.context = 32000
    if (kind === "output") next.limit.output = 4096
    if (kind === "input") next.limit.input = 1000
    if (kind === "future") next.release_date = "2099-01-01"
    if (kind === "undated") next.release_date = ""
    if (kind === "experimental") next.status = "beta"
    if (kind === "deprecated") next.status = "deprecated"
    expect(updateModelFavorite(favorite, { [seed.id]: seed, [next.id]: next }, now).modelID).toBe(seed.id)
  })

  test("excludes other families and expensive variants, never downgrades", () => {
    const seed = model()
    const models = Object.fromEntries([seed, model("deepseek/deepseek-v5-pro"), model("deepseek/deepseek-v5-flash-vision-exp"), model("other/deepseek-v5-flash"), model("deepseek/deepseek-v4-flash")].map((m) => [m.id, m]))
    expect(updateModelFavorite(favorite, models, now).modelID).toBe(seed.id)
  })

  test("retains a baseline across removal, recovers only to a compatible successor", () => {
    const seed = model()
    const stored = updateModelFavorite(favorite, { [seed.id]: seed }, now)
    const missing = updateModelFavorite(stored, {}, now)
    expect(availableFavorite(missing, undefined)).toBe(false)
    const next = model("deepseek/deepseek-v5-flash")
    expect(updateModelFavorite(missing, { [next.id]: next }, now).modelID).toBe(next.id)
    expect(updateModelFavorite(favorite, { [next.id]: next }, now).modelID).toBe(seed.id)
  })

  test("a catalog reprice keeps every saved preset selectable", () => {
    const saved = [["z-ai/glm-5.3-flash", 0.07343, 0.26225, 0.15, 0.5], ["deepseek/deepseek-v4.1-flash", 0.294, 1.176, 0.044, 0.3],
      ["tencent/hy4-preview", 0.81732, 2.45098, 0.834, 2.501], ["moonshotai/kimi-k3", 2.94, 14.7, 0.69, 15], ["openai/gpt-6-astra", 9.8, 49, 10, 50]] as const
    expect(saved.filter(([id, input, output, nextInput, nextOutput]) => {
      const before = { ...model(id), cost: { input, output, cache: { read: 0, write: 0 } } }
      const stored = updateModelFavorite({ providerID: "teai", modelID: id }, { [id]: before }, now)
      return availableFavorite(stored, { ...before, cost: { ...before.cost, input: nextInput, output: nextOutput } })
    }).length).toBe(5)
  })

  test("a later price increase never moves the preset to a successor above its saved budget", () => {
    const seed = model()
    const stored = updateModelFavorite(favorite, { [seed.id]: seed }, now)
    const next = { ...model("deepseek/deepseek-v5-flash"), cost: { ...seed.cost, output: 12 } }
    expect(updateModelFavorite(stored, { [seed.id]: seed, [next.id]: next }, now).modelID).toBe(seed.id)
  })

  test("HY4 preview can graduate to the stable release without changing its role", () => {
    const seed = model("tencent/hy4-preview")
    const next = model("tencent/hy4")
    expect(updateModelFavorite({ providerID: "teai", modelID: seed.id }, { [seed.id]: seed, [next.id]: next }, now).modelID).toBe(next.id)
  })

  test("capability changes to the current model keep the preset selectable but block successors", () => {
    const seed = model()
    const stored = updateModelFavorite(favorite, { [seed.id]: seed }, now)
    seed.capabilities.input.image = false
    expect(availableFavorite(stored, seed)).toBe(true)
    const next = model("deepseek/deepseek-v5-flash")
    next.capabilities.input.image = false
    expect(updateModelFavorite(stored, { [seed.id]: seed, [next.id]: next }, now).modelID).toBe(seed.id)
  })

  test("successor metadata updates cannot mutate the saved baseline", () => {
    const seed = model()
    const next = model("deepseek/deepseek-v5-flash")
    next.cost.output = 1
    const stored = updateModelFavorite(favorite, { [seed.id]: seed, [next.id]: next }, now)
    const snapshot = JSON.parse(JSON.stringify(stored.baseline))
    expect(stored.modelID).toBe(next.id)
    expect(availableFavorite(stored, next)).toBe(true)
    next.cost.output = 1.1
    expect(availableFavorite(stored, next)).toBe(true)
    next.cost.output = 1
    next.capabilities.input.image = false
    expect(availableFavorite(stored, next)).toBe(true)
    next.capabilities.input.image = true
    next.limit.context = 32000
    expect(availableFavorite(stored, next)).toBe(true)
    expect(stored.baseline).toEqual(snapshot)
  })

  test("missing, deprecated and alpha models remain unavailable for manual selection", () => {
    expect(availableFavorite(favorite, undefined)).toBe(false)
    for (const status of ["deprecated", "alpha"] as const) {
      expect(availableFavorite(favorite, { ...model(), status })).toBe(false)
    }
  })
})

import type { Model } from "@sente-ai/sdk/v2"
import { terminalLocale } from "./locale"

export const modelPresets = [
  { id: "everyday", ja: "文章・要約", en: "Write & summarize", legacy: "お手軽", seed: "z-ai/glm-5.3-flash", alias: "~z-ai/glm-flash-latest", number: "1", keywords: "" },
  { id: "coding", ja: "コード修正", en: "Fix code", legacy: "コツコツ開発", seed: "deepseek/deepseek-v4.1-flash", alias: "~deepseek/deepseek-flash-latest", number: "2", keywords: "" },
  { id: "building", ja: "機能開発", en: "Build features", legacy: "じっくり開発", seed: "tencent/hy4-preview", alias: "tencent/hy4-preview", number: "3", keywords: "" },
  { id: "perspective", ja: "レビュー・比較", en: "Review & compare", legacy: "別の視点", seed: "moonshotai/kimi-k3", alias: "~moonshotai/kimi-latest", number: "4", keywords: "" },
  { id: "expert", ja: "設計・相談", en: "Design & advice", legacy: "難しい相談・設計", seed: "openai/gpt-6-astra", alias: "~openai/gpt-astra-latest", number: "5", keywords: "難しい 相談 設計 判断 複雑 設計相談 difficult hard design advice decision complex architecture" },
  { id: "automatic", ja: "自動選択", en: "Auto-select", legacy: "自動", seed: "auto", alias: "auto", number: "0", keywords: "" },
] as const

export type ModelFavorite = {
  providerID: string
  modelID: string
  presetID?: string
  baseline?: Pick<Model, "cost" | "capabilities" | "limit">
}

export function presetName(id: string | undefined, locale = terminalLocale()) {
  return modelPresets.find((item) => item.id === id)?.[locale.startsWith("ja") ? "ja" : "en"]
}

export function presetDescription(id: string | undefined, locale = terminalLocale()) {
  const descriptions: Record<string, { ja: string; en: string }> = {
    everyday: { ja: "質問・要約・文章の下書き", en: "Questions, summaries and drafts" },
    coding: { ja: "小さな修正・日々の実装", en: "Small fixes and everyday coding" },
    building: { ja: "複数ファイルの実装・原因調査", en: "Multi-file changes and debugging" },
    perspective: { ja: "別案・レビュー・見落としの確認", en: "Alternatives, reviews and second opinions" },
    expert: { ja: "複雑な設計・判断の相談", en: "Complex design and decisions" },
    automatic: { ja: "モデルの振り分けを任せる", en: "Let the router choose a model" },
  }
  return id ? descriptions[id]?.[locale.startsWith("ja") ? "ja" : "en"] : undefined
}

export function modelCapabilityDetail(model: Model, locale = terminalLocale()) {
  const text = modelPickerText(locale)
  return [
    model.capabilities.input.image && text.image,
    model.capabilities.toolcall && text.tools,
    model.limit.context > 0 && `${text.context} ${new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(model.limit.context)}`,
  ].filter(Boolean).join(" · ")
}

export function availableModel(model: Model | undefined) {
  return !!model && model.status !== "deprecated" && model.status !== "alpha"
}

export function localModel(model: Model, baseURL?: unknown) {
  const endpoint = typeof baseURL === "string" ? baseURL : model.api.url
  if (!URL.canParse(endpoint)) return false
  const url = new URL(endpoint)
  return ["http:", "https:"].includes(url.protocol) &&
    (url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname))
}

export function resolvePresets(models: Record<string, Model>, favorites: ModelFavorite[]) {
  return modelPresets.map((preset) => {
    const saved = favorites.find((item) => item.providerID === "teai" && item.presetID === preset.id)
    // Saved choices are explicit. Only seed an unsaved role from the provider's rolling alias.
    const modelID = saved && availableModel(models[saved.modelID])
      ? saved.modelID
      : availableModel(models[preset.alias]) ? preset.alias : preset.seed
    return { ...saved, providerID: "teai", modelID, presetID: preset.id }
  })
}

export function modelPickerText(locale = terminalLocale()) {
  return locale.startsWith("ja")
    ? {
        title: "モデルを選ぶ", search: "モデル名・用途・接続先で検索", tasks: "用途で選ぶ",
        current: "使用中", image: "画像入力", tools: "ツール", context: "文脈長",
        noMatch: "一致するモデルがありません。別の名前や用途で検索してください。",
        favorites: "お気に入り", recent: "最近", more: "モデル一覧 /models", local: "ローカル",
        localTitle: "ローカルLLMを選ぶ", localEmpty: "ローカルモデルが未設定です。te ollama または te lmstudio で接続してください。",
        localRate: "ローカル接続 · 設定単価 0",
        recommended: "おすすめ順", price: "価格順", sort: "並び替え", unavailable: "利用可能なモデルがありません",
        rate: "設定単価 · USD/100万token", input: "入力", output: "出力", unknown: "単価未確認",
        curated: "おすすめ一覧", all: "全モデル", connect: "接続先を追加", providers: "接続先一覧",
        favorite: "お気に入り", popular: "主な接続先", arrows: "空欄で ← → 切替", previous: "前のモデル", next: "次のモデル",
      }
    : {
        title: "Select model", search: "Search models, tasks or providers", tasks: "Choose by task",
        current: "Current", image: "Image input", tools: "Tools", context: "Context",
        noMatch: "No matching models. Try another name or task.",
        favorites: "Favorites", recent: "Recent", more: "Models /models", local: "Local",
        localTitle: "Select local LLM", localEmpty: "No local models configured. Connect with te ollama or te lmstudio.",
        localRate: "Local connection · Configured rate 0",
        recommended: "Recommended", price: "Lowest price", sort: "Sort", unavailable: "No available model",
        rate: "Configured rate · USD/1M tokens", input: "in", output: "out", unknown: "Rate unavailable",
        curated: "Curated", all: "All models", connect: "Connect provider", providers: "View providers",
        favorite: "Favorite", popular: "Popular providers", arrows: "Empty: ← → switch", previous: "Previous model", next: "Next model",
      }
}

export function modelPrice(cost: { input: number; output: number } | undefined) {
  if (!cost || !Number.isFinite(cost.input) || !Number.isFinite(cost.output) ||
    cost.input < 0 || cost.output < 0 || (cost.input === 0 && cost.output === 0)) return Infinity
  return cost.input + cost.output
}

export function modelCostDetail(cost: { input: number; output: number } | undefined, locale = terminalLocale()) {
  const text = modelPickerText(locale)
  if (!cost || modelPrice(cost) === Infinity) return text.unknown
  const number = new Intl.NumberFormat(locale, { maximumSignificantDigits: 4 })
  return `${text.rate} · ${text.input} ${number.format(cost.input)} / ${text.output} ${number.format(cost.output)}`
}

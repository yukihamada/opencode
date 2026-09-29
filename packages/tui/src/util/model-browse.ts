import { terminalLocale } from "./locale"

export function modelBrowseText(locale = terminalLocale()) {
  return locale.startsWith("ja")
    ? { title: "モデルを選ぶ", search: "モデル名・用途で検索", recommended: "おすすめ順", price: "価格の安い順", recommendation: "用途プリセット → お気に入り → 最近 → その他", pricing: "設定単価：入力・出力 各100万tokenの合計（USD）・不明は末尾", sort: "並び替え", more: "すべてのモデル /models", arrows: "空欄で ← → 用途を切替", arrowsTyping: "→ で次のモデルへ", previous: "前のモデル", next: "次のモデル" }
    : { title: "Select model", search: "Search models or tasks", recommended: "Recommended", price: "Lowest price", recommendation: "Task presets → favorites → recent → other models", pricing: "Rate: 1M input + 1M output tokens (USD); unknown last", sort: "Sort order", more: "All models /models", arrows: "Empty prompt: ← → switch task", arrowsTyping: "→ next model", previous: "Previous model", next: "Next model" }
}

export function modelPrice(cost: { input: number; output: number } | undefined) {
  if (!cost || !Number.isFinite(cost.input) || !Number.isFinite(cost.output) ||
    cost.input < 0 || cost.output < 0 || (cost.input === 0 && cost.output === 0)) return Infinity
  return cost.input + cost.output
}

export function orderModels<T extends { rank: number; price: number; title: string }>(options: T[], order: "recommended" | "price") {
  return [...options].sort((a, b) => {
    // Compare rather than subtract so unknown (Infinity) rates sort deterministically.
    const first = order === "price" ? a.price : a.rank
    const second = order === "price" ? b.price : b.rank
    if (first !== second) return first < second ? -1 : 1
    if (a.rank !== b.rank) return a.rank - b.rank
    return a.title.localeCompare(b.title)
  })
}

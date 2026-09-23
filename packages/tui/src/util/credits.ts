import { readJson } from "./persistence"

/// `x-teai-credits-remaining` は API 応答ヘッダでしか返ってこないため、
/// provider 層が `last-route.json` に退避した値をここで読む。
/// まだ一度も推論していない起動直後は null になる（= 残高不明）。
export type LastRoute = {
  at: number
  auto_model: string | null
  auto_reason: string | null
  credits_remaining: number | null
}

/// 直前の応答ヘッダから分かっている残高。不明なら null。
///
/// ファイルが無い / 壊れている / 値が数値でない場合はすべて「不明」として
/// null を返す — 残高が読めないだけで警告を出さないのは、誤検知で
/// モデルの選択を邪魔しないため。
export async function creditsRemaining(file: string) {
  const route = await readJson<LastRoute>(file).catch(() => undefined)
  const value = route?.credits_remaining
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/// 高級モデルの判定しきい値（1M出力トークンあたりのクレジット）。
/// これを超えるモデルは「残高が少ない時に選ぶと危険」とみなして警告する。
export const PREMIUM_OUTPUT_COST_THRESHOLD = 15

/// 残高が「少ない」とみなすしきい値（クレジット）。
export const LOW_CREDITS_THRESHOLD = 10_000

/// 高級モデルかどうか。cost が取れないモデルは安全側に倒して false。
export function isPremiumModel(cost: { output?: number } | undefined | null) {
  return (cost?.output ?? 0) > PREMIUM_OUTPUT_COST_THRESHOLD
}

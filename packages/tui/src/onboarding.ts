// 🌱 初回起動チュートリアルの「見た」印。
// KV(~/.local/state/sente/kv.json)に置く。CLI 側の ~/.config/teai/intro-seen-*
// とは別管理(TUI は KV が正)。
// キー名を変えると既存ユーザーに再度チュートリアルが出るので、一度決めたら変えない。
export const ONBOARDING_KEY = "onboarding_completed"

// 表示条件: KV の読み込み完了を待つこと。KV は非同期なので ready を見ないと
// 「初回なのに出ない」「毎回出る」が起きる。
export function shouldShowOnboarding(kv: { ready: boolean; get: (key: string, fallback?: unknown) => unknown }) {
  if (!kv.ready) return false
  return !kv.get(ONBOARDING_KEY, false)
}

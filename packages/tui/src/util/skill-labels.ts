import type { Language } from "../context/language"

// Display copy only. Discovery, matching and execution retain the original skill ID and instructions.
const labels: Record<string, { ja: [string, string]; en: [string, string] }> = {
  "apple-login": { ja: ["Apple ログイン", "認証復旧とアプリ審査状況を確認"], en: ["Apple sign-in", "Restore access and check app review status"] },
  "ask-external-ai": { ja: ["外部AIに相談", "ChatGPT・Claude・Geminiへ質問"], en: ["Ask another AI", "Consult ChatGPT, Claude or Gemini"] },
  "bill-optimize": { ja: ["固定費を見直す", "携帯・光熱費・保険を年間総額で比較"], en: ["Lower recurring bills", "Compare mobile, utilities and insurance by annual cost"] },
  "consult-ai": { ja: ["開発の相談", "既存の相談ツールで設計・実装を検討"], en: ["Development advice", "Use the existing consultation tool for design and code"] },
  "customize-sente": { ja: ["先手の設定", "エージェント・スキル・権限を設定"], en: ["Customize Sente", "Configure agents, skills and permissions"] },
  docs: { ja: ["共有ドキュメント", "共同編集できる文書を作成・更新"], en: ["Shared documents", "Create and update collaborative documents"] },
  docx: { ja: ["Word文書", "文書の作成・編集・書式調整"], en: ["Word documents", "Create, edit and format Word files"] },
  "ekinet-reservation": { ja: ["えきねっと予約", "予約・空席・席種・交通系ICを確認"], en: ["Eki-net bookings", "Check reservations, seats and transit card links"] },
  "fb-messenger": { ja: ["Messengerの連絡", "メッセージ確認と返信を支援"], en: ["Messenger messages", "Check messages and prepare replies"] },
  "git-multi-session": { ja: ["並行開発のGit管理", "作業を分離し変更の競合を防ぐ"], en: ["Concurrent Git work", "Isolate work and protect changes across sessions"] },
  "import-memory": { ja: ["記憶を取り込む", "別のAIから書き出した記憶を追加"], en: ["Import memory", "Add memories exported from another assistant"] },
  "inquiry-sweep": { ja: ["未返信を確認", "メールとメッセージの要返信を照合"], en: ["Check unanswered inquiries", "Reconcile email and messaging reply status"] },
  "koe-narration-video": { ja: ["声で動画を作る", "本人声のナレーション制作と読み確認"], en: ["Voice narration and video", "Produce personal-voice narration and verify pronunciation"] },
  "koe-pod-ops": { ja: ["音声サーバーの復旧", "音声の遅延・停止・配備を診断"], en: ["Voice server operations", "Diagnose speech delays, outages and deployments"] },
  "line-messaging": { ja: ["LINE・Messenger", "新着確認・返信下書き・承認済み送信"], en: ["LINE and Messenger", "Check messages, draft replies and send approved messages"] },
  marketplace: { ja: ["売買のやり取り", "商品検索・出品・取引連絡を支援"], en: ["Marketplace trading", "Search products, prepare listings and coordinate trades"] },
  "missing-rewards": { ja: ["未付与の特典を探す", "ポイント・マイルの条件と明細を照合"], en: ["Find missing rewards", "Reconcile points and miles against eligibility and activity"] },
  morning: { ja: ["朝のブリーフ", "朝のまとめを表示・定期設定"], en: ["Morning brief", "Show or schedule your morning briefing"] },
  pdf: { ja: ["PDFを扱う", "読取・結合・分割・作成・文字認識"], en: ["PDF files", "Read, merge, split, create and recognize text"] },
  "portfolio-kpi-improve": { ja: ["事業の指標を改善", "実測から売上・継続率の改善を検証"], en: ["Improve product metrics", "Verify revenue and retention improvements with evidence"] },
  pptx: { ja: ["プレゼン資料", "スライドの作成・編集・テンプレート調整"], en: ["Presentations", "Create and edit slides and templates"] },
  "price-adjustment": { ja: ["購入後の差額返金", "値下げ・価格保証の条件と期限を確認"], en: ["Post-purchase price adjustment", "Check price protection eligibility and deadlines"] },
  "price-restock-watch": { ja: ["値下げ・再入荷を確認", "正確な商品・在庫・送料込み価格を確認"], en: ["Price and restock checks", "Verify exact products, stock and delivered prices"] },
  "receipt-organizer": { ja: ["領収書を整理", "請求・支払・返金を分けて重複を照合"], en: ["Organize receipts", "Reconcile invoices, payments, refunds and duplicates"] },
  "refund-tracking": { ja: ["返金の状況確認", "返金通知とカード・銀行の反映を照合"], en: ["Track refunds", "Match refund notices to card and bank credits"] },
  "reservation-improve": { ja: ["予約条件を改善", "既存予約の総額・特典・変更条件を比較"], en: ["Improve a booking", "Compare total cost, benefits and change conditions"] },
  "second-opinion": { ja: ["設計の別意見", "外部AIの提案を実コードと実測で検証"], en: ["Design second opinion", "Validate external AI advice against code and measurements"] },
  "skill-creator": { ja: ["スキルを作る", "スキルの作成・改善・性能検証"], en: ["Create skills", "Create, improve and evaluate skills"] },
  "sns-posting": { ja: ["SNSの発信", "本人の素材から企画・投稿・反応確認"], en: ["Social publishing", "Plan, publish and measure content from your own material"] },
  "subscription-audit": { ja: ["サブスク・返金の棚卸し", "課金の根拠から見直し候補と回収状況を整理"], en: ["Subscription and refund audit", "Review billing evidence and track recovery candidates"] },
  "subscription-cancel": { ja: ["サブスクの更新停止", "契約と影響を確認し承認後に解約"], en: ["Stop subscription renewal", "Review the subscription and cancel after approval"] },
  "teai-model-pages": { ja: ["モデル紹介ページ", "料金・仕様・音声を反映して検証"], en: ["Model introduction pages", "Update and verify pricing, specifications and audio"] },
  "teai-web-publish": { ja: ["ウェブページの公開", "teaiのページを配備し本番反映を確認"], en: ["Publish web pages", "Deploy teai pages and verify production content"] },
  "travel-reservation": { ja: ["旅行の予約", "航空券・鉄道・宿泊の空きと総額を確認"], en: ["Travel reservations", "Check flight, rail and lodging availability and total cost"] },
  "warranty-support": { ja: ["保証・修理の相談", "購入証明と保証条件を照合して問い合わせ準備"], en: ["Warranty and repair support", "Check purchase evidence and warranty terms for support"] },
  "wise-transfer": { ja: ["Wise送金", "受取人・金額・手数料を照合して送金準備"], en: ["Wise transfers", "Verify recipients, amounts and fees before transferring"] },
  "x-post-and-schedule": { ja: ["Xの投稿・予約", "投稿文・予約時刻・反応を確認"], en: ["X posts and scheduling", "Prepare posts, schedule publication and check metrics"] },
  xlsx: { ja: ["表計算ファイル", "表の整理・計算・書式・グラフ作成"], en: ["Spreadsheets", "Clean data, calculate, format and chart spreadsheets"] },
}

export function localizedDescription(description: string | undefined, language: Language) {
  const text = description?.replace(/\s+/g, " ").trim() ?? ""
  const parts = text.split(/\s+\/\s+/)
  const japanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u
  const selected = parts.filter((part) => japanese.test(part) === (language === "ja")).join(" / ")
  return selected || (language === "ja" ? "日本語の説明は未登録です" : "English description is not available")
}

export function skillLabel(skill: { name: string; description?: string }, language: Language) {
  const entry = Object.hasOwn(labels, skill.name) ? labels[skill.name][language] : undefined
  return {
    title: entry?.[0] ?? skill.name,
    description: entry?.[1] ?? localizedDescription(skill.description, language),
  }
}

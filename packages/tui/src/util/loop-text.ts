import { Loop } from "./loop"
import { yen } from "./spend"

/** 円の概算(util/spend.ts と同じ換算)。 */
export function yenText(usd: number) {
  const value = yen(usd)
  if (value <= 0) return "¥0"
  if (value >= 10) return `¥${Math.round(value).toLocaleString("ja-JP")}`
  if (value >= 1) return `¥${value.toFixed(1)}`
  return `¥${Number(value.toPrecision(2))}`
}

export function loopText(language: "ja" | "en") {
  const limits = {
    min: Loop.formatInterval(Loop.MIN_INTERVAL_MS),
    settle: Loop.SETTLE_MS / 1000,
    expiry: Loop.DEFAULT_EXPIRY_MS / 3_600_000,
    maxDays: Loop.MAX_EXPIRY_MS / 86_400_000,
    runs: Loop.DEFAULT_MAX_RUNS,
    maxRuns: Loop.MAX_RUNS_LIMIT,
    budget: Loop.formatUsd(Loop.DEFAULT_BUDGET_USD),
    maxBudget: Loop.formatUsd(Loop.MAX_BUDGET_USD),
    loops: Loop.MAX_LOOPS,
  }
  if (language === "ja") {
    const usd = (value: number) => `${Loop.formatUsd(value)}(約${yenText(value)})`
    return {
      title: "ループ(このセッション内の繰り返し)",
      usage: `使い方: /loop 5分 依頼文  /loop 5m 依頼文  (最短${limits.min}・--max 回数・--for 期間・--budget ドル)。/loop stop [id|all]・/loop resume`,
      help: `/loop 5分 依頼 で同じ依頼を間隔ごとに送ります。生成中の回は飛ばし、既定${limits.expiry}時間・${limits.runs}回・1ループ${limits.budget}で終了(--for は最長${limits.maxDays}日)。上限は生成中も見ていて、超えたらその回を中断します(中断までの1ステップ分は超えることがあります。中断した回の操作は途中のままになることがあります。本人の依頼が会話に入っているときは会話を止めず、ループだけ終えます)。費用はループが送った依頼への応答だけで数えます。本文に --max 等を含めたいときは /loop 5m -- 依頼 のように -- の後に書きます。TUIを閉じると止まります。常時実行は /tasks。`,
      empty: "実行中のループはありません。",
      footer: (count: number, next: string | undefined, spent: number, paused?: "cost" | "error") =>
        `ループ ${count}件` +
        (next ? `・次回 ${next}` : paused === "cost" ? "・費用確認で停止中" : paused === "error" ? "・送信失敗で停止中" : "・停止中") +
        (spent > 0 ? `・${usd(spent)}` : ""),
      started: (input: { id: string; every: string; runs: number; until: string; budget: number; model: string }) =>
        `ループ ${input.id} を開始: ${input.every}ごと・最大${input.runs}回・上限${usd(input.budget)}・${input.until}まで。` +
        `約${limits.settle}秒後に1回目を送ります。モデルは ${input.model} で固定。止める: /loop stop ${input.id}`,
      rounded: `間隔は最短${limits.min}です。${limits.min}に切り上げました。`,
      tail: (input: { maxRuns: number; expiresIn: string; budget: number; keys: Loop.Capped[] }) =>
        "本文の末尾から読みました: " +
        input.keys.map((key) => ({ max: `回数${input.maxRuns}回(--max)`, for: `期間${input.expiresIn}(--for)`, budget: `上限${usd(input.budget)}(--budget)` })[key]).join("・") +
        "。依頼文に含めたい場合は /loop 5m -- 依頼 のように -- の後に書いてください。",
      costLine: (limit: number) =>
        `この会話の累計は費用確認ライン ${usd(limit)} を超えています。ループの毎回、承認が必要になります(/cost で変更できます)。`,
      abortedBudget: (id: string, spent: number) =>
        `ループ ${id} は上限に達したため、実行中の回を中断して終了しました(累計 ${usd(spent)})。中断した回の操作(ファイル編集など)は途中のままの場合があります。会話を確認してください。`,
      interjectedBudget: (id: string, spent: number) =>
        `ループ ${id} は上限に達したため終了しました(累計 ${usd(spent)})。本人の依頼が会話に入っているので、会話は止めていません。`,
      thirdBudget: (id: string, spent: number) =>
        `ループ ${id} は上限に達したため終了しました(累計 ${usd(spent)})。/goal などの自動継続が会話を続けているので、会話は止めていません(その費用はループに数えていません)。`,
      capped: (keys: Loop.Capped[]) =>
        keys
          .map((key) => ({ max: `回数は最大${limits.maxRuns}回`, for: `期間は最長${limits.maxDays}日`, budget: `上限は最大${limits.maxBudget}` })[key])
          .join("・") + "に丸めました。",
      stopped: (count: number) => (count ? `ループを${count}件止めました。` : "該当するループはありません。"),
      resumed: (count: number) => (count ? `ループを${count}件再開しました。` : "一時停止中のループはありません。"),
      waiting: (count: number) => `費用確認の承認待ちです(${count}件)。先に承認すると自動で再開します。`,
      autoResumed: (ids: string[]) => `費用確認が承認されたので、ループ ${ids.join(", ")} を再開しました。`,
      finished: (id: string, reason: Loop.FinishReason, spent: number) =>
        ({
          expired: `ループ ${id} は期限切れで終了しました(累計 ${usd(spent)})。`,
          max: `ループ ${id} は最大回数に達して終了しました(累計 ${usd(spent)})。`,
          budget: `ループ ${id} は上限に達したため終了しました(累計 ${usd(spent)})。`,
          stopped: `ループ ${id} を止めました。`,
        })[reason],
      pausedCost: (ids: string[]) =>
        `費用上限の確認が出たため、ループ ${ids.join(", ")} を一時停止しました。先に画面の確認で承認すると自動で再開します(拒否した場合は /loop resume で再開)。`,
      pausedError: (id: string) => `送信に${Loop.MAX_CONSECUTIVE_ERRORS}回続けて失敗したため、ループ ${id} を一時停止しました。/loop resume ${id} で再開。`,
      limit: `同時に動かせるループは${limits.loops}件までです。/loop stop で止めてから追加してください。`,
      needSession: "会話を開いてから /loop を実行してください。",
      needModel: "モデルを選んでから /loop を実行してください。",
      localCommand: "このスラッシュコマンドは手元の画面操作なので繰り返せません。依頼文かサーバー側のコマンドを指定してください。",
      invalid: {
        interval: "間隔を読み取れませんでした。間隔の後ろは空白か「ごとに」で区切ってください(例: /loop 5分 確認、/loop 5分ごとに確認、1時間半ごとに、5m、every 5m)。",
        prompt: "繰り返す依頼文を入れてください。",
        max: "--max は1以上の整数で指定してください。",
        for: "--for は期間で指定してください(例: 2h, 3日)。",
        budget: "--budget はドルの正の数で指定してください(例: 0.5, $2)。",
        nested: "/loop の中に /loop は入れられません。",
      },
      everyLabel: (interval: string) => `${interval}ごと`,
      runs: "回",
      skipped: "飛ばし",
      paused: "一時停止",
      pausedCostShort: "費用確認で停止中",
      pausedErrorShort: "送信失敗で停止中",
      next: "次回",
      select: "Enter で操作を選ぶ",
      stop: "このループを止める",
      resume: "再開する",
      back: "戻る",
      confirmStop: (id: string) => `ループ ${id} を止めますか?`,
      money: usd,
    }
  }
  const usd = Loop.formatUsd
  return {
    title: "Loops (repeat inside this session)",
    usage: `Usage: /loop 5m <prompt>  (min ${limits.min}, --max N, --for 2h, --budget USD). /loop stop [id|all], /loop resume`,
    help: `/loop 5m <prompt> resends a prompt on an interval. Runs that would overlap a busy turn are skipped; loops end after ${limits.expiry}h, ${limits.runs} runs or ${limits.budget} per loop by default (--for up to ${limits.maxDays}d). The budget counts only replies to the loop's own prompts, is checked while a run is generating, and the run is interrupted once it is exceeded (it can overshoot by one step and leave that turn's work half-done; if your own request is in the conversation, only the loop ends). To keep --max etc. in the prompt, put it after --: /loop 5m -- <prompt>. Loops stop when the TUI closes; use /tasks for always-on jobs.`,
    empty: "No loops are running.",
    footer: (count: number, next: string | undefined, spent: number, paused?: "cost" | "error") =>
      `${count} loop${count === 1 ? "" : "s"}` +
      (next ? ` · next ${next}` : paused === "cost" ? " · paused for cost approval" : paused === "error" ? " · paused after failures" : " · paused") +
      (spent > 0 ? ` · ${usd(spent)}` : ""),
    started: (input: { id: string; every: string; runs: number; until: string; budget: number; model: string }) =>
      `Loop ${input.id} started: every ${input.every}, up to ${input.runs} runs, budget ${usd(input.budget)}, until ${input.until}. ` +
      `First run in about ${limits.settle}s. Model fixed to ${input.model}. Stop: /loop stop ${input.id}`,
    rounded: `The minimum interval is ${limits.min}; rounded up.`,
    tail: (input: { maxRuns: number; expiresIn: string; budget: number; keys: Loop.Capped[] }) =>
      "Read from the end of the prompt: " +
      input.keys.map((key) => ({ max: `${input.maxRuns} runs (--max)`, for: `for ${input.expiresIn} (--for)`, budget: `budget ${usd(input.budget)} (--budget)` })[key]).join(", ") +
      ". To keep them in the prompt, put the prompt after --: /loop 5m -- <prompt>.",
    costLine: (limit: number) =>
      `This conversation is already past its cost approval line of ${usd(limit)}; every loop run will need approval (change it with /cost).`,
    abortedBudget: (id: string, spent: number) =>
      `Loop ${id} reached its budget; the running turn was interrupted (total ${usd(spent)}). Work from that turn (e.g. file edits) may be left half-done; check the conversation.`,
    interjectedBudget: (id: string, spent: number) =>
      `Loop ${id} reached its budget (total ${usd(spent)}). Your own request is in the conversation, so it was not interrupted.`,
    thirdBudget: (id: string, spent: number) =>
      `Loop ${id} reached its budget (total ${usd(spent)}). An automatic continuation such as /goal is running the conversation, so it was not interrupted (its cost is not counted toward the loop).`,
    capped: (keys: Loop.Capped[]) =>
      "Capped " +
      keys
        .map((key) => ({ max: `runs at ${limits.maxRuns}`, for: `duration at ${limits.maxDays} days`, budget: `budget at ${limits.maxBudget}` })[key])
        .join(", ") +
      ".",
    stopped: (count: number) => (count ? `Stopped ${count} loop${count === 1 ? "" : "s"}.` : "No matching loop."),
    resumed: (count: number) => (count ? `Resumed ${count} loop${count === 1 ? "" : "s"}.` : "No paused loops."),
    waiting: (count: number) => `Waiting for cost approval (${count}). Approve it first and the loop resumes automatically.`,
    autoResumed: (ids: string[]) => `Cost approved; resumed loop ${ids.join(", ")}.`,
    finished: (id: string, reason: Loop.FinishReason, spent: number) =>
      ({
        expired: `Loop ${id} expired (total ${usd(spent)}).`,
        max: `Loop ${id} reached its run limit (total ${usd(spent)}).`,
        budget: `Loop ${id} reached its budget (total ${usd(spent)}).`,
        stopped: `Loop ${id} stopped.`,
      })[reason],
    pausedCost: (ids: string[]) =>
      `Loop ${ids.join(", ")} paused because the task cost limit needs approval. Approve it first and the loop resumes automatically (if you reject, use /loop resume).`,
    pausedError: (id: string) => `Loop ${id} paused after ${Loop.MAX_CONSECUTIVE_ERRORS} failed sends. /loop resume ${id} to retry.`,
    limit: `At most ${limits.loops} loops can run at once. Stop one with /loop stop first.`,
    needSession: "Open a session before using /loop.",
    needModel: "Select a model before using /loop.",
    localCommand: "That slash command only acts on this screen and cannot be repeated. Use a prompt or a server command.",
    invalid: {
      interval: "Could not read the interval. Separate it from the prompt with a space (e.g. /loop 5m check, every 5m, 1h30m).",
      prompt: "Add the prompt to repeat.",
      max: "--max must be a positive integer.",
      for: "--for must be a duration (e.g. 2h, 3d).",
      budget: "--budget must be a positive USD amount (e.g. 0.5, $2).",
      nested: "A loop cannot contain /loop.",
    },
    everyLabel: (interval: string) => `every ${interval}`,
    runs: " runs",
    skipped: "skipped",
    paused: "paused",
    pausedCostShort: "paused for cost approval",
    pausedErrorShort: "paused after failures",
    next: "next",
    select: "Enter for actions",
    stop: "Stop this loop",
    resume: "Resume",
    back: "Back",
    confirmStop: (id: string) => `Stop loop ${id}?`,
    money: usd,
  }
}

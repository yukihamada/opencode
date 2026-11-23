import { Loop } from "./loop"

export function loopText(language: "ja" | "en") {
  const limits = {
    min: Loop.formatInterval(Loop.MIN_INTERVAL_MS),
    expiry: Loop.DEFAULT_EXPIRY_MS / 3_600_000,
    maxDays: Loop.MAX_EXPIRY_MS / 86_400_000,
    runs: Loop.DEFAULT_MAX_RUNS,
    loops: Loop.MAX_LOOPS,
  }
  if (language === "ja")
    return {
      title: "ループ(このセッション内の繰り返し)",
      usage: `使い方: /loop 5m 依頼文  (最短${limits.min}・--max 回数・--for 期間)。/loop stop [id|all]・/loop resume`,
      help: `/loop 5m 依頼 で同じ依頼を間隔ごとに送ります。生成中の回は飛ばし、既定${limits.expiry}時間・${limits.runs}回で終了(--for は最長${limits.maxDays}日)。TUIを閉じると止まります。常時実行は /tasks。`,
      empty: "実行中のループはありません。",
      footer: (count: number, next?: string) => `ループ中 ${count}件${next ? `・次回 ${next}` : "・一時停止"}`,
      started: (id: string, every: string, runs: number, until: string) =>
        `ループ ${id} を開始: ${every}ごと・最大${runs}回・${until}まで。止める: /loop stop ${id}`,
      rounded: `間隔は最短${limits.min}です。${limits.min}に切り上げました。`,
      stopped: (count: number) => (count ? `ループを${count}件止めました。` : "該当するループはありません。"),
      resumed: (count: number) => (count ? `ループを${count}件再開しました。` : "一時停止中のループはありません。"),
      finished: (id: string, reason: "expired" | "max" | "stopped") =>
        ({ expired: `ループ ${id} は期限切れで終了しました。`, max: `ループ ${id} は最大回数に達して終了しました。`, stopped: `ループ ${id} を止めました。` })[reason],
      pausedCost: (id: string) =>
        `費用上限の確認が出たため、ループ ${id} を一時停止しました。/cost で上限を確認し、/loop resume ${id} で再開できます。`,
      pausedError: (id: string) => `送信に${Loop.MAX_CONSECUTIVE_ERRORS}回続けて失敗したため、ループ ${id} を一時停止しました。/loop resume ${id} で再開。`,
      limit: `同時に動かせるループは${limits.loops}件までです。/loop stop で止めてから追加してください。`,
      needSession: "会話を開いてから /loop を実行してください。",
      needModel: "モデルを選んでから /loop を実行してください。",
      localCommand: "このスラッシュコマンドは手元の画面操作なので繰り返せません。依頼文かサーバー側のコマンドを指定してください。",
      invalid: {
        interval: "間隔を読み取れませんでした(例: 30s, 5m, 1h)。",
        prompt: "繰り返す依頼文を入れてください。",
        max: "--max は1以上の整数で指定してください。",
        for: "--for は期間で指定してください(例: 2h, 3d)。",
        nested: "/loop の中に /loop は入れられません。",
      },
      every: "ごと",
      runs: "回",
      skipped: "飛ばし",
      paused: "一時停止",
      next: "次回",
      select: "Enter で停止",
    }
  return {
    title: "Loops (repeat inside this session)",
    usage: `Usage: /loop 5m <prompt>  (min ${limits.min}, --max N, --for 2h). /loop stop [id|all], /loop resume`,
    help: `/loop 5m <prompt> resends a prompt on an interval. Runs that would overlap a busy turn are skipped; loops end after ${limits.expiry}h or ${limits.runs} runs by default (--for up to ${limits.maxDays}d). Loops stop when the TUI closes; use /tasks for always-on jobs.`,
    empty: "No loops are running.",
    footer: (count: number, next?: string) => `${count} loop${count === 1 ? "" : "s"}${next ? ` · next ${next}` : " · paused"}`,
    started: (id: string, every: string, runs: number, until: string) =>
      `Loop ${id} started: every ${every}, up to ${runs} runs, until ${until}. Stop: /loop stop ${id}`,
    rounded: `The minimum interval is ${limits.min}; rounded up.`,
    stopped: (count: number) => (count ? `Stopped ${count} loop${count === 1 ? "" : "s"}.` : "No matching loop."),
    resumed: (count: number) => (count ? `Resumed ${count} loop${count === 1 ? "" : "s"}.` : "No paused loops."),
    finished: (id: string, reason: "expired" | "max" | "stopped") =>
      ({ expired: `Loop ${id} expired.`, max: `Loop ${id} reached its run limit.`, stopped: `Loop ${id} stopped.` })[reason],
    pausedCost: (id: string) =>
      `Loop ${id} paused because the task cost limit needs approval. Check /cost, then /loop resume ${id}.`,
    pausedError: (id: string) => `Loop ${id} paused after ${Loop.MAX_CONSECUTIVE_ERRORS} failed sends. /loop resume ${id} to retry.`,
    limit: `At most ${limits.loops} loops can run at once. Stop one with /loop stop first.`,
    needSession: "Open a session before using /loop.",
    needModel: "Select a model before using /loop.",
    localCommand: "That slash command only acts on this screen and cannot be repeated. Use a prompt or a server command.",
    invalid: {
      interval: "Could not read the interval (e.g. 30s, 5m, 1h).",
      prompt: "Add the prompt to repeat.",
      max: "--max must be a positive integer.",
      for: "--for must be a duration (e.g. 2h, 3d).",
      nested: "A loop cannot contain /loop.",
    },
    every: "every",
    runs: "runs",
    skipped: "skipped",
    paused: "paused",
    next: "next",
    select: "Enter to stop",
  }
}

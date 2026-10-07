import type { TaskBudget } from "./task-budget"

export function taskText(locale: string) {
  return locale.startsWith("ja") ? {
    title: "仕事・予算・履歴", create: "仕事を登録", login: "本人ログイン（15分・このセッションのみ）", email: "メールアドレス", code: "メールの6桁コード",
    loading: "確認中…", refresh: "更新", empty: "登録済みの仕事はありません", goal: "目的（生成する文章）", criteria: "完了条件（1行に1件）",
    once: "単発", recurring: "定期", schedule: "実行間隔", interval: "間隔（分、1以上）", duration: "1回の制限時間（分、1〜1440）",
    expiry: "承認の有効期間（時間、最大744）", runLimit: "1回の予算上限（USD）", monthLimit: "月次予算上限（USD・UTC月）",
    card: "仕事の確認カード", approve: "この条件で承認・実行を有効化", cancel: "戻る", scope: "入力した目的・条件に沿う文章生成のみ",
    prohibited: "送信・購入・支払・削除・公開・外部ツール操作", stops: "予算上限・課金不明・時間切れ・成果確認待ち",
    boundary: "文章生成専用。外部操作は含みません。本人ログインから15分・この画面のセッション中だけ実行します。終了・セッション切替後は本人による再有効化が必要です。各回の成果確認まで次回は待機します。",
    registered: "登録済み。/tasks で結果と費用を確認できます。", session: "対象セッション", needSession: "仕事を登録する会話を開いてから /tasks を実行してください。",
    needLogin: "仕事の承認・実行にはこの画面の本人ログインが必要です。", failed: "操作を確認できませんでした", sent: "ログインコードを送信しました。",
    history: "実行履歴・結果", result: "保存済みの結果", confirm: "成果を確認して完了にする", evidence: "各完了条件の確認根拠（同じ順で1行ずつ）",
    resume: "同じ実行ID・残予算で続行", instruction: "残作業・修正指示", stop: "この仕事を停止", arm: "このセッションで実行を有効化", disarm: "この画面の自動実行を解除",
    spent: "確定費用", reserved: "予約中・課金不明", month: "今月", state: "状態", next: "次回予定", expires: "承認期限", time: "制限時間", price: "価格版",
    notified: "実行記録を保存しました。/tasks で結果を確認してください。", saved: "保存しました", noResult: "保存済みの生成結果はありません。履歴の状態・予約額を確認してください。",
    reason: "理由", budget: "上限", unknown: "未確認", armed: "実行有効", paused: "実行未有効", minutes: "分", details: "確認条件", invalid: "入力を確認してください。",
  } : {
    title: "Jobs, budgets & history", create: "Create job", login: "Owner login (15 minutes, this session only)", email: "Email address", code: "6-digit email code",
    loading: "Checking…", refresh: "Refresh", empty: "No registered jobs", goal: "Goal (text to generate)", criteria: "Completion criteria (one per line)",
    once: "One-off", recurring: "Recurring", schedule: "Schedule", interval: "Interval (minutes, at least 1)", duration: "Run time limit (minutes, 1–1440)",
    expiry: "Approval lifetime (hours, at most 744)", runLimit: "Per-run budget limit (USD)", monthLimit: "Monthly budget limit (USD, UTC month)",
    card: "Job confirmation card", approve: "Approve these terms & enable execution", cancel: "Back", scope: "Text generation from the supplied goal and criteria only",
    prohibited: "Sending, purchasing, paying, deleting, publishing, external tools", stops: "Budget limit, unknown charge, deadline, result verification",
    boundary: "Text generation only; no external actions. Execution lasts up to 15 minutes after owner login, in this live UI session. Closing or switching sessions requires explicit re-enabling. Each result must be confirmed before the next run.",
    registered: "Registered. Use /tasks to inspect results and charges.", session: "Session", needSession: "Open the conversation for this job, then use /tasks.",
    needLogin: "Use owner login on this screen to approve or execute jobs.", failed: "Could not confirm the operation", sent: "Login code sent.",
    history: "Run history & results", result: "Saved result", confirm: "Confirm evidence & mark complete", evidence: "Evidence for each criterion (one line each, same order)",
    resume: "Continue with the same run ID & remaining budget", instruction: "Remaining work / revision instructions", stop: "Stop this job", arm: "Enable execution in this session", disarm: "Disable automatic execution in this UI",
    spent: "Settled cost", reserved: "Reserved / unknown charge", month: "This month", state: "State", next: "Next due", expires: "Approval expires", time: "Time limit", price: "Price version",
    notified: "Run recorded. Inspect the result with /tasks.", saved: "Saved", noResult: "No saved generation result. Check the run state and reserved charges.",
    reason: "Reason", budget: "Limit", unknown: "Unknown", armed: "Execution enabled", paused: "Execution not enabled", minutes: "min", details: "Criteria", invalid: "Check the input.",
  }
}

export function cardText(card: TaskBudget.Card, locale: string) {
  const t = taskText(locale)
  const money = (n: number) => `${n.toLocaleString(locale)} cr`
  return [
    card.goal, `${t.details}:\n${card.criteria.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
    `${t.scope}: ${card.scope.join(" / ")}`, `${t.prohibited}: ${card.prohibited.join(" / ")}`,
    `${t.stops}: ${card.stop_conditions.join(" / ")}`, `${t.session}: ${card.session_id}`,
    `${t.runLimit}: ${money(card.run_limit)} · ${t.monthLimit}: ${money(card.month_limit)}`,
    `${t.schedule}: ${card.interval_ms === null ? t.once : `${card.interval_ms / 60_000} ${t.minutes}`}`,
    `${t.time}: ${card.duration_ms / 60_000} ${t.minutes}`,
    `${t.next}: ${new Date(card.first_at).toLocaleString(locale)} · ${t.expires}: ${new Date(card.expires_at).toLocaleString(locale)}`,
    `${t.price}: ${card.price_version}`, t.boundary,
  ].join("\n\n")
}

import { createMemo, createResource, For, onCleanup, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { Session } from "@sente-ai/sdk/v2"
import type { PromptRef } from "../../component/prompt"
import { DialogSessionList } from "../../component/dialog-session-list"
import { useSync } from "../../context/sync"
import { useSDK } from "../../context/sdk"
import { useEvent } from "../../context/event"
import { useRoute } from "../../context/route"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import { useTuiConfig } from "../../config"
import { SENTE_BASE_MODE, useBindings, useCommandShortcut } from "../../keymap"
import { terminalLocale } from "../../util/locale"

export function homeLabels(locale = terminalLocale()) {
  return locale.startsWith("ja")
    ? {
        previous: "前回の仕事", recent: "最近の仕事", open: "会話を開く", all: "履歴を見る",
        loading: "履歴を読み込み中…", error: "履歴を取得できませんでした", retry: "再読込",
        draft: "再開するには入力を空にしてください", start: "たとえば、こんな仕事から",
        busy: "実行中", retrying: "再試行待ち", permission: "承認待ち", question: "回答待ち",
        examples: ["このプロジェクトの次の一手を整理して", "この文章を短く、伝わりやすく直して", "失敗しているテストを調べて直して"],
      }
    : {
        previous: "Previous work", recent: "Recent work", open: "Open conversation", all: "Browse history",
        loading: "Loading history…", error: "Could not load history", retry: "Retry",
        draft: "Clear your draft to open previous work", start: "Try a task",
        busy: "Running", retrying: "Retrying", permission: "Approval needed", question: "Answer needed",
        examples: ["Help me decide the next step for this project", "Make this text shorter and clearer", "Find and fix the failing tests"],
      }
}

export function RecentWork(props: { prompt?: PromptRef; maxWidth: number }) {
  const sync = useSync()
  const sdk = useSDK()
  const event = useEvent()
  const route = useRoute()
  const dialog = useDialog()
  const { theme } = useTheme()
  const config = useTuiConfig()
  const dimensions = useTerminalDimensions()
  const labels = homeLabels()
  const shortcut = useCommandShortcut("home.resume")
  const query = createMemo(() => sync.ready ? JSON.stringify(sync.session.query()) : undefined)
  const [history, { refetch }] = createResource(query, async () => {
    return sdk.client.session.list({ roots: true, limit: 100, ...sync.session.query() }).then(
      (result) => ({ sessions: result.data ?? [], failed: !!result.error || !result.data }),
      () => ({ sessions: [] as Session[], failed: true }),
    )
  })
  onCleanup(event.on("session.created", () => { void refetch() }))
  onCleanup(event.on("session.updated", () => { void refetch() }))
  onCleanup(event.on("session.deleted", () => { void refetch() }))
  const ready = () => history.state === "ready" && !history()?.failed
  const sessions = createMemo(() => (history()?.sessions ?? [])
    .filter((item) => !item.parentID && item.time.archived === undefined)
    .toSorted((a, b) => b.time.updated - a.time.updated || b.id.localeCompare(a.id))
    .slice(0, 3))
  const empty = () => !!props.prompt && !props.prompt.current.input && props.prompt.current.parts.length === 0
  const available = () => route.data.type === "home" && dialog.stack.length === 0
  const enabled = () => available() && empty()
  function open(session: Session) {
    if (!ready() || !enabled()) return
    route.navigate({ type: "session", sessionID: session.id })
  }
  useBindings(() => ({
    mode: SENTE_BASE_MODE,
    commands: [{
      name: "home.resume", title: labels.open, category: "Session", namespace: "palette",
      // Stay enabled while a draft exists so the leader sequence is consumed instead of
      // typing into the draft; open() refuses to leave home until the draft is cleared.
      enabled: () => ready() && sessions().length > 0 && available(),
      run: () => { const session = sessions()[0]; if (session) open(session) },
    }],
    bindings: config.keybinds.get("home.resume"),
  }))
  function status(id: string) {
    if (sync.data.permission[id]?.length) return labels.permission
    if (sync.data.question[id]?.length) return labels.question
    const value = sync.data.session_status[id]?.type
    if (value === "busy") return labels.busy
    if (value === "retry") return labels.retrying
    // Idle or missing status is not evidence of a completed task.
    return ""
  }
  const date = new Intl.DateTimeFormat(terminalLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  return (
    <box width="100%" maxWidth={props.maxWidth} paddingTop={1} flexShrink={0}>
      <Show when={history.loading || !query()}><text fg={theme.textMuted}>{labels.loading}</text></Show>
      <Show when={!history.loading && history()?.failed}>
        <text fg={theme.textMuted}>{labels.error}</text>
        <text id="home-history-retry" selectable={false} fg={theme.primary} onMouseUp={(e) => { if (e.button === 0) void refetch() }}>{labels.retry}</text>
      </Show>
      <Show when={ready()}>
        <Show when={sessions()[0]} fallback={
          <box>
            <text fg={theme.textMuted}>{labels.start}</text>
            <For each={labels.examples}>{(example, index) => (
              <text id={`home-example-${index()}`} selectable={false} fg={empty() ? theme.text : theme.textMuted} onMouseUp={(e) => {
                if (e.button !== 0 || !enabled()) return
                props.prompt?.set({ input: example, parts: [] })
                props.prompt?.focus()
              }}>{example}</text>
            )}</For>
          </box>
        }>{(previous) => (
          <box>
            <text fg={theme.textMuted}>{labels.previous}</text>
            <text id="home-previous-work" selectable={false} fg={empty() ? theme.primary : theme.textMuted} wrapMode="none" truncate onMouseUp={(e) => {
              if (e.button === 0) open(previous())
            }}>{previous().title.replace(/\s+/g, " ")}</text>
            <text fg={theme.textMuted}>{date.format(previous().time.updated)}{status(previous().id) ? ` · ${status(previous().id)}` : ""}</text>
            <text id="home-resume" selectable={false} fg={empty() ? theme.primary : theme.textMuted} onMouseUp={(e) => {
              if (e.button === 0) open(previous())
            }}>{empty() ? `${labels.open}${shortcut() ? `  ${shortcut()}` : ""}` : labels.draft}</text>
            <Show when={dimensions().height >= 30 && sessions().length > 1}>
              <text fg={theme.textMuted} marginTop={1}>{labels.recent}</text>
              <For each={sessions().slice(1)}>{(session) => (
                <text id={`home-recent-${session.id}`} selectable={false} fg={empty() ? theme.text : theme.textMuted} wrapMode="none" truncate onMouseUp={(e) => {
                  if (e.button === 0) open(session)
                }}>{session.title.replace(/\s+/g, " ")}</text>
              )}</For>
            </Show>
          </box>
        )}</Show>
      </Show>
      <Show when={!empty() || !ready() || sessions().length > 0}>
        <text id="home-history" selectable={false} fg={theme.textMuted} onMouseUp={(e) => {
          if (e.button === 0 && enabled()) dialog.replace(() => <DialogSessionList />)
        }}>{labels.all}</text>
      </Show>
    </box>
  )
}

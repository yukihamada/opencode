import type { TuiPlugin, TuiPluginApi } from "@sente-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show, createSignal } from "solid-js"
import { TodoItem } from "../../component/todo-item"

const id = "internal:sidebar-todo"
const labels = {
  ja: {
    title: "進捗",
    completed: "項目完了",
    cancelled: "取消",
    waiting: "本人待ち",
    permission: "次: 画面の許可リクエストを確認",
    question: "次: 画面の質問に回答",
    busy: "実行中",
    retry: "再試行待ち",
    idle: "停止中",
    unknown: "状態未確認",
    next: "次の項目",
    current: "現在",
    resume: "次: 残件を確認して続行を依頼",
    review: "次: 結果と証拠を確認",
    noTasks: "作業一覧なし",
    attempt: (count: number) => `（${count}回目）`,
  },
  en: {
    title: "Progress",
    completed: "items completed",
    cancelled: "cancelled",
    waiting: "Waiting for you",
    permission: "Next: review the permission request",
    question: "Next: answer the question",
    busy: "Working",
    retry: "Waiting to retry",
    idle: "Idle",
    unknown: "Status unavailable",
    next: "Next item",
    current: "Current",
    resume: "Next: review remaining work and ask to continue",
    review: "Next: review results and evidence",
    noTasks: "No task list",
    attempt: (count: number) => ` (attempt ${count})`,
  },
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const language = (
    process.env.TE_LANG ||
    process.env.LC_ALL ||
    process.env.LC_MESSAGES ||
    process.env.LANG ||
    "en"
  ).startsWith("ja")
    ? "ja"
    : "en"
  const text = labels[language]
  const number = new Intl.NumberFormat(language)
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.todo(props.session_id))
  const active = createMemo(() => list().filter((item) => item.status !== "cancelled"))
  const completed = createMemo(() => active().filter((item) => item.status === "completed").length)
  const remaining = createMemo(() => active().filter((item) => item.status !== "completed"))
  const current = createMemo(() => remaining().find((item) => item.status === "in_progress"))
  const status = createMemo(() => props.api.state.session.status(props.session_id)?.type)
  const attempt = createMemo(() => {
    const value = props.api.state.session.status(props.session_id)
    return value?.type === "retry" ? value.attempt : undefined
  })
  const waiting = createMemo(() => {
    if (props.api.state.session.permission(props.session_id).length) return "permission"
    if (props.api.state.session.question(props.session_id).length) return "question"
  })
  const show = createMemo(() => list().length > 0 || !!waiting() || status() === "busy" || status() === "retry")
  const next = createMemo(() => {
    const wait = waiting()
    if (wait) return text[wait]
    if (status() === "busy" || status() === "retry") return
    if (!status()) return
    if (remaining().length) return text.resume
    if (completed()) return text.review
  })

  return (
    <Show when={show()}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((x) => !x)}>
          <Show when={list().length > 2}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text}>
            <b>{text.title}</b>
          </text>
        </box>
        <text fg={waiting() ? theme().warning : theme().textMuted}>
          {waiting() ? text.waiting : text[status() ?? "unknown"]}
          {!waiting() && attempt() ? text.attempt(attempt()!) : ""}
        </text>
        <text fg={theme().textMuted}>
          {list().length
            ? `${number.format(completed())}/${number.format(active().length)} ${text.completed}`
            : text.noTasks}
          {list().length > active().length
            ? ` · ${number.format(list().length - active().length)} ${text.cancelled}`
            : ""}
        </text>
        <Show when={current() ?? remaining()[0]}>
          {(item) => (
            <text fg={theme().textMuted} wrapMode="word">
              {current() ? text.current : text.next}: {item().content}
            </text>
          )}
        </Show>
        <Show when={next()}>
          {(value) => (
            <text fg={theme().textMuted} wrapMode="word">
              {value()}
            </text>
          )}
        </Show>
        <Show when={list().length <= 2 || open()}>
          <For each={active()}>{(item) => <TodoItem status={item.status} content={item.content} compact />}</For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 400,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin

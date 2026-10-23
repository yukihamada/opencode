import type { AssistantMessage } from "@sente-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@sente-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { CREDITS_PER_USD } from "../../util/account-credits"

const id = "internal:sidebar-context"

const labels = {
  ja: { tokens: "トークン", remaining: "残り", spent: "費用", elapsed: "経過時間", used: "使用", context: "コンテキスト" },
  en: { tokens: "tokens", remaining: "remaining", spent: "Cost", elapsed: "Elapsed", used: "used", context: "Context" },
}

function elapsed(input: number) {
  const ms = Math.max(0, input)
  if (ms < 100) return "0s"
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000)
    const s = Math.floor((ms % 60_000) / 1000)
    return s ? `${m}m ${s}s` : `${m}m`
  }
  if (ms < 86_400_000) {
    const h = Math.floor(ms / 3_600_000)
    const m = Math.floor((ms % 3_600_000) / 60_000)
    return `${h}h ${m}m`
  }
  const d = Math.floor(ms / 86_400_000)
  const h = Math.floor((ms % 86_400_000) / 3_600_000)
  return `${d}d ${h}h`
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const language = (process.env.TE_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "en").startsWith("ja") ? "ja" : "en"
  const text = labels[language]
  const money = new Intl.NumberFormat(language, { style: "currency", currency: "USD" })
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)
  const parts = (id: string) => props.api.state.part?.(id) ?? []
  const [now, setNow] = createSignal(Date.now())
  const ticker = setInterval(() => setNow(Date.now()), 500)
  onCleanup(() => clearInterval(ticker))

  const state = createMemo(() => {
    const last = msg().findLast(
      (item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0 && item.summary !== true,
    )
    const model = last
      ? props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
      : undefined
    const limit = model?.limit.context ?? 0

    // After a compaction marker, the summary message carries only an estimate of
    // the compacted transcript until the next measured assistant turn arrives.
    const compactionIndex = msg().findLastIndex((item) => item.role === "user" && parts(item.id).some((p) => p.type === "compaction"))
    const compaction = compactionIndex >= 0 ? msg()[compactionIndex] : undefined
    const lastIndex = last ? msg().lastIndexOf(last) : -1
    if (compaction && lastIndex <= compactionIndex) {
      const summary = msg().find((item) => item.role === "assistant" && item.parentID === compaction.id)
      const source = summary ? parts(summary.id).filter((p) => p.type === "text").map((p) => ("text" in p ? p.text : "")).join("") : ""
      if (!source) return { used: "—", remaining: undefined as string | undefined, limit }
      const estimate = Math.ceil(source.length / 4) + 6
      const left = limit ? Math.max(0, limit - estimate) : undefined
      return {
        used: `~${estimate.toLocaleString()}`,
        remaining: left === undefined ? undefined : `~${left.toLocaleString()} ${text.tokens}`,
        limit,
      }
    }

    if (!last) return { used: "0", remaining: undefined as string | undefined, limit }
    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const left = limit ? Math.max(0, limit - tokens) : undefined
    return {
      used: tokens.toLocaleString(),
      remaining: left === undefined ? undefined : `${left.toLocaleString()} ${text.tokens}`,
      limit,
    }
  })

  const bar = createMemo(() => {
    const limit = state().limit
    const used = parseInt(state().used.replace(/[^0-9]/g, ""), 10)
    if (!limit || Number.isNaN(used)) return ""
    const width = 20
    const filled = Math.min(width, Math.round((used / limit) * width))
    return "█".repeat(Math.max(1, filled)) + "░".repeat(Math.max(0, width - filled))
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>{text.context}</b>
      </text>
      <text fg={theme().textMuted}>{text.used} {state().used}</text>
      <Show when={state().remaining}>
        <text fg={theme().textMuted}>{text.remaining} {state().remaining}</text>
      </Show>
      <Show when={bar()}>
        <text fg={theme().textMuted}>{bar()}</text>
      </Show>
      <text fg={theme().textMuted}>
        {text.spent} {money.format(cost())} (≈{Math.round(cost() * CREDITS_PER_USD).toLocaleString()} cr)
      </text>
      <Show when={session()}>
        <text fg={theme().textMuted}>{text.elapsed} {elapsed(now() - session()!.time.created)}</text>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
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

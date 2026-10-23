import type { TuiPlugin, TuiPluginApi } from "@sente-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { creditAccount, fetchAccountCredits, formatCreditAmount, type AccountCredits } from "../../util/account-credits"

const id = "internal:sidebar-credits"
const labels = {
  ja: { title: "残高", remaining: "保有", used: "累計使用", loading: "取得中", unknown: "未確認", disconnected: "teai未接続" },
  en: { title: "Credits", remaining: "Balance", used: "Used (total)", loading: "Loading", unknown: "Unavailable", disconnected: "teai not connected" },
}

function View(props: { api: TuiPluginApi }) {
  const language = (process.env.TE_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "en").startsWith("ja") ? "ja" : "en"
  const text = labels[language]
  const theme = () => props.api.theme.current
  const account = createMemo(() => creditAccount(props.api.state.provider.find((item) => item.id === "teai")))
  const [credits, setCredits] = createSignal<AccountCredits>()
  const [status, setStatus] = createSignal<"loading" | "unknown" | "disconnected">("loading")

  createEffect(() => {
    const current = account()
    setCredits(undefined)
    if (!current) {
      setStatus("disconnected")
      return
    }
    let request: AbortController | undefined
    async function refresh() {
      request?.abort()
      const controller = new AbortController()
      request = controller
      try {
        const value = await fetchAccountCredits(current!, controller.signal)
        if (!controller.signal.aborted) setCredits(value)
      } catch {
        if (controller.signal.aborted) return
        setCredits(undefined)
        setStatus("unknown")
      }
    }
    setStatus("loading")
    void refresh()
    const timer = setInterval(refresh, 60_000)
    // Billing is finalized by the time a provider turn has returned to idle.
    const unsubscribe = props.api.event.on("session.status", (event) => {
      if (event.properties.status.type === "idle") void refresh()
    })
    onCleanup(() => {
      clearInterval(timer)
      unsubscribe()
      request?.abort()
    })
  })

  return (
    <box>
      <text fg={theme().text}><b>{text.title}</b></text>
      <text fg={theme().textMuted}>{text.remaining}: {credits() ? formatCreditAmount(credits()!.remaining, language) : "—"}</text>
      <Show when={!credits()}><text fg={theme().textMuted}>{text[status()]}</text></Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 90,
    slots: { sidebar_content() { return <View api={api} /> } },
  })
}

const plugin: BuiltinTuiPlugin = { id, tui }
export default plugin

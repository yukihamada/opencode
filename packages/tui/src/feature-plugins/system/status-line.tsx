import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import type { TuiPlugin, TuiPluginApi } from "@sente-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { voiceState } from "../../util/voice"

const id = "internal:status-line"

// 現在のモデルはセッションの最新アシスタントメッセージの modelID から取る。
// TUI プラグイン API には「今選ばれているモデル」が露出しておらず、
// `~/.local/state/sente/model.json` の recent/favorite は「最後に使った順」
// であって現在の選択とは一致しない(実測: 現在 hy4 なのに recent[0] は astra)。
// まだ応答が無いセッションでは何も出さない(盛らない)。
function useModelName(api: TuiPluginApi, sessionID: () => string | undefined) {
  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((value) => value + 1), 2000)
  onCleanup(() => clearInterval(timer))

  return createMemo(() => {
    tick()
    const id = sessionID()
    if (!id) return undefined
    const messages = api.state.session.messages(id)
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message.role !== "assistant") continue
      const modelID = (message as { modelID?: string }).modelID
      if (modelID) return modelID.split("/").pop()
    }
    return undefined
  })
}

function View(props: { api: TuiPluginApi; sessionID: string | undefined }) {
  const model = useModelName(props.api, () => props.sessionID)
  const [voice, setVoice] = createSignal(voiceState())
  const timer = setInterval(() => setVoice(voiceState()), 2000)
  onCleanup(() => clearInterval(timer))
  const theme = () => props.api.theme.current

  return (
    <box flexDirection="row" gap={2} flexShrink={0}>
      <Show when={model()}>
        <text fg={theme().textMuted}>🤖 {model()}</text>
      </Show>
      <text fg={voice().muted || voice().envOff ? theme().textMuted : theme().primary}>
        {voice().muted || voice().envOff ? "🔇" : "🔊"}
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 10,
    slots: {
      session_prompt_right(_ctx, props) {
        return <View api={api} sessionID={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin

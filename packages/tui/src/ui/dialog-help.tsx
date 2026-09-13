import { TextAttributes } from "@opentui/core"
import { createMemo, For, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "./dialog"
import { useBindings, useCommandShortcut } from "../keymap"
import { voiceState } from "../util/voice"

// 主要なキーを「今の状態つき」で一覧する。キーバインドは設定で変えられるので、
// 説明文はハードコードせず useCommandShortcut で実際の割当を引いて表示する。
const rows = [
  { command: "koe.toggle", label: "声(KOE)の on/off", state: () => (voiceState().muted ? "OFF" : "ON") },
  { command: "model.cycle_recent", label: "モデルを次へ切替", state: () => "" },
  { command: "model.cycle_recent_reverse", label: "モデルを前へ切替", state: () => "" },
  { command: "model.list", label: "モデル一覧から選ぶ", state: () => "" },
  { command: "agent.cycle", label: "エージェント切替(Build/Plan)", state: () => "" },
  { command: "command.palette.show", label: "コマンド一覧", state: () => "" },
  { command: "session.list", label: "セッション一覧", state: () => "" },
  { command: "session.new", label: "新しいセッション", state: () => "" },
  { command: "session.interrupt", label: "今の応答を中断", state: () => "" },
  { command: "variant.cycle", label: "モデルの variant 切替", state: () => "" },
  { command: "sente.status", label: "ステータス表示", state: () => "" },
  { command: "theme.switch", label: "テーマ切替", state: () => "" },
  { command: "which-key.toggle", label: "キー一覧パネル(押すたび開閉)", state: () => "" },
] as const

function Row(props: { command: string; label: string; state: () => string }) {
  const shortcut = useCommandShortcut(props.command)
  const { theme } = useTheme()
  const state = createMemo(() => props.state())
  return (
    <box flexDirection="row" gap={2}>
      <box width={14} flexShrink={0}>
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
          {shortcut()}
        </text>
      </box>
      <box flexGrow={1}>
        <text fg={theme.text}>{props.label}</text>
      </box>
      <Show when={state()}>
        <text fg={theme.warning}>{state()}</text>
      </Show>
    </box>
  )
}

export function DialogHelp() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const commandShortcut = useCommandShortcut("command.palette.show")

  useBindings(() => ({
    bindings: [
      { key: "return", desc: "Close help", group: "Dialog", cmd: () => dialog.clear() },
      { key: "escape", desc: "Close help", group: "Dialog", cmd: () => dialog.clear() },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Help — よく使うキー
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc/enter
        </text>
      </box>
      <box flexDirection="column" gap={0}>
        <For each={rows}>{(row) => <Row command={row.command} label={row.label} state={row.state} />}</For>
      </box>
      <box paddingTop={1}>
        <text fg={theme.textMuted} wrapMode="word">
          {commandShortcut()} で全ての操作を検索できます。{useCommandShortcut("which-key.toggle")()} でキー一覧パネルを
          常時表示できます。キーは ~/.config/sente/tui.json の keybinds で変更できます。
        </text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={() => dialog.clear()}>
          <text fg={theme.selectedListItemText}>ok</text>
        </box>
      </box>
    </box>
  )
}

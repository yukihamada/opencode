import { useBindings } from "../../keymap"
import { useTheme } from "../../context/theme"

export function DialogVoice(props: { text: string; onSelect(): void }) {
  const { theme } = useTheme()
  useBindings(() => ({
    bindings: [{
      key: "1",
      desc: "Use original transcript in draft",
      group: "Voice",
      cmd: props.onSelect,
    }],
  }))
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <text fg={theme.text}>音声入力の確認</text>
      <scrollbox maxHeight={8}>
        <text fg={theme.text}>{props.text}</text>
      </scrollbox>
      <text fg={theme.textMuted}>文脈補正は未接続です。原文を確認してください。</text>
      <text fg={theme.primary} onMouseUp={() => props.onSelect()}>1 · 原文を下書きに反映（送信しない）</text>
      <text fg={theme.textMuted}>Esc · 破棄 / Enterでは反映・送信しません</text>
    </box>
  )
}

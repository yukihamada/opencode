import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import open from "open"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import { useDialog } from "./dialog"
import { useBindings, useCommandShortcut } from "../keymap"
import { ONBOARDING_KEY } from "../onboarding"

const steps = [
  { icon: "💬", label: "話しかける", detail: "日本語で「○○して」と打つか、声で頼むだけ" },
  { icon: "🎙", label: "自分の声にする", detail: "15秒の録音で、返事があなたの声になる" },
  { icon: "⚡", label: "先に動く", detail: "状況を見て、次の一手を自分から提案してくる" },
]

export function DialogOnboarding() {
  const dialog = useDialog()
  const kv = useKV()
  const { theme } = useTheme()
  const helpShortcut = useCommandShortcut("help.show")

  const finish = () => {
    kv.set(ONBOARDING_KEY, true)
    dialog.clear()
  }

  const enroll = () => {
    // 声の登録はブラウザで完結する(録音が要るため TUI 内ではできない)。
    // CLI の `te voice enroll` と同じ URL を開く。
    open("https://koe.live/enroll").catch(() => {})
  }

  useBindings(() => ({
    bindings: [
      { key: "return", desc: "Close onboarding", group: "Dialog", cmd: finish },
      { key: "escape", desc: "Close onboarding", group: "Dialog", cmd: finish },
      { key: "e", desc: "Enroll your voice", group: "Dialog", cmd: enroll },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          🌱 ようこそ Sente へ — はじめの3分
        </text>
        <text fg={theme.textMuted} onMouseUp={finish}>
          esc
        </text>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted} wrapMode="word">
          パソコンに話しかけるだけで作業を手伝ってくれる相棒です。むずかしい命令はいりません。
        </text>
      </box>
      <box flexDirection="column" gap={0}>
        <For each={steps}>
          {(step) => (
            <box flexDirection="row" gap={1}>
              <text fg={theme.text}>{step.icon}</text>
              <text fg={theme.text}>{step.label}</text>
              <text fg={theme.textMuted}>{step.detail}</text>
            </box>
          )}
        </For>
      </box>
      <box paddingTop={1}>
        <text fg={theme.textMuted} wrapMode="word">
          まずは話しかけてみてください。{helpShortcut()} でキー一覧、/models でモデルを選べます。
        </text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" gap={1} paddingBottom={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={enroll}>
          <text fg={theme.selectedListItemText}>e: 自分の声を登録</text>
        </box>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={finish}>
          <text fg={theme.selectedListItemText}>ok</text>
        </box>
      </box>
    </box>
  )
}

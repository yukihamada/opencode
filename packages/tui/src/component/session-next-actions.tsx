import { For, createSignal } from "solid-js"
import { useTheme } from "../context/theme"
import { Locale } from "../util/locale"
import { useBindings } from "../keymap"

export function SessionNextActions(props: { onSelect: (prompt: string) => void }) {
  const theme = useTheme().theme
  const japanese = (process.env.TE_LANG ?? Locale.terminalLocale()).toLowerCase().startsWith("ja")
  const [selected, setSelected] = createSignal<string>()
  const actions = japanese
    ? [
        {
          title: "次の一手を進める",
          prompt:
            "この結果を踏まえて、承認済みの範囲で次にやることを進めてください。判断や承認が必要なことは実行せず、先に確認してください。",
        },
        {
          title: "結果を確認・整理する",
          prompt: "今の結果を確認し、完了したこと・未完了のこと・確認が必要なことを短く整理してください。",
        },
        { title: "要点をまとめる", prompt: "ここまでの要点と、次に選べる行動を簡潔にまとめてください。" },
        { title: "別の相談を始める", prompt: "別の相談を始めたいです。" },
      ]
    : [
        {
          title: "Take the next step",
          prompt:
            "Based on this result, continue with the next steps that are already approved. Do not take actions that need my decision or approval; ask me first.",
        },
        {
          title: "Review the result",
          prompt: "Review this result and briefly list what is complete, what remains, and what needs my attention.",
        },
        {
          title: "Summarize the key points",
          prompt: "Briefly summarize the key points so far and the actions I can choose next.",
        },
        { title: "Start another topic", prompt: "I'd like to start a different topic." },
      ]

  useBindings(() => ({
    enabled: true,
    bindings: actions.map((action, index) => ({
      key: `alt+${index + 1}`,
      desc: action.title,
      group: japanese ? "次にやること" : "What next",
      cmd: () => props.onSelect(action.prompt),
    })),
  }))

  return (
    <box paddingTop={1} paddingBottom={1} paddingLeft={3} gap={1}>
      <text fg={theme.textMuted}>
        {japanese
          ? "次にやること（クリック、または⌥1〜4で入力欄へ）"
          : "What next? (Click or press Alt+1–4 to fill the prompt)"}
      </text>
      <For each={actions}>
        {(action, index) => (
          <box
            flexDirection="row"
            onMouseUp={() => props.onSelect(action.prompt)}
            onMouseOver={() => setSelected(action.title)}
            backgroundColor={selected() === action.title ? theme.backgroundElement : undefined}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={theme.primary}>{index() + 1}. </text>
            <text fg={theme.text}>{action.title}</text>
          </box>
        )}
      </For>
    </box>
  )
}

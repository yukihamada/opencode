import { useTheme } from "../context/theme"

export interface TodoItemProps {
  status: string
  content: string
  // 1行に収めて、はみ出しは切り捨てる(サイドバーの一覧用)
  compact?: boolean
}

export function TodoItem(props: TodoItemProps) {
  const { theme } = useTheme()

  return (
    <box
      flexDirection="row"
      gap={0}
      height={props.compact ? 1 : undefined}
      overflow={props.compact ? "hidden" : undefined}
    >
      <text
        flexShrink={0}
        style={{
          fg: props.status === "in_progress" ? theme.warning : theme.textMuted,
        }}
      >
        [{props.status === "completed" ? "✓" : props.status === "in_progress" ? "•" : " "}]{" "}
      </text>
      <text
        flexGrow={1}
        wrapMode={props.compact ? "none" : "word"}
        style={{
          fg: props.status === "in_progress" ? theme.warning : theme.textMuted,
        }}
      >
        {props.content}
      </text>
    </box>
  )
}

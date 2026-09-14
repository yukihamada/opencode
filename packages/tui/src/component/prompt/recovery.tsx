import { createMemo, Show } from "solid-js"
import type { PromptInfo } from "../../prompt/history"
import { usePromptStash } from "../../prompt/stash"
import { sendFailureText } from "../../prompt/send"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../config"
import { useDialog } from "../../ui/dialog"
import { SENTE_BASE_MODE, useBindings, useCommandShortcut } from "../../keymap"

export function PromptRecovery(props: {
  sessionID?: string
  enabled: boolean
  current: () => PromptInfo
  onRestore: (prompt: PromptInfo) => void
  locale?: string
}) {
  const stash = usePromptStash()
  const { theme } = useTheme()
  const config = useTuiConfig()
  const dialog = useDialog()
  const text = createMemo(() => sendFailureText(props.locale))
  const entries = createMemo(() =>
    stash.list().filter((entry) => entry.recovery?.sessionID === props.sessionID && entry.recovery),
  )
  const shortcut = useCommandShortcut("prompt.recover")
  const enabled = () => props.enabled && dialog.stack.length === 0 && entries().length > 0

  function restore() {
    if (!enabled()) return
    const id = entries().at(-1)?.recovery?.id
    if (!id) return
    const prompt = stash.recover(id, props.current())
    if (prompt) props.onRestore(prompt)
  }

  useBindings(() => ({
    mode: SENTE_BASE_MODE,
    enabled: enabled(),
    commands: [
      { name: "prompt.recover", title: text().recover, category: "Prompt", namespace: "palette", run: restore },
    ],
    bindings: config.keybinds.get("prompt.recover"),
  }))

  return (
    <Show when={entries().length > 0}>
      <box width="100%" paddingLeft={2} paddingRight={2} paddingBottom={1} backgroundColor={theme.backgroundElement}>
        <text fg={theme.warning} wrapMode="word">
          {text().pending(entries().length)}
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          {text().review}
        </text>
        <Show when={stash.saveError}>
          <text fg={theme.error} wrapMode="word">
            {text().volatile}
          </text>
        </Show>
        <box alignSelf="flex-start" onMouseUp={restore} paddingRight={1}>
          <text fg={enabled() ? theme.primary : theme.textMuted}>
            {text().recover}
            {shortcut() ? `  ${shortcut()}` : ""}
          </text>
        </box>
      </box>
    </Show>
  )
}

import { TextAttributes } from "@opentui/core"
import { createStore } from "solid-js/store"
import { For } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "../ui/dialog"
import { useBindings } from "../keymap"

export type DialogResumeChoice = "resume" | "fresh"

export type DialogResumeProps = {
  title: string
  message: string
  onChoose: (choice: DialogResumeChoice) => void
}

const OPTIONS: { key: DialogResumeChoice; label: string }[] = [
  { key: "fresh", label: "Start fresh" },
  { key: "resume", label: "Resume" },
]

/**
 * Shown on startup when the newest session in this directory was cut off.
 * Enter starts fresh (default) so a question typed at startup is never swallowed
 * as a resume; `r` resumes; ←/→ or Tab switch; Esc keeps the home screen.
 */
export function DialogResume(props: DialogResumeProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [store, setStore] = createStore({ active: "fresh" as DialogResumeChoice })
  const toggle = () => setStore("active", store.active === "resume" ? "fresh" : "resume")
  const choose = (choice: DialogResumeChoice) => {
    props.onChoose(choice)
    dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      { key: "return", desc: "Confirm", group: "Dialog", cmd: () => choose(store.active) },
      { key: "left", desc: "Previous option", group: "Dialog", cmd: toggle },
      { key: "right", desc: "Next option", group: "Dialog", cmd: toggle },
      { key: "tab", desc: "Next option", group: "Dialog", cmd: toggle },
      { key: "r", desc: "Resume", group: "Dialog", cmd: () => choose("resume") },
      { key: "n", desc: "Start fresh", group: "Dialog", cmd: () => choose("fresh") },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>{props.message}</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" gap={1} paddingBottom={1}>
        <For each={OPTIONS}>
          {(option) => (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={option.key === store.active ? theme.primary : undefined}
              onMouseUp={() => choose(option.key)}
            >
              <text fg={option.key === store.active ? theme.selectedListItemText : theme.textMuted}>
                {option.label}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}

DialogResume.show = (dialog: DialogContext, title: string, message: string) => {
  return new Promise<DialogResumeChoice | undefined>((resolve) => {
    dialog.replace(
      () => <DialogResume title={title} message={message} onChoose={resolve} />,
      () => resolve(undefined),
    )
  })
}

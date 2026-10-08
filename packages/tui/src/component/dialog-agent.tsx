import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useTuiConfig } from "../config"
import { agentNavigation, agentNavigationText, type AgentGroup } from "../util/agent-navigation"

type Choice = { agent: string } | { group: AgentGroup }

export function DialogAgent(props: { initialGroup?: AgentGroup } = {}) {
  const local = useLocal()
  const dialog = useDialog()
  const config = useTuiConfig()
  const text = agentNavigationText()
  const group = props.initialGroup ?? "home"
  const groups = createMemo(() => agentNavigation(local.agent.list(), config.agent_navigation))
  const options = createMemo<DialogSelectOption<Choice>[]>(() => [
    ...groups()[group].map((item) => ({
      value: { agent: item.agent.name }, title: item.title, description: item.agent.description,
    })),
    ...(group === "home"
      ? (["specialist", "project", "operation"] as const).filter((name) => groups()[name].length).map((name) => ({
          value: { group: name }, title: `${text[name]} →`,
        }))
      : [{ value: { group: "home" as const }, title: `← ${text.back}` }]),
  ])

  return (
    <DialogSelect<Choice>
      title={text[group]}
      placeholder={text.search}
      current={{ agent: local.agent.current()?.name ?? "" }}
      options={options()}
      footer={group === "operation" ? <text>{text.approval}</text> : undefined}
      onSelect={(option) => {
        if ("group" in option.value) {
          // Remount the selection list so a search for a group doesn't filter
          // out every entry of the newly opened group.
          const next = option.value.group
          dialog.replace(() => <DialogAgent initialGroup={next} />)
          return
        }
        local.agent.set(option.value.agent)
        dialog.clear()
      }}
    />
  )
}

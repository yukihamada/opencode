import { For } from "solid-js"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { availableModel, localModel, modelPickerText, modelPresets, presetName } from "../util/model-presets"
import { useDialog } from "../ui/dialog"
import { DialogModel } from "./dialog-model"

export function ModelPresets(props: { disabled?: boolean; onSelect: () => void }) {
  const local = useLocal()
  const sync = useSync()
  const { theme } = useTheme()
  const dialog = useDialog()
  const text = modelPickerText()
  function select(id: string) {
    if (props.disabled) return
    if (local.model.selectPreset(id)) props.onSelect()
  }
  const locals = () => sync.data.provider.flatMap((provider) => Object.values(provider.models).filter((model) =>
    availableModel(model) && localModel(model, sync.data.config.provider?.[provider.id]?.options?.baseURL ?? provider.options?.baseURL),
  ))
  function openLocal() {
    if (props.disabled) return
    dialog.replace(() => <DialogModel localOnly />)
  }

  useBindings(() => ({
    commands: [...modelPresets.map((preset) => ({
      name: `model.preset.${preset.id}`,
      namespace: "palette",
      title: presetName(preset.id),
      category: "Agent",
      hidden: props.disabled || local.model.presets().length === 0,
      slashName: preset.number,
      slashAliases: [preset.ja, preset.legacy, preset.id === "automatic" ? "model-auto" : preset.id],
      run: () => select(preset.id),
    })), {
      name: "model.local", namespace: "palette", title: text.localTitle, category: "Agent",
      hidden: props.disabled, slashName: "local-models", slashAliases: ["ローカル"], run: openLocal,
    }],
  }))

  return (
      <box flexDirection="row" flexWrap="wrap" gap={1} paddingTop={1}>
        <For each={local.model.presets()}>
          {(item) => {
            const selected = () => local.model.current()?.providerID === item.providerID && local.model.current()?.modelID === item.modelID
            const available = () => !props.disabled && availableModel(sync.data.provider.find((provider) => provider.id === item.providerID)?.models[item.modelID])
            return (
              <text
                id={`model-preset-${item.presetID}`}
                flexShrink={0}
                fg={available() ? selected() ? theme.primary : theme.text : theme.textMuted}
                onMouseUp={(event) => {
                  if (event.button !== 0) return
                  event.stopPropagation()
                  select(item.presetID)
                }}
              >
                {selected() ? "● " : ""}{presetName(item.presetID)} /{modelPresets.find((preset) => preset.id === item.presetID)?.number}
              </text>
            )
          }}
        </For>
        <text id="model-preset-local" flexShrink={0} fg={props.disabled ? theme.textMuted : theme.primary} onMouseUp={(event) => {
          if (event.button !== 0 || props.disabled) return
          event.stopPropagation()
          openLocal()
        }}>{locals().some((model) => model.providerID === local.model.current()?.providerID && model.id === local.model.current()?.modelID) ? "● " : ""}{text.local} ({locals().length})</text>
        <text id="model-preset-more" fg={theme.primary} onMouseUp={(event) => {
          if (event.button !== 0 || props.disabled) return
          event.stopPropagation()
          dialog.replace(() => <DialogModel />)
        }}>{text.more}</text>
      </box>
  )
}

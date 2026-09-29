import { For, Show } from "solid-js"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { availableFavorite, modelPresets, presetName } from "../util/model-presets"

export function ModelPresets(props: { disabled?: boolean; onSelect: () => void }) {
  const local = useLocal()
  const sync = useSync()
  const { theme } = useTheme()
  function select(id: string) {
    if (props.disabled) return
    if (local.model.selectPreset(id)) props.onSelect()
  }

  useBindings(() => ({
    commands: modelPresets.map((preset, index) => ({
      name: `model.preset.${preset.id}`,
      namespace: "palette",
      title: presetName(preset.id),
      category: "Agent",
      hidden: props.disabled || local.model.presets().length === 0,
      slashName: String(index + 1),
      slashAliases: [preset.ja, preset.id],
      run: () => select(preset.id),
    })),
  }))

  return (
    <Show when={local.model.presets().length > 0}>
      <box flexDirection="row" flexWrap="wrap" gap={1} paddingTop={1}>
        <For each={local.model.presets()}>
          {(item, index) => {
            const selected = () =>
              local.model.current()?.providerID === item.providerID &&
              local.model.current()?.modelID === item.modelID
            const available = () => !props.disabled && availableFavorite(
              item,
              sync.data.provider.find((provider) => provider.id === item.providerID)?.models[item.modelID],
            )
            return (
              <text
                id={`model-preset-${item.presetID}`}
                flexShrink={0}
                fg={available() ? selected() ? theme.primary : theme.text : theme.textMuted}
                onMouseUp={(event) => {
                  if (event.button !== 0) return
                  event.stopPropagation()
                  select(item.presetID!)
                }}
              >
                {selected() ? "● " : ""}{presetName(item.presetID)} /{index() + 1}
              </text>
            )
          }}
        </For>
      </box>
    </Show>
  )
}

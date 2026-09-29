import { createMemo, createSignal } from "solid-js"
import { useLocal } from "../context/local"
import { map, pipe, flatMap, entries, filter, sortBy, take } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { createDialogProviderOptions, DialogProvider } from "./dialog-provider"
import { DialogVariant } from "./dialog-variant"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"
import { useSync } from "../context/sync"
import { modelCostDetail } from "../util/model-cost"
import { availableFavorite, presetLabels, presetName, type ModelFavorite } from "../util/model-presets"
import { modelBrowseText, modelPrice, orderModels } from "../util/model-browse"
import { useTheme } from "../context/theme"

export function DialogModel(props: { providerID?: string }) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const [query, setQuery] = createSignal("")
  const [order, setOrder] = createSignal<"recommended" | "price">("recommended")
  const { theme } = useTheme()
  const text = modelBrowseText()
  const toggleOrder = () => { setOrder((value) => value === "recommended" ? "price" : "recommended") }

  const connected = useConnected()
  const providers = createDialogProviderOptions()

  const showExtra = createMemo(() => connected() && !props.providerID)

  const options = createMemo(() => {
    const needle = query().trim()
    const showSections = showExtra() && needle.length === 0 && order() === "recommended"
    const favorites = connected() ? local.model.favorite() : []
    const recents = local.model.recent()
    const presets = local.model.presets()

    function toOptions(items: ModelFavorite[], category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const provider = sync.data.provider.find((provider) => provider.id === item.providerID)
        if (!provider) return []
        const model = provider.models[item.modelID]
        if (!model && !item.presetID) return []
        const name = presetName(item.presetID)
        const available = availableFavorite(item, model)
        return [
          {
            key: item,
            value: { providerID: provider.id, modelID: item.modelID },
            title: name ?? model?.name ?? item.modelID,
            description: provider.name,
            details: [...(name ? [item.modelID, presetLabels().automatic] : []), modelCostDetail(model?.cost), ...(!available ? [presetLabels().unavailable] : [])],
            category: name ? presetLabels().section : category,
            disabled: provider.id === "sente" && item.modelID.includes("-nano"),
            footer: model?.cost?.input === 0 && provider.id === "sente" ? "Free" : undefined,
            onSelect: () => {
              if (available) onSelect(provider.id, item.modelID)
            },
          },
        ]
      })
    }

    const favoriteOptions = toOptions([...favorites].sort((a, b) => {
      const rank = (item: ModelFavorite) => {
        const index = presets.findIndex((preset) => preset.presetID === item.presetID)
        return index < 0 ? presets.length : index
      }
      return rank(a) - rank(b)
    }), "Favorites")
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      "Recent",
    )

    const providerOptions = pipe(
      sync.data.provider,
      sortBy(
        (provider) => provider.id !== "sente",
        (provider) => provider.name,
      ),
      flatMap((provider) =>
        pipe(
          provider.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          filter(([_, info]) => (props.providerID ? info.providerID === props.providerID : true)),
          map(([model, info]) => {
            const favorite = favorites.find((item) => item.providerID === provider.id && item.modelID === model)
            const name = presetName(favorite?.presetID)
            const available = !favorite || availableFavorite(favorite, info)
            const rank = presets.findIndex((item) => item.providerID === provider.id && item.modelID === model)
            return {
            value: { providerID: provider.id, modelID: model },
            title: name ?? info.name ?? model,
            search: `${model} ${info.name} ${presetName(presets[rank]?.presetID) ?? ""}`,
            rank: rank < 0 ? (favorite ? 10 : 20) : rank,
            price: modelPrice(info.cost),
            releaseDate: info.release_date,
            description: order() === "price" ? provider.name : favorites.some((item) => item.providerID === provider.id && item.modelID === model)
              ? "(Favorite)"
              : undefined,
            category: order() === "price" ? undefined : connected() ? provider.name : undefined,
            details: [...(name ? [model, presetLabels().automatic] : []), modelCostDetail(info.cost), ...(!available ? [presetLabels().unavailable] : [])],
            disabled: provider.id === "sente" && model.includes("-nano"),
            footer: info.cost?.input === 0 && provider.id === "sente" ? "Free" : undefined,
            onSelect() {
              if (available) onSelect(provider.id, model)
            },
          }}),
          filter((option) => {
            if (!showSections) return true
            if (
              favorites.some(
                (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
              )
            )
              return false
            if (
              recents.some(
                (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
              )
            )
              return false
            return true
          }),
          (options) => sortModelOptions(options, props.providerID !== undefined),
        ),
      ),
    )

    const popularProviders = !connected()
      ? pipe(
          providers(),
          map((option) => ({
            ...option,
            category: "Popular providers",
          })),
          take(6),
        )
      : []

    if (needle) {
      return [
        ...orderModels(
          fuzzysort.go(needle, providerOptions, { keys: ["title", "category", "search"] }).map((x) => x.obj),
          order(),
        ),
        ...fuzzysort.go(needle, popularProviders, { keys: ["title"] }).map((x) => x.obj),
      ]
    }

    return [...favoriteOptions, ...recentOptions, ...(order() === "price" ? orderModels(providerOptions, "price") : providerOptions), ...popularProviders]
  })

  const provider = createMemo(() =>
    props.providerID ? sync.data.provider.find((item) => item.id === props.providerID) : null,
  )

  const title = createMemo(() => {
    const value = provider()
    if (!value) return text.title
    return value.name
  })

  function onSelect(providerID: string, modelID: string) {
    local.model.set({ providerID, modelID }, { recent: true })
    const list = local.model.variant.list()
    const cur = local.model.variant.selected()
    if (cur === "default" || (cur && list.includes(cur))) {
      dialog.clear()
      return
    }
    if (list.length > 0) {
      dialog.replace(() => <DialogVariant />)
      return
    }
    dialog.clear()
  }

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      options={options()}
      placeholder={text.search}
      preserveSelection={true}
      titleView={
        <box flexDirection="column">
          <text fg={theme.text}>{title()}</text>
          <text id="model-sort-toggle" fg={theme.primary} onMouseUp={(event) => {
            if (event.button !== 0) return
            event.stopPropagation()
            toggleOrder()
          }}>{text.sort}: {order() === "recommended" ? text.recommended : text.price} (ctrl+s)</text>
          <text fg={theme.textMuted}>{order() === "price" ? text.pricing : text.recommendation}</text>
        </box>
      }
      bindings={[{ key: "ctrl+s", desc: text.sort, group: "Model", cmd: toggleOrder }]}
      actions={[
        {
          command: "model.dialog.provider",
          title: connected() ? "Connect provider" : "View all providers",
          onTrigger() {
            dialog.replace(() => <DialogProvider />)
          },
        },
        {
          command: "model.dialog.favorite",
          title: "Favorite",
          hidden: !connected(),
          onTrigger: (option) => {
            local.model.toggleFavorite(option.value as { providerID: string; modelID: string })
          },
        },
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      current={local.model.current()}
    />
  )
}

export function sortModelOptions<T extends { footer?: string; releaseDate: string | number; title: string }>(
  options: T[],
  newestFirst: boolean,
) {
  if (newestFirst) return sortBy(options, [(option) => option.releaseDate, "desc"], (option) => option.title)
  return sortBy(
    options,
    (option) => option.footer !== "Free",
    [(option) => option.releaseDate, "desc"],
    (option) => option.title,
  )
}

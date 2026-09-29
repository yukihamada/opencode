import { TextAttributes } from "@opentui/core"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { createResource, createMemo, createSignal } from "solid-js"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { errorMessage } from "../util/error"
import { useLanguage } from "../context/language"
import { skillLabel } from "../util/skill-labels"

export type DialogSkillProps = {
  onSelect: (skill: string) => void
}

export function DialogSkill(props: DialogSkillProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const { theme } = useTheme()
  const language = useLanguage()
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal<string>()
  dialog.setSize("large")

  const [loadError, setLoadError] = createSignal<unknown>()

  const [skills] = createResource(() =>
    sdk.client.app
      .skills({}, { throwOnError: true })
      .then((result) => result.data ?? [])
      // Catch so the rejected resource never reaches the memo below: reading
      // skills() in an errored state re-throws and tears down the dialog.
      .catch((error) => {
        setLoadError(error)
        return undefined
      }),
  )

  const showError = createMemo(() => Boolean(loadError()))

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    if (showError()) return []
    const list = skills() ?? []
    return list.map((skill) => ({
      ...skillLabel(skill, language.current()),
      value: skill.name,
      onSelect: () => {
        props.onSelect(skill.name)
        dialog.clear()
      },
    })).filter((option) => `${option.title} ${option.description} ${option.value}`.toLowerCase().includes(query().trim().toLowerCase()))
  })
  const active = createMemo(() => options().find((option) => option.value === selected()) ?? options()[0])

  return (
    <DialogSelect
      title={language.text("スキル", "Skills")}
      placeholder={language.text("名前・用途で検索…", "Search by name or purpose…")}
      options={options()}
      skipFilter
      preserveSelection
      onFilter={setQuery}
      onMove={(option) => setSelected(option.value)}
      footer={
        <box flexDirection="column" gap={1} flexShrink={1}>
          <text fg={theme.text} wrapMode="word">{active()?.description}</text>
          <text fg={theme.textMuted}>{active() ? `/${active()!.value}` : ""}</text>
          <text id="skill-language-toggle" fg={theme.textMuted} onMouseUp={() => language.set(language.current() === "ja" ? "en" : "ja")}>
            {language.text("言語：日本語 · クリックまたは Ctrl+L で切替", "Language: English · Click or Ctrl+L to switch")}
          </text>
        </box>
      }
      bindings={[{
        key: "ctrl+l",
        desc: language.text("言語切替", "Switch language"),
        cmd: () => language.set(language.current() === "ja" ? "en" : "ja"),
      }]}
      renderFilter={!showError()}
      locked={showError()}
      emptyView={
        showError() ? (
          <box paddingLeft={4} paddingRight={4}>
            <text fg={theme.error} attributes={TextAttributes.BOLD}>
              {language.text("スキルを読み込めませんでした", "Could not load skills")}
            </text>
            <text fg={theme.textMuted}>{errorMessage(loadError())}</text>
          </box>
        ) : (
          <box paddingLeft={4} paddingRight={4}>
            <text fg={theme.textMuted}>{skills.loading ? language.text("読み込み中…", "Loading…") : language.text("該当するスキルがありません", "No skills found")}</text>
          </box>
        )
      }
    />
  )
}

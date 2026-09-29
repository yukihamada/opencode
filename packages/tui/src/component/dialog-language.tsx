import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useLanguage, type Language } from "../context/language"

export function DialogLanguage() {
  const language = useLanguage()
  const dialog = useDialog()
  return (
    <DialogSelect<Language>
      title={language.text("言語設定", "Language settings")}
      renderFilter={false}
      current={language.current()}
      options={[
        { title: language.text("日本語", "Japanese"), value: "ja" },
        { title: language.text("英語", "English"), value: "en" },
      ]}
      onSelect={(option) => {
        language.set(option.value)
        dialog.clear()
      }}
    />
  )
}

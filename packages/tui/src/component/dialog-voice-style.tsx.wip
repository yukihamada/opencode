import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { setVoiceStyle, voiceStyle, voiceStyles } from "../util/voice"

export function DialogVoiceStyle() {
  const dialog = useDialog()
  const ja = (process.env.TE_LANG || process.env.LANG || "en").startsWith("ja")
  const labels = ja ? ["フレンドリー", "丁寧", "簡潔"] : ["Friendly", "Polite", "Concise"]
  return (
    <DialogSelect
      title={ja ? "話し方" : "Speaking style"}
      current={voiceStyle()}
      options={voiceStyles.map((value, index) => ({ value, title: labels[index]! }))}
      onSelect={(option) => {
        setVoiceStyle(option.value)
        dialog.clear()
      }}
    />
  )
}

import { createMemo } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect } from "../ui/dialog-select"
import { useTheme } from "../context/theme"
import { useLanguage } from "../context/language"
import { useToast } from "../ui/toast"
import { useSync } from "../context/sync"
import { useSDK } from "../context/sdk"

const COST_LIMIT_METADATA_KEY = "cost_limit_usd"
const DEFAULT_LIMIT_USD = 1

const labels = {
  ja: {
    title: "依頼ごとの費用上限",
    current: "現在",
    default: "既定",
    unlimited: "無制限",
    off: "確認なし（無制限）",
    prompt: "上限（USD、1以上。none で無制限）",
    invalid: "1以上の数値、または none を入力してください。",
    saved: "費用上限を更新しました",
    failed: "費用上限を更新できませんでした",
    needSession: "会話を開いてから実行してください。",
  },
  en: {
    title: "Task cost limit",
    current: "Current",
    default: "default",
    unlimited: "unlimited",
    off: "No approval (unlimited)",
    prompt: "Limit in USD (>= 1, or none for unlimited)",
    invalid: "Enter a number >= 1, or none.",
    saved: "Cost limit updated",
    failed: "Could not update the cost limit",
    needSession: "Open a session first.",
  },
}

export function DialogCostLimit(props: { session: string }) {
  const dialog = useDialog()
  const language = useLanguage()
  const toast = useToast()
  const sync = useSync()
  const sdk = useSDK()
  const { theme } = useTheme()
  const t = labels[language.current()]
  const session = createMemo(() => sync.session.get(props.session))

  function current(): string {
    const raw = session()?.metadata?.[COST_LIMIT_METADATA_KEY]
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return `$${raw}`
    if (typeof raw === "string" && raw.trim().toLowerCase() === "none") return t.unlimited
    return `$${DEFAULT_LIMIT_USD} (${t.default})`
  }

  async function save(value: string) {
    const trimmed = value.trim().toLowerCase()
    let stored: number | string
    if (trimmed === "none") {
      stored = "none"
    } else {
      const limit = Number(trimmed)
      if (!Number.isFinite(limit) || limit <= 0) {
        toast.show({ variant: "warning", message: t.invalid })
        return
      }
      stored = limit
    }
    try {
      const metadata = { ...(session()?.metadata ?? {}), [COST_LIMIT_METADATA_KEY]: stored }
      await sdk.client.session.update({ sessionID: props.session, metadata })
      toast.show({ variant: "info", message: t.saved })
      dialog.clear()
    } catch {
      toast.show({ variant: "error", message: t.failed })
    }
  }

  if (!props.session) {
    toast.show({ variant: "warning", message: t.needSession })
    dialog.clear()
    return null
  }

  return (
    <DialogSelect
      title={t.title}
      options={[
        { title: `${t.current}: ${current()}`, value: "edit" },
        { title: t.off, value: "none" },
      ]}
      onSelect={(option) => {
        if (option.value === "none") {
          void save("none")
          return
        }
        void DialogPrompt.show(dialog, t.prompt, { value: "" }).then((value) => {
          if (value === null) {
            dialog.clear()
            return
          }
          void save(value)
        })
      }}
      footer={<text fg={theme.textMuted}>{t.prompt}</text>}
    />
  )
}

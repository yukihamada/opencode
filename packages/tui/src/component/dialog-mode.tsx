import { UsageMode } from "@sente-ai/core/usage-mode"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useLanguage } from "../context/language"
import { useLocal } from "../context/local"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { errorMessage } from "../util/error"
import { describeMode, modeChangedMessage, modeDescription, usableWindow } from "../util/usage-mode"

/// `/mode` の表示と切り替え(ダイアログと `/mode 節約` 入力の両方から使う)。
export function useUsageMode() {
  const sync = useSync()
  const local = useLocal()
  const sdk = useSDK()
  const toast = useToast()
  const language = useLanguage()

  const env = () => ({ SENTE_MODE: process.env["SENTE_MODE"], SENTE_MAX_CONTEXT: process.env["SENTE_MAX_CONTEXT"] })
  const current = () => UsageMode.resolve({ env: env().SENTE_MODE, config: sync.data.config.compaction?.mode }).mode
  const status = () => {
    const selected = local.model.current()
    const model = selected
      ? sync.data.provider.find((item) => item.id === selected.providerID)?.models[selected.modelID]
      : undefined
    return describeMode({
      compaction: sync.data.config.compaction,
      env: env(),
      window: model ? usableWindow(model.limit, sync.data.config.compaction?.reserved) : undefined,
      language: language.current(),
    })
  }
  const set = async (mode: UsageMode.Mode) => {
    const result = await sdk.client.global.config.update({ config: { compaction: { mode } } })
    if (result.error) {
      toast.show({ variant: "error", message: errorMessage(result.error) })
      return
    }
    toast.show({ variant: "info", message: modeChangedMessage(mode, env(), language.current()) })
  }
  return { current, status, set, showStatus: () => toast.show({ variant: "info", message: status(), duration: 8000 }) }
}

export function DialogMode() {
  const dialog = useDialog()
  const language = useLanguage()
  const mode = useUsageMode()
  return (
    <DialogSelect<UsageMode.Mode>
      title={mode.status()}
      renderFilter={false}
      current={mode.current()}
      options={UsageMode.MODES.map((value) => ({
        title: UsageMode.label(value, language.current()),
        description: modeDescription(value, language.current()),
        value,
      }))}
      onSelect={(option) => {
        dialog.clear()
        void mode.set(option.value)
      }}
    />
  )
}

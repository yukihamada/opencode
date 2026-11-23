import { createMemo } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useLoop } from "../context/loop"
import { Loop } from "../util/loop"

// `/loop`(引数なし): 実行中のループ一覧。選ぶとそのループを止める。
export function DialogLoop() {
  const loop = useLoop()
  const dialog = useDialog()
  const toast = useToast()
  const t = createMemo(() => loop.text())
  const options = createMemo(() =>
    loop.list().map((item) => ({
      value: item.id,
      title: `${item.id} · ${item.prompt.split("\n")[0].slice(0, 60)}`,
      description: [
        `${t().every} ${Loop.formatInterval(item.interval)}`,
        `${item.runs}/${item.maxRuns} ${t().runs}`,
        item.skipped ? `${item.skipped} ${t().skipped}` : "",
        item.state === "paused" ? t().paused : `${t().next} ${Loop.countdown(item.nextAt - Date.now())}`,
      ]
        .filter(Boolean)
        .join(" · "),
    })),
  )
  return (
    <DialogSelect
      title={options().length ? `${t().title} — ${t().select}` : `${t().title} — ${t().empty}`}
      options={options().length ? options() : [{ value: "", title: t().usage, description: t().help }]}
      onSelect={(option) => {
        dialog.clear()
        if (!option.value) return
        toast.show({ variant: "info", message: t().stopped(loop.stop(option.value).length) })
      }}
    />
  )
}

import { createMemo } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useLoop } from "../context/loop"
import { Loop } from "../util/loop"

// `/loop`(引数なし): 実行中のループ一覧(残り時間は毎秒更新)。選ぶと停止・再開を選べる。
export function DialogLoop() {
  const loop = useLoop()
  const dialog = useDialog()
  const options = createMemo(() => {
    const t = loop.text()
    const now = loop.now()
    return loop.list().map((item) => ({
      value: item.id,
      title: `${item.id} · ${item.prompt.split("\n")[0].slice(0, 60)}`,
      description: [
        t.everyLabel(Loop.formatInterval(item.interval)),
        item.state === "paused"
          ? item.pauseReason === "cost"
            ? t.pausedCostShort
            : t.pausedErrorShort
          : `${t.next} ${Loop.countdown(item.nextAt - now)}`,
        `${item.runs}/${item.maxRuns}${t.runs}`,
        `${t.money(item.spent)}/${Loop.formatUsd(item.budget)}`,
        item.skipped ? `${item.skipped} ${t.skipped}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    }))
  })
  return (
    <DialogSelect
      title={options().length ? `${loop.text().title} — ${loop.text().select}` : `${loop.text().title} — ${loop.text().empty}`}
      options={options().length ? options() : [{ value: "", title: loop.text().usage, description: loop.text().help }]}
      onSelect={(option) => {
        if (!option.value) return dialog.clear()
        dialog.replace(() => <DialogLoopActions id={option.value} />)
      }}
    />
  )
}

function DialogLoopActions(props: { id: string }) {
  const loop = useLoop()
  const dialog = useDialog()
  const toast = useToast()
  const item = createMemo(() => loop.list().find((entry) => entry.id === props.id))
  const options = createMemo(() => {
    const t = loop.text()
    return [
      { value: "stop", title: t.stop },
      ...(item()?.state === "paused" ? [{ value: "resume", title: t.resume }] : []),
      { value: "back", title: t.back },
    ]
  })
  return (
    <DialogSelect
      title={loop.text().confirmStop(props.id)}
      options={options()}
      onSelect={(option) => {
        const t = loop.text()
        if (option.value === "stop") {
          toast.show({ variant: "info", message: t.stopped(loop.stop(props.id).length) })
          return dialog.clear()
        }
        if (option.value === "resume") {
          const result = loop.resume(props.id)
          toast.show({
            variant: result.waiting.length ? "warning" : "info",
            message: result.waiting.length ? t.waiting(result.waiting.length) : t.resumed(result.resumed.length),
          })
          return dialog.clear()
        }
        dialog.replace(() => <DialogLoop />)
      }}
    />
  )
}

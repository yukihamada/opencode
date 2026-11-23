import { createSignal, onCleanup, useContext } from "solid-js"
import { createSimpleContext } from "./helper"
import { useSync } from "./sync"
import { useSDK } from "./sdk"
import { useToast } from "../ui/toast"
import { useLanguage } from "./language"
import { Loop } from "../util/loop"
import { loopText } from "../util/loop-text"
import { sendPrompt } from "../prompt/send"

// /loop の実体。TUI のプロセス内だけで動き、閉じれば止まる(保存しない)。
export const { use: useLoop, provider: LoopProvider, context: LoopContext } = createSimpleContext({
  name: "Loop",
  init: () => {
    const sync = useSync()
    const sdk = useSDK()
    const toast = useToast()
    const language = useLanguage()
    const text = () => loopText(language.current())
    const [version, setVersion] = createSignal(0)
    const [now, setNow] = createSignal(Date.now())
    const typed = { at: undefined as number | undefined }
    const timer = { id: undefined as ReturnType<typeof setInterval> | undefined }

    const manager = Loop.create({
      now: () => Date.now(),
      session: (sessionID) => {
        const status = sync.data.session_status[sessionID]
        return {
          busy: status !== undefined && status.type !== "idle",
          costGate: (sync.data.permission[sessionID] ?? []).some((request) => request.permission === "request_cost"),
        }
      },
      lastTyped: () => typed.at,
      send: (item) =>
        sendPrompt(sdk.client, {
          sessionID: item.target.sessionID,
          prompt: { input: item.prompt, parts: [] },
          text: item.prompt,
          agent: item.target.agent,
          model: item.target.model,
          variant: item.target.variant,
          commands: sync.data.command.map((command) => command.name),
          editorParts: [],
        }),
      notify: (event) => {
        const t = text()
        if (event.type === "paused")
          toast.show({
            variant: "warning",
            message: event.reason === "cost" ? t.pausedCost(event.item.id) : t.pausedError(event.item.id),
            duration: 10_000,
          })
        if (event.type === "finished" && event.reason !== "stopped")
          toast.show({ variant: "info", message: t.finished(event.item.id, event.reason) })
      },
      change: () => {
        setVersion((value) => value + 1)
        schedule()
      },
    })

    function schedule() {
      const active = manager.list().length > 0
      if (active && timer.id === undefined)
        timer.id = setInterval(() => {
          setNow(Date.now())
          manager.tick()
        }, 1000)
      if (!active && timer.id !== undefined) {
        clearInterval(timer.id)
        timer.id = undefined
      }
    }

    onCleanup(() => {
      if (timer.id !== undefined) clearInterval(timer.id)
      manager.clear()
    })

    return {
      text,
      /** 入力欄が変わったら呼ぶ。直後の数秒はループの送信を控える。 */
      typed() {
        typed.at = Date.now()
      },
      list() {
        version()
        return manager.list()
      },
      /** フッター用: 件数と次回までの残り。 */
      status() {
        version()
        const items = manager.list()
        if (items.length === 0) return undefined
        const next = manager.next()
        return text().footer(items.length, next === undefined ? undefined : Loop.countdown(next - now()))
      },
      start(input: Parameters<typeof manager.start>[0]) {
        const result = manager.start(input)
        // 初回は登録直後に送る。
        if (result.item) setTimeout(() => manager.tick(), 0)
        return result
      },
      stop: (target: string) => manager.stop(target),
      resume: (target: string) => manager.resume(target),
    }
  },
})

/** 入力欄など、プロバイダー外(単体の描画テスト等)でも描画される部品用。なければ /loop は無効。 */
export function useOptionalLoop() {
  return useContext(LoopContext)
}

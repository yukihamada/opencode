import { createSignal, onCleanup, useContext } from "solid-js"
import { createSimpleContext } from "./helper"
import { useSync } from "./sync"
import { useSDK } from "./sdk"
import { useEvent } from "./event"
import { useToast } from "../ui/toast"
import { useLanguage } from "./language"
import { Loop } from "../util/loop"
import { loopText } from "../util/loop-text"
import { sendPrompt } from "../prompt/send"
import { sessionCostWithSubagents } from "../util/spend"

const COST_LIMIT_METADATA_KEY = "cost_limit_usd"

// /loop の実体。TUI のプロセス内だけで動き、閉じれば止まる(保存しない)。
export const { use: useLoop, provider: LoopProvider, context: LoopContext } = createSimpleContext({
  name: "Loop",
  init: () => {
    const sync = useSync()
    const sdk = useSDK()
    const event = useEvent()
    const toast = useToast()
    const language = useLanguage()
    const text = () => loopText(language.current())
    const [version, setVersion] = createSignal(0)
    const [now, setNow] = createSignal(Date.now())
    let typedAt: number | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    // 費用確認(request_cost)の依頼ID → 会話。回答が来たら承認/拒否をループへ伝える。
    const costRequests = new Map<string, string>()
    // 会話の費用はメッセージIDごとに台帳へ。同期データの「直近100件」とは別に、捨てずに覚える。
    const ledger = Loop.createLedger()
    ledger.seed(sync.data.message)

    const manager = Loop.create({
      now: () => Date.now(),
      session: (sessionID) => Loop.sessionState(sync.data, sessionID),
      cost: (sessionID) => ledger.total(sessionID, sync.data.session),
      abort: (sessionID) => void sdk.client.session.abort({ sessionID }).catch(() => {}),
      lastTyped: () => typedAt,
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
        if (event.type === "paused" && !event.repeat)
          toast.show({
            variant: "warning",
            message: event.reason === "cost" ? t.pausedCost(event.items.map((item) => item.id)) : t.pausedError(event.items[0].id),
            duration: 12_000,
          })
        if (event.type === "resumed" && event.auto)
          toast.show({ variant: "info", message: t.autoResumed(event.items.map((item) => item.id)) })
        if (event.type === "finished" && event.reason !== "stopped")
          toast.show({
            variant: "info",
            message: event.aborted ? t.abortedBudget(event.item.id, event.item.spent) : t.finished(event.item.id, event.reason, event.item.spent),
            duration: 10_000,
          })
      },
      change: () => {
        setVersion((value) => value + 1)
        schedule()
      },
    })

    function schedule() {
      const active = manager.list().length > 0
      if (active && timer === undefined)
        timer = setInterval(() => {
          setNow(Date.now())
          manager.tick()
        }, 1000)
      if (!active && timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    }

    const unsubscribe = [
      event.on("message.updated", (event) => ledger.record(event.properties.info)),
      event.on("permission.asked", (event) => {
        if (event.properties.permission === Loop.COST_PERMISSION)
          costRequests.set(event.properties.id, event.properties.sessionID)
      }),
      event.on("permission.replied", (event) => {
        const sessionID = costRequests.get(event.properties.requestID)
        if (!sessionID) return
        costRequests.delete(event.properties.requestID)
        manager.costReply(sessionID, event.properties.reply !== "reject")
      }),
    ]

    onCleanup(() => {
      unsubscribe.forEach((off) => off())
      if (timer !== undefined) clearInterval(timer)
      manager.clear()
    })

    return {
      text,
      /** 毎秒更新される現在時刻(ループがある間だけ進む)。一覧の残り時間表示に使う。 */
      now,
      /** 入力欄が変わったら呼ぶ。書きかけがある間は送信を控え、空になったら(送信・消去)すぐ解除する。 */
      typed(value: string) {
        typedAt = value.trim() ? Date.now() : undefined
      },
      list(sessionID?: string) {
        version()
        return manager.list(sessionID)
      },
      /** フッター用: 開いている会話のループ件数・次回までの残り・累計費用・停止理由。 */
      status(sessionID: string) {
        version()
        const items = manager.list(sessionID)
        if (items.length === 0) return undefined
        const next = manager.next(sessionID)
        const spent = items.reduce((sum, item) => sum + item.spent, 0)
        const paused = items.find((item) => item.pauseReason)?.pauseReason
        return text().footer(items.length, next === undefined ? undefined : Loop.countdown(next - now()), spent, paused)
      },
      /** 会話の累計が費用確認ラインを超えていれば、そのライン(USD)。開始時の注意に使う。 */
      costLine(sessionID: string) {
        const info = sync.session.get(sessionID)
        const root = info?.parentID ? sync.session.get(info.parentID) : info
        const permission = sync.data.config.permission
        const rootID = root?.id ?? sessionID
        return Loop.costLineExceeded({
          own: info?.metadata?.[COST_LIMIT_METADATA_KEY],
          root: root?.metadata?.[COST_LIMIT_METADATA_KEY],
          spent: Math.max(
            sessionCostWithSubagents({ sessionID: rootID, sessions: sync.data.session }),
            ledger.total(rootID, sync.data.session),
          ),
          allow: typeof permission === "object" && permission !== null && "request_cost" in permission && permission.request_cost === "allow",
        })
      },
      start(input: Parameters<typeof manager.start>[0]) {
        ledger.seed(sync.data.message)
        const result = manager.start(input)
        if (result.item) setNow(Date.now())
        return result
      },
      stop: (target: string | undefined, sessionID?: string) => manager.stop(target, sessionID),
      resume: (target: string | undefined, sessionID?: string) => manager.resume(target, sessionID),
    }
  },
})

/** 入力欄など、プロバイダー外(単体の描画テスト等)でも描画される部品用。なければ /loop は無効。 */
export function useOptionalLoop() {
  return useContext(LoopContext)
}

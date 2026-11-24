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
    // ループのある会話(と子セッション)のメッセージだけを台帳へ。ループが無くなったら消す。
    const ledger = Loop.createLedger()
    // 会話ごとの、ループが送ったメッセージIDと、この画面の入力欄から送ったメッセージID(本人の依頼)。
    const loopMessages = new Map<string, Set<string>>()
    const humanMessages = new Map<string, Set<string>>()
    const refetched = new Set<string>()
    function release() {
      const active = new Set(manager.list().map((item) => item.target.sessionID))
      ;[...loopMessages.keys()].filter((sessionID) => !active.has(sessionID)).forEach((sessionID) => {
        loopMessages.delete(sessionID)
        humanMessages.delete(sessionID)
        ledger.unwatch(sessionID)
      })
    }

    const manager = Loop.create({
      now: () => Date.now(),
      session: (sessionID) => Loop.sessionState(sync.data, sessionID),
      runCost: (sessionID, run) => {
        const result = ledger.runCost(sessionID, run, loopMessages.get(sessionID) ?? new Set(), humanMessages.get(sessionID) ?? new Set())
        // 種類が分からないユーザーメッセージ(パーツ未着)は、会話のメッセージ一覧を取り直して判定する(1件につき1回)。
        const fresh = result.unknown.filter((id) => !refetched.has(id))
        if (fresh.length) {
          fresh.forEach((id) => Loop.remember(refetched, id, 1000))
          void sdk.client.session
            .messages({ sessionID, limit: 30 })
            .then((response) =>
              (response.data ?? []).forEach((message) => message.parts.forEach((part) => ledger.recordPart(part, sync.data.session))),
            )
            .catch(() => {})
        }
        return result
      },
      newMessageID: (sessionID) => Loop.nextMessageID(sync.data.message[sessionID]?.at(-1)?.id, Date.now()),
      abort: (sessionID) => void sdk.client.session.abort({ sessionID }).catch(() => {}),
      lastTyped: () => typedAt,
      send: (item, messageID) => {
        loopMessages.get(item.target.sessionID)?.add(messageID)
        ledger.markLoop(messageID)
        return sendPrompt(sdk.client, {
          messageID,
          textMetadata: { source: Loop.LOOP_SOURCE },
          sessionID: item.target.sessionID,
          prompt: { input: item.prompt, parts: [] },
          text: item.prompt,
          agent: item.target.agent,
          model: item.target.model,
          variant: item.target.variant,
          commands: sync.data.command.map((command) => command.name),
          editorParts: [],
        })
      },
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
            message: event.aborted
              ? t.abortedBudget(event.item.id, event.item.spent)
              : event.interjected
                ? t.interjectedBudget(event.item.id, event.item.spent)
                : event.third
                  ? t.thirdBudget(event.item.id, event.item.spent)
                  : t.finished(event.item.id, event.reason, event.item.spent),
            duration: 10_000,
          })
      },
      change: () => {
        release()
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
      event.on("message.updated", (event) => ledger.record(event.properties.info, sync.data.session)),
      event.on("message.part.updated", (event) => ledger.recordPart(event.properties.part, sync.data.session)),
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
      /**
       * 入力欄から送る依頼のメッセージID。ループのある会話では本人の依頼として覚える
       * (その後の費用はループに数えず、上限で会話を中断しない)。
       */
      humanMessageID(sessionID: string) {
        const id = Loop.nextMessageID(sync.data.message[sessionID]?.at(-1)?.id, Date.now())
        humanMessages.get(sessionID)?.add(id)
        return id
      },
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
      /** 会話の累計が費用確認ラインを超えていれば、そのライン(USD)。開始時の注意に使う(判定はサーバーと同じ規則)。 */
      costLine(input: { sessionID: string; agent: string; model: string }) {
        const info = sync.session.get(input.sessionID)
        const root = info?.parentID ? sync.session.get(info.parentID) : info
        return Loop.costLineExceeded({
          own: info?.metadata?.[COST_LIMIT_METADATA_KEY],
          root: root?.metadata?.[COST_LIMIT_METADATA_KEY],
          env: process.env.SENTE_COST_LIMIT_USD,
          // サーバーは親会話のメッセージ費用で数える。画面ではサーバー集計の会話費用(補助処理込み・やや多め)で近似する。
          spent: root?.cost ?? info?.cost ?? 0,
          rules: sync.data.agent.find((agent) => agent.name === input.agent)?.permission ?? [],
          model: input.model,
        })
      },
      start(input: Parameters<typeof manager.start>[0]) {
        ledger.watch(input.target.sessionID)
        if (!loopMessages.has(input.target.sessionID)) loopMessages.set(input.target.sessionID, new Set())
        if (!humanMessages.has(input.target.sessionID)) humanMessages.set(input.target.sessionID, new Set())
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

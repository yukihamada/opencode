export * as Loop from "./loop"

// /loop: 手元の TUI セッション内で、同じ依頼を一定間隔で現在のセッションへ送り直す。
// サーバー側の定期実行(/tasks)とは別物で、TUI を閉じると全て止まる。
// 時計とタイマーは外から渡す(テストでは偽の時計)。

export const MIN_INTERVAL_MS = 60_000
export const DEFAULT_EXPIRY_MS = 24 * 60 * 60_000
export const MAX_EXPIRY_MS = 7 * 24 * 60 * 60_000
export const DEFAULT_MAX_RUNS = 50
export const MAX_RUNS_LIMIT = 1000
export const MAX_LOOPS = 10
// 生成が終わった直後は /goal 等の自動継続が送る番。これだけ静かになってから送る。
export const SETTLE_MS = 5_000
// 入力欄を触ってからこの間は送らない(書きかけの最中に会話が動かないように)。
export const TYPING_GRACE_MS = 10_000
// 送信失敗が続いたら一時停止する。
export const MAX_CONSECUTIVE_ERRORS = 3

const UNITS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  秒: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  分: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  時間: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  日: 86_400_000,
}

/** `30s` `5m` `1h30m` `90秒` `2時間` を ms に。解釈できなければ undefined。 */
export function parseDuration(value: string): number | undefined {
  const text = value.trim().toLowerCase()
  if (!text) return undefined
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+|秒|分|時間|日)/g)]
  if (parts.length === 0) return undefined
  if (parts.map((part) => part[0]).join("") !== text.replace(/\s+/g, "")) return undefined
  const total = parts.reduce((sum, part) => {
    const unit = UNITS[part[2]]
    return unit === undefined ? NaN : sum + Number(part[1]) * unit
  }, 0)
  return Number.isFinite(total) && total > 0 ? Math.round(total) : undefined
}

/** 間隔は最短60秒に丸める。 */
export function parseInterval(value: string) {
  const ms = parseDuration(value)
  if (ms === undefined) return undefined
  return { ms: Math.max(ms, MIN_INTERVAL_MS), rounded: ms < MIN_INTERVAL_MS }
}

export type Command =
  | { type: "list" }
  | { type: "stop"; target: string }
  | { type: "resume"; target: string }
  | {
      type: "start"
      interval: number
      rounded: boolean
      prompt: string
      maxRuns: number
      expiresIn: number
    }
  | { type: "invalid"; reason: "interval" | "prompt" | "max" | "for" | "nested" }

/** `/loop` 系を解釈する。`/loop` 以外(例: `/loops`)は undefined。 */
export function parseCommand(input: string): Command | undefined {
  const match = /^\/loop(?:\s+([\s\S]*))?$/.exec(input.trim())
  if (!match) return undefined
  const rest = match[1]?.trim() ?? ""
  if (!rest || rest === "list" || rest === "ls") return { type: "list" }
  const control = /^(stop|cancel|resume)(?:\s+(\S+))?$/i.exec(rest)
  if (control) {
    const target = control[2]?.toLowerCase() ?? "all"
    return control[1].toLowerCase() === "resume" ? { type: "resume", target } : { type: "stop", target }
  }
  const tokens = rest.split(/(\s+)/)
  const head = tokens[0]
  const interval = parseInterval(head)
  if (!interval) return { type: "invalid", reason: "interval" }
  // 間隔の後ろに `--max N` `--for 2h` を任意の順で置ける。残りが依頼本文(改行も保つ)。
  const state = { maxRuns: DEFAULT_MAX_RUNS, expiresIn: DEFAULT_EXPIRY_MS, offset: head.length }
  while (true) {
    const option = /^\s+--(max|times|for)(?:\s+|=)(\S+)/.exec(rest.slice(state.offset))
    if (!option) break
    if (option[1] === "for") {
      const ms = parseDuration(option[2])
      if (ms === undefined) return { type: "invalid", reason: "for" }
      state.expiresIn = Math.min(ms, MAX_EXPIRY_MS)
    } else {
      const count = Number(option[2])
      if (!Number.isInteger(count) || count < 1) return { type: "invalid", reason: "max" }
      state.maxRuns = Math.min(count, MAX_RUNS_LIMIT)
    }
    state.offset += option[0].length
  }
  const prompt = rest.slice(state.offset).trim()
  if (!prompt) return { type: "invalid", reason: "prompt" }
  if (/^\/loop(\s|$)/.test(prompt)) return { type: "invalid", reason: "nested" }
  return {
    type: "start",
    interval: interval.ms,
    rounded: interval.rounded,
    prompt,
    maxRuns: state.maxRuns,
    expiresIn: state.expiresIn,
  }
}

export type Target = {
  sessionID: string
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
}

export type Item = {
  id: string
  target: Target
  prompt: string
  interval: number
  maxRuns: number
  createdAt: number
  expiresAt: number
  nextAt: number
  runs: number
  skipped: number
  errors: number
  state: "active" | "paused"
  pauseReason?: "cost" | "error"
}

export type Event =
  | { type: "started"; item: Item }
  | { type: "sent"; item: Item }
  | { type: "skipped"; item: Item }
  | { type: "paused"; item: Item; reason: "cost" | "error" }
  | { type: "resumed"; item: Item }
  | { type: "finished"; item: Item; reason: "expired" | "max" | "stopped" }

export type Session = { busy: boolean; costGate: boolean }

export type Options = {
  now: () => number
  /** 対象セッションの現在の状態(生成中か / 費用承認待ちか)。 */
  session: (sessionID: string) => Session
  /** 最後に入力欄を触った時刻(なければ undefined)。 */
  lastTyped: () => number | undefined
  send: (item: Item) => Promise<unknown>
  notify?: (event: Event) => void
  change?: () => void
  id?: () => string
}

export type StartError = "limit"

export function create(options: Options) {
  const items = new Map<string, Item>()
  const inflight = new Set<string>()
  // セッションごとに「静かになった時刻」と「最後に送った時刻」を覚える。
  const idle = new Map<string, number>()
  const sent = new Map<string, number>()
  const counter = { value: 0 }
  const nextID = options.id ?? (() => (++counter.value).toString(36))

  function emit(event: Event) {
    options.notify?.(event)
  }

  function finish(item: Item, reason: "expired" | "max" | "stopped") {
    if (!items.delete(item.id)) return
    emit({ type: "finished", item, reason })
  }

  function pause(item: Item, reason: "cost" | "error") {
    if (item.state === "paused") return
    item.state = "paused"
    item.pauseReason = reason
    emit({ type: "paused", item, reason })
  }

  function select(target: string, sessionID?: string) {
    if (target === "all") return [...items.values()].filter((item) => !sessionID || item.target.sessionID === sessionID)
    const item = items.get(target)
    return item ? [item] : []
  }

  // 直前に送った・静かになって間もない セッションにはまだ送らない(生成中かどうかは呼び出し側で判定済み)。
  function settled(sessionID: string, now: number) {
    const lastSent = sent.get(sessionID)
    if (lastSent !== undefined && now - lastSent < SETTLE_MS) return false
    const since = idle.get(sessionID)
    return since !== undefined && now - since >= SETTLE_MS
  }

  function tick() {
    const now = options.now()
    const before = items.size
    const states = new Map<string, Session>()
    const status = (sessionID: string) => {
      const cached = states.get(sessionID)
      if (cached) return cached
      const value = options.session(sessionID)
      states.set(sessionID, value)
      return value
    }
    // 静かになった時刻はループの期日に関係なく毎回観測する。
    const sessions = new Set([...items.values()].map((item) => item.target.sessionID))
    sessions.forEach((sessionID) => {
      const value = status(sessionID)
      if (value.busy || inflight.has(sessionID)) idle.delete(sessionID)
      else if (!idle.has(sessionID)) idle.set(sessionID, now)
    })
    const typed = options.lastTyped()
    const typing = typed !== undefined && now - typed < TYPING_GRACE_MS
    const changed = { value: false }
    ;[...items.values()]
      .toSorted((a, b) => a.nextAt - b.nextAt)
      .forEach((item) => {
        if (now >= item.expiresAt) {
          finish(item, "expired")
          return
        }
        if (item.state !== "active") return
        const session = status(item.target.sessionID)
        if (session.costGate) {
          pause(item, "cost")
          changed.value = true
          return
        }
        if (now < item.nextAt) return
        // 前回(または他のループ・本人の依頼)がまだ生成中なら、この回は飛ばして次の回へ。
        if (session.busy || inflight.has(item.target.sessionID)) {
          item.skipped++
          item.nextAt = advance(item.nextAt, item.interval, now)
          changed.value = true
          emit({ type: "skipped", item })
          return
        }
        // 生成が終わった直後・入力中は少し待つ(期日はずらさず、次の tick で再判定)。
        if (typing || !settled(item.target.sessionID, now)) return
        item.runs++
        item.nextAt = advance(item.nextAt, item.interval, now)
        inflight.add(item.target.sessionID)
        sent.set(item.target.sessionID, now)
        idle.delete(item.target.sessionID)
        changed.value = true
        emit({ type: "sent", item })
        const done = () => {
          inflight.delete(item.target.sessionID)
          idle.set(item.target.sessionID, options.now())
        }
        options.send(item).then(
          () => {
            done()
            item.errors = 0
            options.change?.()
          },
          () => {
            done()
            item.errors++
            if (item.errors >= MAX_CONSECUTIVE_ERRORS && items.has(item.id)) pause(item, "error")
            options.change?.()
          },
        )
        if (item.runs >= item.maxRuns) finish(item, "max")
      })
    if (changed.value || items.size !== before) options.change?.()
  }

  return {
    tick,
    list: () => [...items.values()].toSorted((a, b) => a.createdAt - b.createdAt),
    start(input: { target: Target; prompt: string; interval: number; maxRuns?: number; expiresIn?: number }) {
      if (items.size >= MAX_LOOPS) return { error: "limit" as StartError }
      const now = options.now()
      const item: Item = {
        id: nextID(),
        target: input.target,
        prompt: input.prompt,
        interval: Math.max(input.interval, MIN_INTERVAL_MS),
        maxRuns: Math.min(Math.max(1, input.maxRuns ?? DEFAULT_MAX_RUNS), MAX_RUNS_LIMIT),
        createdAt: now,
        expiresAt: now + Math.min(input.expiresIn ?? DEFAULT_EXPIRY_MS, MAX_EXPIRY_MS),
        // 初回は登録直後(次の tick)。生成中なら次の間隔まで飛ばす。
        nextAt: now,
        runs: 0,
        skipped: 0,
        errors: 0,
        state: "active",
      }
      items.set(item.id, item)
      // 登録時点で静かなら、そこから静穏時間を数える。
      if (!options.session(item.target.sessionID).busy && !inflight.has(item.target.sessionID) && !idle.has(item.target.sessionID))
        idle.set(item.target.sessionID, now)
      emit({ type: "started", item })
      options.change?.()
      return { item }
    },
    stop(target: string, sessionID?: string) {
      const stopped = select(target, sessionID)
      stopped.forEach((item) => finish(item, "stopped"))
      if (stopped.length) options.change?.()
      return stopped
    },
    resume(target: string, sessionID?: string) {
      const now = options.now()
      const resumed = select(target, sessionID).filter((item) => item.state === "paused")
      resumed.forEach((item) => {
        item.state = "active"
        item.pauseReason = undefined
        item.errors = 0
        item.nextAt = Math.max(item.nextAt, now)
        emit({ type: "resumed", item })
      })
      if (resumed.length) options.change?.()
      return resumed
    },
    /** 次に送る予定の最も早い時刻(有効なループがなければ undefined)。 */
    next() {
      return [...items.values()]
        .filter((item) => item.state === "active")
        .reduce<number | undefined>((min, item) => (min === undefined ? item.nextAt : Math.min(min, item.nextAt)), undefined)
    },
    clear() {
      items.clear()
      inflight.clear()
      idle.clear()
      sent.clear()
    },
  }
}

// 期日を間隔ぶん進める。大きく遅れていたら(スリープ明け等)過ぎた回はまとめて飛ばす。
function advance(nextAt: number, interval: number, now: number) {
  if (now < nextAt + interval) return nextAt + interval
  return now + interval - ((now - nextAt) % interval)
}

export type Manager = ReturnType<typeof create>

/** `mm:ss`(1時間以上は `h:mm:ss`)。 */
export function countdown(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (n: number) => n.toString().padStart(2, "0")
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

/** 間隔の短い表記(`5m` `1h30m` `90s`)。 */
export function formatInterval(ms: number) {
  const seconds = Math.round(ms / 1000)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return [h ? `${h}h` : "", m ? `${m}m` : "", s ? `${s}s` : ""].join("") || "0s"
}

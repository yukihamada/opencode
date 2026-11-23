export * as Loop from "./loop"

import { descendantIDs } from "./spend"

// /loop: 手元の TUI セッション内で、同じ依頼を一定間隔で現在のセッションへ送り直す。
// サーバー側の定期実行(/tasks)とは別物で、TUI を閉じると全て止まる。
// 時計・セッション状態・送信は外から渡す(テストでは偽の時計)。

export const MIN_INTERVAL_MS = 60_000
export const DEFAULT_EXPIRY_MS = 24 * 60 * 60_000
export const MAX_EXPIRY_MS = 7 * 24 * 60 * 60_000
export const DEFAULT_MAX_RUNS = 50
export const MAX_RUNS_LIMIT = 1000
export const DEFAULT_BUDGET_USD = 1
export const MAX_BUDGET_USD = 100
export const MAX_LOOPS = 10
// 生成が終わった直後は /goal 等の自動継続が送る番。これだけ静かになってから送る。
export const SETTLE_MS = 5_000
// 入力欄に書きかけがある間は、最後に触ってからこの間は送らない。
export const TYPING_GRACE_MS = 10_000
// 送信失敗が続いたら一時停止する。
export const MAX_CONSECUTIVE_ERRORS = 3
// 費用確認での一時停止の通知は、同じ会話ではこの間に1回だけ出す(承認のたびに重ねない)。
export const COST_NOTICE_MS = 5 * 60_000

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

const DURATION = String.raw`(?:\d+(?:\.\d+)?\s*(?:時間|秒|分|日|[a-z]+))+`
const SUFFIX = "(?:ごとに|ごと|毎に|毎|おきに|おき|間隔で)"

/** `30s` `5m` `1h30m` `90秒` `2時間` を ms に。解釈できなければ undefined。 */
export function parseDuration(value: string): number | undefined {
  const text = value.trim().toLowerCase()
  if (!new RegExp(`^${DURATION}$`).test(text)) return undefined
  const total = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(時間|秒|分|日|[a-z]+)/g)].reduce((sum, part) => {
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

/** `1` `$1.5` `2usd` を USD に。 */
export function parseBudget(value: string) {
  const match = /^\$?(\d+(?:\.\d+)?)(?:usd)?$/i.exec(value.trim())
  const usd = match ? Number(match[1]) : NaN
  return Number.isFinite(usd) && usd > 0 ? usd : undefined
}

export type Capped = "max" | "for" | "budget"

export type Command =
  | { type: "list" }
  | { type: "stop"; target?: string }
  | { type: "resume"; target?: string }
  | {
      type: "start"
      interval: number
      rounded: boolean
      prompt: string
      maxRuns: number
      expiresIn: number
      budget: number
      capped: Capped[]
    }
  | { type: "invalid"; reason: "interval" | "prompt" | "max" | "for" | "budget" | "nested" }

type Options = { maxRuns: number; expiresIn: number; budget: number; capped: Capped[] }

// `--max 3` などを1つ読む。成功なら残り、失敗ならエラー理由。
function applyOption(options: Options, name: string, value: string): Command | undefined {
  if (name === "for") {
    const ms = parseDuration(value)
    if (ms === undefined) return { type: "invalid", reason: "for" }
    if (ms > MAX_EXPIRY_MS) options.capped.push("for")
    options.expiresIn = Math.min(ms, MAX_EXPIRY_MS)
    return
  }
  if (name === "budget") {
    const usd = parseBudget(value)
    if (usd === undefined) return { type: "invalid", reason: "budget" }
    if (usd > MAX_BUDGET_USD) options.capped.push("budget")
    options.budget = Math.min(usd, MAX_BUDGET_USD)
    return
  }
  const count = Number(value)
  if (!Number.isInteger(count) || count < 1) return { type: "invalid", reason: "max" }
  if (count > MAX_RUNS_LIMIT) options.capped.push("max")
  options.maxRuns = Math.min(count, MAX_RUNS_LIMIT)
}

/** `/loop` 系を解釈する。`/loop` 以外(例: `/loops`)は undefined。 */
export function parseCommand(input: string): Command | undefined {
  const match = /^\/loop(?:\s+([\s\S]*))?$/.exec(input.trim())
  if (!match) return undefined
  const rest = match[1]?.trim() ?? ""
  if (!rest || /^(list|ls)$/i.test(rest)) return { type: "list" }
  const control = /^(stop|cancel|resume)(?:\s+(\S+))?$/i.exec(rest)
  if (control) {
    const target = control[2]?.toLowerCase()
    return control[1].toLowerCase() === "resume" ? { type: "resume", target } : { type: "stop", target }
  }
  // 間隔: `5m` `5分` `5分ごとに` `every 5m`。日本語は区切りなしで本文が続いてもよい。
  const head = new RegExp(`^(?:every\\s+)?(${DURATION})(?:\\s*(${SUFFIX}))?`, "i").exec(rest)
  const after = head ? rest.slice(head[0].length) : ""
  const joined = head && (head[2] !== undefined || /[秒分間日]$/.test(head[1]))
  const interval = head && (joined || after === "" || /^\s/.test(after)) ? parseInterval(head[1]) : undefined
  if (!interval) return { type: "invalid", reason: "interval" }
  // `--max N` `--for 2h` `--budget 1` は本文の前後どちらに置いてもよい(本文の改行は保つ)。
  const options: Options = { maxRuns: DEFAULT_MAX_RUNS, expiresIn: DEFAULT_EXPIRY_MS, budget: DEFAULT_BUDGET_USD, capped: [] }
  const leading = /^\s*--(max|times|for|budget)(?:\s+|=)(\S+)/
  const trailing = /\s+--(max|times|for|budget)(?:\s+|=)(\S+)\s*$/
  let prompt = after
  for (let option = leading.exec(prompt); option; option = leading.exec(prompt)) {
    const error = applyOption(options, option[1], option[2])
    if (error) return error
    prompt = prompt.slice(option[0].length)
  }
  for (let option = trailing.exec(prompt); option; option = trailing.exec(prompt)) {
    const error = applyOption(options, option[1], option[2])
    if (error) return error
    prompt = prompt.slice(0, option.index)
  }
  prompt = prompt.trim()
  if (!prompt) return { type: "invalid", reason: "prompt" }
  if (/^\/loop(\s|$)/i.test(prompt)) return { type: "invalid", reason: "nested" }
  return { type: "start", interval: interval.ms, rounded: interval.rounded, prompt, ...options }
}

export type Target = {
  sessionID: string
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
}

export type PauseReason = "cost" | "error"
export type FinishReason = "expired" | "max" | "stopped" | "budget"

export type Item = {
  id: string
  target: Target
  prompt: string
  interval: number
  maxRuns: number
  budget: number
  spent: number
  createdAt: number
  expiresAt: number
  nextAt: number
  lastRunAt?: number
  runs: number
  skipped: number
  errors: number
  state: "active" | "paused"
  pauseReason?: PauseReason
  /** 費用確認を拒否された(承認されても自動再開しない状態)。 */
  costRejected?: boolean
}

export type Event =
  | { type: "started"; item: Item }
  | { type: "sent"; item: Item }
  | { type: "skipped"; item: Item }
  | { type: "paused"; sessionID: string; items: Item[]; reason: PauseReason; repeat: boolean }
  | { type: "resumed"; items: Item[]; auto: boolean }
  | { type: "finished"; item: Item; reason: FinishReason }

export type Session = { busy: boolean; costGate: boolean }

export type ManagerOptions = {
  now: () => number
  /** 対象セッションの現在の状態(生成中か / 費用承認待ちか)。 */
  session: (sessionID: string) => Session
  /** 対象セッションのここまでの費用(USD・子セッション込み)。ループの1回分は送信前後の差で数える。 */
  cost?: (sessionID: string) => number
  /** 書きかけのある入力欄を最後に触った時刻(書きかけがなければ undefined)。 */
  lastTyped: () => number | undefined
  send: (item: Item) => Promise<unknown>
  notify?: (event: Event) => void
  change?: () => void
}

type SessionState = {
  /** 生成も送信もしていない状態が始まった時刻。 */
  idle?: number
  /** 送信中(HTTP 応答待ち)。 */
  inflight: boolean
  /** いま会話を動かしているループの回(送信時の費用つき)。本人・/goal の依頼なら undefined。 */
  owner?: { id: string; start: number }
  costNoticeAt?: number
}

export function create(options: ManagerOptions) {
  const items = new Map<string, Item>()
  const sessions = new Map<string, SessionState>()
  const cost = (sessionID: string) => options.cost?.(sessionID) ?? 0
  let seq = 0

  function state(sessionID: string) {
    const existing = sessions.get(sessionID)
    if (existing) return existing
    const created: SessionState = { inflight: false }
    sessions.set(sessionID, created)
    return created
  }

  function emit(event: Event) {
    options.notify?.(event)
  }

  function finish(item: Item, reason: FinishReason) {
    if (!items.delete(item.id)) return
    emit({ type: "finished", item, reason })
  }

  function inSession(sessionID: string) {
    return [...items.values()].filter((item) => item.target.sessionID === sessionID)
  }

  // target 省略=開いている会話の全件、"all"=全ての会話、それ以外=ID。
  function select(target: string | undefined, sessionID?: string) {
    if (target === "all") return [...items.values()]
    if (target === undefined) return sessionID ? inSession(sessionID) : [...items.values()]
    const item = items.get(target)
    return item ? [item] : []
  }

  // 前の回が終わったら、その回の費用をループに足し、予算を超えていれば終える。
  function settleRun(session: SessionState, sessionID: string) {
    const owner = session.owner
    if (!owner) return
    session.owner = undefined
    const item = items.get(owner.id)
    if (!item) return
    item.spent += Math.max(0, cost(sessionID) - owner.start)
    if (item.spent >= item.budget) finish(item, "budget")
  }

  function observe(sessionID: string, now: number, status: Session) {
    const session = state(sessionID)
    if (status.busy || session.inflight) session.idle = undefined
    else {
      settleRun(session, sessionID)
      session.idle ??= now
    }
    if (!status.costGate) return
    const paused = inSession(sessionID).filter((item) => item.state === "active")
    if (paused.length === 0) return
    paused.forEach((item) => {
      item.state = "paused"
      item.pauseReason = "cost"
      item.costRejected = false
    })
    const repeat = session.costNoticeAt !== undefined && now - session.costNoticeAt < COST_NOTICE_MS
    if (!repeat) session.costNoticeAt = now
    emit({ type: "paused", sessionID, items: paused, reason: "cost", repeat })
  }

  function send(item: Item, session: SessionState, now: number) {
    const sessionID = item.target.sessionID
    item.runs++
    item.lastRunAt = now
    item.nextAt = advance(item.nextAt, item.interval, now)
    session.inflight = true
    session.idle = undefined
    session.owner = { id: item.id, start: cost(sessionID) }
    emit({ type: "sent", item })
    const done = (ok: boolean) => {
      session.inflight = false
      if (ok) item.errors = 0
      else item.errors++
      if (!ok && item.errors >= MAX_CONSECUTIVE_ERRORS && items.has(item.id) && item.state === "active") {
        item.state = "paused"
        item.pauseReason = "error"
        emit({ type: "paused", sessionID, items: [item], reason: "error", repeat: false })
      }
      options.change?.()
    }
    options.send(item).then(
      () => done(true),
      () => done(false),
    )
    if (item.runs >= item.maxRuns) finish(item, "max")
  }

  function tick() {
    const now = options.now()
    const statuses = new Map<string, Session>()
    const status = (sessionID: string) => {
      const value = statuses.get(sessionID) ?? options.session(sessionID)
      statuses.set(sessionID, value)
      return value
    }
    new Set([...items.values()].map((item) => item.target.sessionID)).forEach((sessionID) =>
      observe(sessionID, now, status(sessionID)),
    )
    const typed = options.lastTyped()
    const typing = typed !== undefined && now - typed < TYPING_GRACE_MS
    // 期日の古い順(同じなら最後に送ったのが古い順)。待たされたループが後回しにならない。
    ;[...items.values()]
      .toSorted((a, b) => a.nextAt - b.nextAt || (a.lastRunAt ?? -Infinity) - (b.lastRunAt ?? -Infinity))
      .forEach((item) => {
        if (!items.has(item.id)) return
        if (now >= item.expiresAt) return finish(item, "expired")
        if (item.state !== "active" || now < item.nextAt) return
        const session = state(item.target.sessionID)
        if (status(item.target.sessionID).busy || session.inflight) {
          // 別のループの回が動いているだけなら、期日を保ったまま順番を待つ。
          if (session.owner && session.owner.id !== item.id) return
          // 自分の前回、または本人・/goal の依頼がまだ生成中: この回は飛ばして次の回へ。
          item.skipped++
          item.nextAt = advance(item.nextAt, item.interval, now)
          emit({ type: "skipped", item })
          return
        }
        // 生成が終わった直後・書きかけの入力中は少し待つ(期日はずらさず、次の tick で再判定)。
        if (typing || session.idle === undefined || now - session.idle < SETTLE_MS) return
        send(item, session, now)
      })
    options.change?.()
  }

  return {
    tick,
    list: (sessionID?: string) =>
      (sessionID ? inSession(sessionID) : [...items.values()]).toSorted((a, b) => a.createdAt - b.createdAt),
    start(input: { target: Target; prompt: string; interval: number; maxRuns?: number; expiresIn?: number; budget?: number }) {
      if (items.size >= MAX_LOOPS) return { error: "limit" as const }
      const now = options.now()
      const item: Item = {
        id: (++seq).toString(36),
        target: input.target,
        prompt: input.prompt,
        interval: Math.max(input.interval, MIN_INTERVAL_MS),
        maxRuns: Math.min(Math.max(1, input.maxRuns ?? DEFAULT_MAX_RUNS), MAX_RUNS_LIMIT),
        budget: Math.min(input.budget ?? DEFAULT_BUDGET_USD, MAX_BUDGET_USD),
        spent: 0,
        createdAt: now,
        expiresAt: now + Math.min(input.expiresIn ?? DEFAULT_EXPIRY_MS, MAX_EXPIRY_MS),
        // 初回は登録直後(会話が SETTLE_MS 静かなら)。生成中なら次の間隔まで飛ばす。
        nextAt: now,
        runs: 0,
        skipped: 0,
        errors: 0,
        state: "active",
      }
      items.set(item.id, item)
      // 登録時点で静かなら、そこから静穏時間を数える。
      const session = state(item.target.sessionID)
      if (!options.session(item.target.sessionID).busy && !session.inflight) session.idle ??= now
      emit({ type: "started", item })
      options.change?.()
      return { item }
    },
    stop(target: string | undefined, sessionID?: string) {
      const stopped = select(target, sessionID)
      stopped.forEach((item) => finish(item, "stopped"))
      options.change?.()
      return stopped
    },
    /** 一時停止中を再開する。費用確認がまだ承認待ちのものは waiting に返し、再開しない。 */
    resume(target: string | undefined, sessionID?: string) {
      const now = options.now()
      const paused = select(target, sessionID).filter((item) => item.state === "paused")
      const waiting = paused.filter((item) => item.pauseReason === "cost" && options.session(item.target.sessionID).costGate)
      const resumed = paused.filter((item) => !waiting.includes(item))
      resumed.forEach((item) => {
        item.state = "active"
        item.pauseReason = undefined
        item.costRejected = false
        item.errors = 0
        item.nextAt = Math.max(item.nextAt, now)
      })
      if (resumed.length) emit({ type: "resumed", items: resumed, auto: false })
      options.change?.()
      return { resumed, waiting }
    },
    /** 費用確認への回答。承認なら、その会話の費用で止まっていたループを自動で再開する。 */
    costReply(sessionID: string, approved: boolean) {
      const paused = inSession(sessionID).filter((item) => item.state === "paused" && item.pauseReason === "cost")
      if (!approved) {
        paused.forEach((item) => (item.costRejected = true))
        options.change?.()
        return []
      }
      const resumed = paused.filter((item) => !item.costRejected)
      resumed.forEach((item) => {
        item.state = "active"
        item.pauseReason = undefined
      })
      if (resumed.length) emit({ type: "resumed", items: resumed, auto: true })
      options.change?.()
      return resumed
    },
    /** 次に送る予定の最も早い時刻(有効なループがなければ undefined)。 */
    next(sessionID?: string) {
      const times = (sessionID ? inSession(sessionID) : [...items.values()])
        .filter((item) => item.state === "active")
        .map((item) => item.nextAt)
      return times.length ? Math.min(...times) : undefined
    },
    clear() {
      items.clear()
      sessions.clear()
    },
  }
}

// 期日を間隔ぶん進める。大きく遅れていたら(スリープ明け等)過ぎた回はまとめて飛ばす。
function advance(nextAt: number, interval: number, now: number) {
  if (now < nextAt + interval) return nextAt + interval
  return now + interval - ((now - nextAt) % interval)
}

export type Manager = ReturnType<typeof create>

// ---- TUI の状態からの読み取り(context/loop.tsx から使う。単体テストできるようここに置く) ----

type StatusData = {
  session_status: Readonly<Record<string, { type: string } | undefined>>
  permission: Readonly<Record<string, readonly { permission: string }[] | undefined>>
}

export const COST_PERMISSION = "request_cost"

/** 生成中(idle 以外)か、費用確認(request_cost)の承認待ちがあるか。 */
export function sessionState(data: StatusData, sessionID: string): Session {
  const status = data.session_status[sessionID]
  return {
    busy: status !== undefined && status.type !== "idle",
    costGate: (data.permission[sessionID] ?? []).some((request) => request.permission === COST_PERMISSION),
  }
}

type SpendData = {
  sessions: readonly { id: string; parentID?: string; cost?: number; time: { created: number; updated: number } }[]
  messages: Readonly<Record<string, readonly { role: string; cost?: number }[] | undefined>>
}

/** 会話のここまでの費用(USD)。読み込み済みのメッセージを優先し、子セッション(サブエージェント)も含める。 */
export function sessionSpend(data: SpendData, sessionID: string) {
  const one = (id: string) => {
    const messages = data.messages[id]
    if (!messages) return positive(data.sessions.find((session) => session.id === id)?.cost)
    return messages.reduce((sum, message) => sum + (message.role === "assistant" ? positive(message.cost) : 0), 0)
  }
  return descendantIDs(data.sessions, sessionID).reduce((sum, id) => sum + one(id), one(sessionID))
}

function positive(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

export type StartError = "needSession" | "needModel" | "localCommand"

/**
 * 入力欄で `/loop <間隔> <依頼>` を受け付けるか決める。
 * 依頼が「/」で始まっても、手元の画面操作のコマンド(/mode 等)でなければ受け付ける
 * (サーバーのコマンドならコマンドとして、それ以外は依頼文として送る)。
 */
export function prepareStart(
  command: Extract<Command, { type: "start" }>,
  context: {
    sessionID?: string
    agent: string
    model?: { providerID: string; modelID: string }
    variant?: string
    serverCommands: readonly string[]
    localCommands: readonly string[]
  },
): { error: StartError } | { input: Parameters<Manager["start"]>[0] } {
  if (!context.sessionID) return { error: "needSession" }
  if (!context.model) return { error: "needModel" }
  const slash = /^\/(\S+)/.exec(command.prompt)?.[1]
  if (slash && !context.serverCommands.includes(slash) && context.localCommands.includes(slash))
    return { error: "localCommand" }
  return {
    input: {
      target: { sessionID: context.sessionID, agent: context.agent, model: context.model, variant: context.variant },
      prompt: command.prompt,
      interval: command.interval,
      maxRuns: command.maxRuns,
      expiresIn: command.expiresIn,
      budget: command.budget,
    },
  }
}

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

/** `$2.00` `$0.012` `$0.00004`(0.001未満は有効数字2桁、0は `$0`)。 */
export function formatUsd(usd: number) {
  if (usd <= 0) return "$0"
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.001) return `$${usd.toFixed(3)}`
  return `$${Number(usd.toPrecision(2)).toFixed(Math.min(20, Math.ceil(-Math.log10(usd)) + 1))}`
}

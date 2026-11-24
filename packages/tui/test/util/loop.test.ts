import { describe, expect, test } from "bun:test"
import { Loop } from "../../src/util/loop"
import { loopText, yenText } from "../../src/util/loop-text"

const target = (sessionID = "ses_a") => ({
  sessionID,
  agent: "build",
  model: { providerID: "teai", modelID: "cheap" },
})

// 偽の時計と偽のサーバー。送ると「応答中」は会話が生成中(busy)になり、respondMs 後に終わる。
function harness(input: { respondMs?: number; costPerRun?: number } = {}) {
  const clock = { now: 1_000_000 }
  const busy = new Map<string, boolean>()
  const gate = new Map<string, boolean>()
  const spend = new Map<string, number>()
  const sent: Loop.Item[] = []
  const events: Loop.Event[] = []
  const pending: { at: number; sessionID: string; resolve: () => void; reject: () => void }[] = []
  const typed = { at: undefined as number | undefined }
  const fail = { next: false }
  const manager = Loop.create({
    now: () => clock.now,
    session: (sessionID) => ({ busy: busy.get(sessionID) ?? false, costGate: gate.get(sessionID) ?? false }),
    cost: (sessionID) => spend.get(sessionID) ?? 0,
    lastTyped: () => typed.at,
    send: (item) => {
      sent.push(structuredClone(item))
      const sessionID = item.target.sessionID
      if (fail.next) return Promise.reject(new Error("offline"))
      busy.set(sessionID, true)
      return new Promise<void>((resolve, reject) =>
        pending.push({
          at: clock.now + (input.respondMs ?? 20_000),
          sessionID,
          resolve: () => {
            busy.set(sessionID, false)
            spend.set(sessionID, (spend.get(sessionID) ?? 0) + (input.costPerRun ?? 0))
            resolve()
          },
          reject: () => {
            busy.set(sessionID, false)
            reject(new Error("x"))
          },
        }),
      )
    },
    notify: (event) => events.push(event),
  })
  const flush = async () => {
    await Promise.resolve()
    await Promise.resolve()
  }
  // 1秒ごとに: 終わった応答を返し、tick する。
  const advance = async (ms: number) => {
    const end = clock.now + ms
    while (clock.now < end) {
      clock.now = Math.min(end, clock.now + 1000)
      const done = pending.filter((entry) => entry.at <= clock.now)
      done.forEach((entry) => {
        pending.splice(pending.indexOf(entry), 1)
        entry.resolve()
      })
      if (done.length) await flush()
      manager.tick()
    }
  }
  const count = (prompt: string) => sent.filter((item) => item.prompt === prompt).length
  return { clock, busy, gate, spend, sent, events, pending, typed, fail, manager, advance, flush, count }
}

describe("util.loop parse", () => {
  test("parses intervals and rounds up to the 60s minimum", () => {
    expect(Loop.parseInterval("5m")).toEqual({ ms: 300_000, rounded: false })
    expect(Loop.parseInterval("1h30m")).toEqual({ ms: 5_400_000, rounded: false })
    expect(Loop.parseInterval("90s")).toEqual({ ms: 90_000, rounded: false })
    expect(Loop.parseInterval("30s")).toEqual({ ms: 60_000, rounded: true })
    expect(Loop.parseInterval("0.5s")).toEqual({ ms: 60_000, rounded: true })
    expect(Loop.parseInterval("5分")).toEqual({ ms: 300_000, rounded: false })
    expect(Loop.parseInterval("1時間30分")).toEqual({ ms: 5_400_000, rounded: false })
    expect(Loop.parseInterval("5")).toBeUndefined()
    expect(Loop.parseInterval("1h30")).toBeUndefined()
    expect(Loop.parseInterval("5x")).toBeUndefined()
    expect(Loop.parseInterval("0m")).toBeUndefined()
  })

  const start = (interval: number, prompt: string, extra: Partial<Extract<Loop.Command, { type: "start" }>> = {}): Loop.Command => ({
    type: "start",
    interval,
    rounded: false,
    prompt,
    maxRuns: Loop.DEFAULT_MAX_RUNS,
    expiresIn: Loop.DEFAULT_EXPIRY_MS,
    budget: Loop.DEFAULT_BUDGET_USD,
    capped: [],
    tail: [],
    ...extra,
  })

  test("parses list / stop / resume; stop without a target means the open session", () => {
    expect(Loop.parseCommand("/loop")).toEqual({ type: "list" })
    expect(Loop.parseCommand("/loop list")).toEqual({ type: "list" })
    expect(Loop.parseCommand("/loop stop")).toEqual({ type: "stop", target: undefined })
    expect(Loop.parseCommand("/loop STOP ABC")).toEqual({ type: "stop", target: "abc" })
    expect(Loop.parseCommand("/loop stop all")).toEqual({ type: "stop", target: "all" })
    expect(Loop.parseCommand("/loop resume")).toEqual({ type: "resume", target: undefined })
    expect(Loop.parseCommand("/loops")).toBeUndefined()
    expect(Loop.parseCommand("loop 5m hi")).toBeUndefined()
  })

  test("accepts Japanese and English interval forms", () => {
    expect(Loop.parseCommand("/loop 1m 今の時刻を一言で")).toEqual(start(60_000, "今の時刻を一言で"))
    expect(Loop.parseCommand("/loop 5分 デプロイ確認")).toEqual(start(300_000, "デプロイ確認"))
    expect(Loop.parseCommand("/loop 5分ごとにデプロイ確認")).toEqual(start(300_000, "デプロイ確認"))
    expect(Loop.parseCommand("/loop 10分おきに メール確認")).toEqual(start(600_000, "メール確認"))
    expect(Loop.parseCommand("/loop 1時間半ごとに確認")).toEqual(start(5_400_000, "確認"))
    expect(Loop.parseCommand("/loop 5 分 確認")).toEqual(start(300_000, "確認"))
    // 間隔の直後に読めない語が続くときは黙って読み替えない
    expect(Loop.parseCommand("/loop 5分デプロイ確認")).toEqual({ type: "invalid", reason: "interval" })
    expect(Loop.parseCommand("/loop 2日間 毎日の確認")).toEqual({ type: "invalid", reason: "interval" })
    expect(Loop.parseCommand("/loop 1時間半確認")).toEqual({ type: "invalid", reason: "interval" })
    expect(Loop.parseCommand("/loop every 5m check deploy")).toEqual(start(300_000, "check deploy"))
    expect(Loop.parseCommand("/loop 5mcheck")).toEqual({ type: "invalid", reason: "interval" })
    expect(Loop.parseCommand("/loop 1h30 x")).toEqual({ type: "invalid", reason: "interval" })
  })

  test("reads options before or after the prompt and reports caps", () => {
    expect(Loop.parseCommand("/loop 5m check deploy --max 3")).toEqual(start(300_000, "check deploy", { maxRuns: 3, tail: ["max"] }))
    // 末尾から読んだものは tail に残る(開始通知で明示)。`--` の後ろはそのまま依頼文
    expect(Loop.parseCommand("/loop 5m git log --max 5")).toEqual(start(300_000, "git log", { maxRuns: 5, tail: ["max"] }))
    expect(Loop.parseCommand("/loop 5m -- git log --max 5")).toEqual(start(300_000, "git log --max 5"))
    expect(Loop.parseCommand("/loop 5m --budget 2 -- x --for 1h")).toEqual(start(300_000, "x --for 1h", { budget: 2 }))
    expect(Loop.parseCommand("/loop 10s --max 3 --for 30d /review now\nline2 --budget $0.5")).toEqual(
      start(60_000, "/review now\nline2", {
        rounded: true,
        maxRuns: 3,
        expiresIn: Loop.MAX_EXPIRY_MS,
        budget: 0.5,
        capped: ["for"],
        tail: ["budget"],
      }),
    )
    expect(Loop.parseCommand("/loop 5m --max 5000 --budget 500 x")).toEqual(
      start(300_000, "x", { maxRuns: Loop.MAX_RUNS_LIMIT, budget: Loop.MAX_BUDGET_USD, capped: ["max", "budget"] }),
    )
    expect(Loop.parseCommand("/loop hello")).toEqual({ type: "invalid", reason: "interval" })
    expect(Loop.parseCommand("/loop 5m")).toEqual({ type: "invalid", reason: "prompt" })
    expect(Loop.parseCommand("/loop 5m --max 0 hi")).toEqual({ type: "invalid", reason: "max" })
    expect(Loop.parseCommand("/loop 5m hi --max x")).toEqual({ type: "invalid", reason: "max" })
    expect(Loop.parseCommand("/loop 5m --for soon hi")).toEqual({ type: "invalid", reason: "for" })
    expect(Loop.parseCommand("/loop 5m --budget free hi")).toEqual({ type: "invalid", reason: "budget" })
    expect(Loop.parseCommand("/loop 5m /loop 1m x")).toEqual({ type: "invalid", reason: "nested" })
    expect(Loop.parseCommand("/loop 5m  /LOOP x")).toEqual({ type: "invalid", reason: "nested" })
  })

  test("formats countdown, interval and USD", () => {
    expect(Loop.countdown(65_000)).toBe("01:05")
    expect(Loop.countdown(3_725_000)).toBe("1:02:05")
    expect(Loop.countdown(-5)).toBe("00:00")
    expect(Loop.formatInterval(5_400_000)).toBe("1h30m")
    expect(Loop.formatUsd(0.0123)).toBe("$0.012")
    expect(Loop.formatUsd(2)).toBe("$2.00")
    expect(Loop.formatUsd(0.00001)).toBe("$0.000010")
    expect(Loop.formatUsd(0.000043)).toBe("$0.000043")
    expect(Loop.formatUsd(0)).toBe("$0")
    expect(yenText(1)).toBe("¥150")
    expect(yenText(0.012)).toBe("¥1.8")
    expect(yenText(0.00004)).toBe("¥0.006")
    expect(loopText("ja").money(1)).toBe("$1.00(約¥150)")
    expect(loopText("en").money(1)).toBe("$1.00")
  })
})

describe("util.loop scheduler", () => {
  test("first run goes out SETTLE_MS after registering, then every interval", async () => {
    const h = harness()
    h.manager.start({ target: target(), prompt: "hi", interval: 60_000 })
    await h.advance(Loop.SETTLE_MS - 1000)
    expect(h.sent.length).toBe(0)
    await h.advance(1000)
    expect(h.sent.length).toBe(1)
    await h.advance(60_000)
    expect(h.sent.length).toBe(2)
    expect(h.manager.list()[0].runs).toBe(2)
  })

  test("never schedules below the 60s minimum", () => {
    const h = harness()
    expect(h.manager.start({ target: target(), prompt: "hi", interval: 1000 }).item?.interval).toBe(Loop.MIN_INTERVAL_MS)
  })

  test("skips the run while its previous run is still generating", async () => {
    const h = harness({ respondMs: 90_000 })
    h.manager.start({ target: target(), prompt: "hi", interval: 60_000 })
    await h.advance(Loop.SETTLE_MS)
    await h.advance(60_000)
    expect(h.sent.length).toBe(1)
    expect(h.manager.list()[0].skipped).toBe(1)
    expect(h.events.filter((event) => event.type === "skipped").length).toBe(1)
  })

  test("skips while the user's own turn (or /goal) is generating", async () => {
    const h = harness()
    h.manager.start({ target: target(), prompt: "hi", interval: 60_000 })
    await h.advance(Loop.SETTLE_MS)
    await h.advance(30_000)
    h.busy.set("ses_a", true)
    await h.advance(30_000)
    expect(h.sent.length).toBe(1)
    expect(h.manager.list()[0].skipped).toBe(1)
    h.busy.set("ses_a", false)
    await h.advance(60_000)
    expect(h.sent.length).toBe(2)
  })

  test("waits for the session to settle right after a turn ends", async () => {
    const h = harness()
    h.manager.start({ target: target(), prompt: "hi", interval: 60_000 })
    await h.advance(Loop.SETTLE_MS)
    // 期日は登録時刻から60秒ごと。期日の2秒前から本人の依頼が生成中
    await h.advance(60_000 - Loop.SETTLE_MS - 2000)
    h.busy.set("ses_a", true)
    await h.advance(1000)
    h.busy.set("ses_a", false)
    await h.advance(1000)
    expect(h.sent.length).toBe(1)
    await h.advance(Loop.SETTLE_MS)
    expect(h.sent.length).toBe(2)
  })

  test("defers only while a draft is in the input", async () => {
    const h = harness()
    h.typed.at = h.clock.now
    h.manager.start({ target: target(), prompt: "hi", interval: 60_000 })
    await h.advance(Loop.SETTLE_MS)
    expect(h.sent.length).toBe(0)
    await h.advance(Loop.TYPING_GRACE_MS)
    expect(h.sent.length).toBe(1)
  })

  test("two same-interval loops on one session share turns fairly (no starvation)", async () => {
    const h = harness({ respondMs: 20_000 })
    h.manager.start({ target: target(), prompt: "a", interval: 60_000 })
    h.manager.start({ target: target(), prompt: "b", interval: 60_000 })
    await h.advance(3_600_000)
    expect(h.count("a")).toBeGreaterThan(40)
    expect(Math.abs(h.count("a") - h.count("b"))).toBeLessThanOrEqual(1)
    // 他のループの番で待っただけなら「飛ばし」に数えない
    expect(h.manager.list().every((item) => item.skipped === 0)).toBe(true)
  })

  test("slow replies: the loop waiting longest goes first", async () => {
    const h = harness({ respondMs: 40_000 })
    h.manager.start({ target: target(), prompt: "a", interval: 60_000 })
    h.manager.start({ target: target(), prompt: "b", interval: 60_000 })
    h.manager.start({ target: target(), prompt: "c", interval: 60_000 })
    await h.advance(3_600_000)
    const counts = ["a", "b", "c"].map(h.count)
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)
  })

  test("finishes at max runs and on expiry", async () => {
    const h = harness()
    h.manager.start({ target: target(), prompt: "hi", interval: 60_000, maxRuns: 2 })
    h.manager.start({ target: target("ses_b"), prompt: "yo", interval: 60_000, expiresIn: 90_000 })
    await h.advance(300_000)
    expect(h.count("hi")).toBe(2)
    expect(h.count("yo")).toBe(2)
    expect(h.manager.list()).toEqual([])
    const finished = h.events.flatMap((event) => (event.type === "finished" ? [event.reason] : []))
    expect(finished.toSorted()).toEqual(["expired", "max"])
  })

  test("stops at the per-loop budget, independent of server cost settings", async () => {
    const h = harness({ costPerRun: 0.4 })
    h.spend.set("ses_a", 3) // 会話の既存の費用は数えない
    const item = h.manager.start({ target: target(), prompt: "hi", interval: 60_000, budget: 1 }).item!
    await h.advance(600_000)
    expect(h.count("hi")).toBe(3)
    expect(item.spent).toBeCloseTo(1.2)
    expect(h.events.some((event) => event.type === "finished" && event.reason === "budget")).toBe(true)
    expect(h.manager.list()).toEqual([])
  })

  test("budget is checked while a run is generating: the run is interrupted once exceeded", async () => {
    const aborted: string[] = []
    const cost = { v: 0 }
    const busy = { v: false }
    const clock = { now: 0 }
    const events: Loop.Event[] = []
    const manager = Loop.create({
      now: () => clock.now,
      session: () => ({ busy: busy.v, costGate: false }),
      cost: () => cost.v,
      lastTyped: () => undefined,
      abort: (sessionID) => aborted.push(sessionID),
      notify: (event) => events.push(event),
      send: () => {
        busy.v = true
        return new Promise(() => {})
      },
    })
    manager.start({ target: target(), prompt: "x", interval: 60_000, budget: 1 })
    for (let i = 0; i < 6; i++) {
      clock.now += 1000
      manager.tick()
    }
    cost.v = 0.4 // 1ステップ目
    clock.now += 1000
    manager.tick()
    expect(aborted).toEqual([])
    cost.v = 7 // 次のステップで大きく超えた
    clock.now += 1000
    manager.tick()
    expect(aborted).toEqual(["ses_a"])
    expect(manager.list()).toEqual([])
    const finished = events.find((event) => event.type === "finished")
    expect(finished && finished.type === "finished" && [finished.reason, finished.aborted, finished.item.spent]).toEqual(["budget", true, 7])
  })

  test("caps expiry at 7 days and concurrent loops at the limit", () => {
    const h = harness()
    const first = h.manager.start({ target: target(), prompt: "x", interval: 60_000, expiresIn: 30 * 86_400_000 })
    expect(first.item!.expiresAt - h.clock.now).toBe(Loop.MAX_EXPIRY_MS)
    Array.from({ length: Loop.MAX_LOOPS - 1 }, () => h.manager.start({ target: target(), prompt: "x", interval: 60_000 }))
    expect(h.manager.list().length).toBe(Loop.MAX_LOOPS)
    expect(h.manager.start({ target: target(), prompt: "x", interval: 60_000 })).toEqual({ error: "limit" })
  })

  test("stop: by id, open session (no target), and all", async () => {
    const h = harness()
    const a = h.manager.start({ target: target(), prompt: "a", interval: 60_000 }).item!
    h.manager.start({ target: target(), prompt: "b", interval: 60_000 })
    h.manager.start({ target: target("ses_b"), prompt: "c", interval: 60_000 })
    h.manager.start({ target: target("ses_c"), prompt: "d", interval: 60_000 })
    expect(h.manager.stop(a.id).map((item) => item.prompt)).toEqual(["a"])
    expect(h.manager.stop("nope")).toEqual([])
    expect(h.manager.stop(undefined, "ses_a").map((item) => item.prompt)).toEqual(["b"])
    expect(h.manager.stop("all").length).toBe(2)
    await h.advance(120_000)
    expect(h.sent).toEqual([])
  })

  test("cost gate: pauses, says 'waiting' on resume while pending, and resumes itself on approval", async () => {
    const h = harness()
    const item = h.manager.start({ target: target(), prompt: "hi", interval: 60_000 }).item!
    await h.advance(Loop.SETTLE_MS)
    h.gate.set("ses_a", true)
    await h.advance(1000)
    expect(item.state).toBe("paused")
    const paused = h.events.filter((event) => event.type === "paused")
    expect(paused.length).toBe(1)
    // 承認待ちのまま resume: 再開せず waiting を返す。通知も重ねない
    expect(h.manager.resume(undefined, "ses_a")).toEqual({ resumed: [], waiting: [item] })
    await h.advance(5000)
    expect(h.events.filter((event) => event.type === "paused").length).toBe(1)
    // 承認されたら自動で再開(resume 不要)
    h.gate.set("ses_a", false)
    expect(h.manager.costReply("ses_a", true)).toEqual([item])
    expect(item.state).toBe("active")
    expect(h.events.some((event) => event.type === "resumed" && event.auto)).toBe(true)
    await h.advance(120_000)
    expect(h.sent.length).toBeGreaterThanOrEqual(2)
  })

  test("cost gate repeats: the notice is not repeated within COST_NOTICE_MS", async () => {
    const h = harness()
    h.manager.start({ target: target(), prompt: "hi", interval: 60_000 })
    await h.advance(Loop.SETTLE_MS)
    for (const _ of [1, 2, 3]) {
      h.gate.set("ses_a", true)
      await h.advance(1000)
      h.gate.set("ses_a", false)
      h.manager.costReply("ses_a", true)
      await h.advance(60_000)
    }
    const paused = h.events.flatMap((event) => (event.type === "paused" ? [event.repeat] : []))
    expect(paused).toEqual([false, true, true])
  })

  test("cost gate rejected: stays paused until /loop resume", async () => {
    const h = harness()
    const item = h.manager.start({ target: target(), prompt: "hi", interval: 60_000 }).item!
    await h.advance(Loop.SETTLE_MS)
    h.gate.set("ses_a", true)
    await h.advance(1000)
    h.gate.set("ses_a", false)
    expect(h.manager.costReply("ses_a", false)).toEqual([])
    await h.advance(180_000)
    expect(item.state).toBe("paused")
    expect(h.sent.length).toBe(1)
    expect(h.manager.next("ses_a")).toBeUndefined()
    expect(h.manager.resume("all").resumed).toEqual([item])
    await h.advance(Loop.SETTLE_MS)
    expect(h.sent.length).toBe(2)
  })

  test("pauses after repeated send failures", async () => {
    const h = harness()
    h.fail.next = true
    const item = h.manager.start({ target: target(), prompt: "hi", interval: 60_000 }).item!
    await h.advance(Loop.SETTLE_MS)
    await h.flush()
    await h.advance(60_000)
    await h.flush()
    await h.advance(60_000)
    await h.flush()
    expect(item.state).toBe("paused")
    expect(item.pauseReason).toBe("error")
  })

  test("catches up after a long sleep without a burst", async () => {
    const h = harness({ respondMs: 1000 })
    h.manager.start({ target: target(), prompt: "hi", interval: 60_000 })
    await h.advance(Loop.SETTLE_MS + 1000)
    h.clock.now += 10 * 60_000
    h.manager.tick()
    expect(h.sent.length).toBe(2)
    h.manager.tick()
    expect(h.sent.length).toBe(2)
    expect(h.manager.next()! - h.clock.now).toBeLessThanOrEqual(60_000)
  })
})

describe("util.loop TUI state", () => {
  test("sessionState reads busy and pending request_cost", () => {
    const data = {
      session_status: { a: { type: "busy" }, b: { type: "idle" }, c: { type: "retry" } },
      permission: { b: [{ permission: "request_cost" }], c: [{ permission: "bash" }] },
    }
    expect(Loop.sessionState(data, "a")).toEqual({ busy: true, costGate: false })
    expect(Loop.sessionState(data, "b")).toEqual({ busy: false, costGate: true })
    expect(Loop.sessionState(data, "c")).toEqual({ busy: true, costGate: false })
    expect(Loop.sessionState(data, "none")).toEqual({ busy: false, costGate: false })
  })

  test("ledger keeps per-message costs (incl. subagents) even after the screen drops old messages", () => {
    const time = { created: 0, updated: 0 }
    const ledger = Loop.createLedger()
    ledger.seed({
      root: [
        { id: "m1", sessionID: "root", role: "user", cost: 5 },
        { id: "m2", sessionID: "root", role: "assistant", cost: 0.1 },
      ],
    })
    ledger.record({ id: "m2", sessionID: "root", role: "assistant", cost: 0.2 }) // 同じIDは上書き
    ledger.record({ id: "c1", sessionID: "child", role: "assistant", cost: 0.5 })
    ledger.record({ id: "o1", sessionID: "other", role: "assistant", cost: 7 })
    ledger.seed({ root: [] }) // 画面側から消えても台帳は減らない
    const sessions = [
      { id: "root", time },
      { id: "child", parentID: "root", time },
      { id: "other", time },
    ]
    expect(ledger.total("root", sessions)).toBeCloseTo(0.7)
  })

  test("--budget works in a long conversation where the screen keeps only the latest 100 messages", async () => {
    // round2 と同じ条件: 既存100件の高い会話・1回 $0.09(3ステップ×$0.03)・上限 $0.5 → 6回で終了
    const time = { created: 0, updated: 0 }
    const sessions = [{ id: "s", cost: 50, time }]
    const screen = Array.from({ length: 100 }, (_, i) => ({ id: `old${i}`, sessionID: "s", role: i % 2 ? "assistant" : "user", cost: i % 2 ? 0.05 : 0 }))
    const ledger = Loop.createLedger()
    ledger.seed({ s: screen })
    const clock = { now: 1_000_000 }
    const busy = { v: false }
    const pending: (() => void)[] = []
    const events: Loop.Event[] = []
    let seq = 0
    const manager = Loop.create({
      now: () => clock.now,
      session: () => ({ busy: busy.v, costGate: false }),
      lastTyped: () => undefined,
      cost: (id) => ledger.total(id, sessions),
      notify: (event) => events.push(event),
      send: () => {
        busy.v = true
        return new Promise<void>((resolve) =>
          pending.push(() => {
            const added = [
              { id: `n${++seq}`, sessionID: "s", role: "user", cost: 0 },
              ...[1, 2, 3].map(() => ({ id: `n${++seq}`, sessionID: "s", role: "assistant", cost: 0.03 })),
            ]
            added.forEach(ledger.record)
            screen.push(...added)
            screen.splice(0, screen.length - 100)
            busy.v = false
            resolve()
          }),
        )
      },
    })
    const item = manager.start({ target: target("s"), prompt: "x", interval: 60_000, budget: 0.5 }).item!
    for (let i = 0; i < 3600; i++) {
      clock.now += 1000
      if (pending.length && i % 60 === 30) pending.splice(0).forEach((fn) => fn())
      await Promise.resolve()
      await Promise.resolve()
      manager.tick()
    }
    expect(item.runs).toBe(6)
    expect(item.spent).toBeCloseTo(0.54)
    expect(manager.list()).toEqual([])
    expect(events.some((event) => event.type === "finished" && event.reason === "budget")).toBe(true)
  })

  test("costLineExceeded warns only when the conversation is past its approval line", () => {
    expect(Loop.costLineExceeded({ own: undefined, root: undefined, spent: 1.2, allow: false })).toBe(1)
    expect(Loop.costLineExceeded({ own: undefined, root: undefined, spent: 0.5, allow: false })).toBeUndefined()
    expect(Loop.costLineExceeded({ own: 0.1, root: 5, spent: 0.5, allow: false })).toBe(0.1)
    expect(Loop.costLineExceeded({ own: undefined, root: 5, spent: 2, allow: false })).toBeUndefined()
    expect(Loop.costLineExceeded({ own: "none", root: undefined, spent: 99, allow: false })).toBeUndefined()
    expect(Loop.costLineExceeded({ own: undefined, root: undefined, spent: 99, allow: true })).toBeUndefined()
  })

  test("prepareStart: needs a session and a model; '/' prompts go through unless they are local commands", () => {
    const command = Loop.parseCommand("/loop 5m /usr を確認") as Extract<Loop.Command, { type: "start" }>
    const base = {
      sessionID: "ses_a",
      agent: "build",
      model: { providerID: "teai", modelID: "auto" },
      serverCommands: ["review"],
      localCommands: ["mode", "models", "loop"],
    }
    expect(Loop.prepareStart(command, { ...base, sessionID: undefined })).toEqual({ error: "needSession" })
    expect(Loop.prepareStart(command, { ...base, model: undefined })).toEqual({ error: "needModel" })
    const ok = Loop.prepareStart(command, base)
    expect("input" in ok && ok.input.prompt).toBe("/usr を確認")
    expect("input" in ok && ok.input.budget).toBe(Loop.DEFAULT_BUDGET_USD)
    const review = Loop.parseCommand("/loop 5m /review") as Extract<Loop.Command, { type: "start" }>
    expect("input" in Loop.prepareStart(review, base)).toBe(true)
    const mode = Loop.parseCommand("/loop 5m /mode max") as Extract<Loop.Command, { type: "start" }>
    expect(Loop.prepareStart(mode, base)).toEqual({ error: "localCommand" })
  })
})

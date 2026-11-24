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
  const runCosts = new Map<string, number>()
  const sent: Loop.Item[] = []
  const events: Loop.Event[] = []
  const pending: { at: number; sessionID: string; resolve: () => void; reject: () => void }[] = []
  const typed = { at: undefined as number | undefined }
  const fail = { next: false }
  const manager = Loop.create({
    now: () => clock.now,
    session: (sessionID) => ({ busy: busy.get(sessionID) ?? false, costGate: gate.get(sessionID) ?? false }),
    runCost: (_sessionID, run) => ({ cost: runCosts.get(run.messageID) ?? 0, interjected: false }),
    lastTyped: () => typed.at,
    send: (item, messageID) => {
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
            runCosts.set(messageID, input.costPerRun ?? 0)
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
  return { clock, busy, gate, sent, events, pending, typed, fail, manager, advance, flush, count }
}

// 本物の台帳を使う偽の会話。ループの回(メッセージID指定)と本人の依頼・応答・子セッションを時刻つきで記録する。
function world() {
  const clock = { now: 1_000_000 }
  const sessions: { id: string; parentID?: string; time: { created: number; updated: number } }[] = [
    { id: "s", time: { created: 0, updated: 0 } },
  ]
  const ledger = Loop.createLedger({ now: () => clock.now })
  const loopIDs = new Set<string>()
  const humanIDs = new Set<string>()
  const state = { busy: false, seq: 0, loopText: "Review the recent changes." }
  const aborted: string[] = []
  const events: Loop.Event[] = []
  const pending: (() => void)[] = []
  const record = (message: { id: string; role: string; parentID?: string; cost?: number; sessionID?: string }) =>
    ledger.record({ sessionID: "s", ...message }, sessions)
  const manager = Loop.create({
    now: () => clock.now,
    session: () => ({ busy: state.busy, costGate: false }),
    lastTyped: () => undefined,
    runCost: (sessionID, run) => ledger.runCost(sessionID, run, loopIDs, humanIDs),
    newMessageID: () => `msg_loop${++state.seq}`,
    abort: (sessionID) => {
      aborted.push(sessionID)
      state.busy = false
    },
    notify: (event) => events.push(event),
    send: (_item, messageID) => {
      loopIDs.add(messageID)
      ledger.markLoop(messageID)
      record({ id: messageID, role: "user" })
      // コマンドのループ(/review 等)と同じく、サーバーがテンプレートから作った印なしの text パーツ
      ledger.recordPart({ messageID, sessionID: "s", type: "text", text: state.loopText }, sessions)
      state.busy = true
      return new Promise<void>((resolve) => pending.push(resolve))
    },
  })
  const tick = (ms = 1000) => {
    const end = clock.now + ms
    while (clock.now < end) {
      clock.now += 1000
      manager.tick()
    }
  }
  const lastLoop = () => `msg_loop${state.seq}`
  let reply = 0
  // ループの回(または本人の依頼)への応答ステップ
  const step = (parentID: string, cost: number, sessionID = "s") => record({ id: `msg_r${++reply}`, role: "assistant", parentID, cost, sessionID })
  // 本人の依頼。via: input=この画面の入力欄から(IDで分かる) / other=別の端末から(synthetic でないパーツで分かる)
  const userAsks = (id: string, via: "input" | "other" = "input") => {
    if (via === "input") humanIDs.add(id)
    record({ id, role: "user" })
    if (via === "other") ledger.recordPart({ messageID: id, sessionID: "s", type: "text" }, sessions)
  }
  // サーバーが回の途中で自動で足すユーザーメッセージ。実物と同じ形のパーツを付ける:
  // todo の催促・出力切れの続き・サブエージェント結果まとめ = synthetic な text / 自動要約 = compaction パーツ(synthetic 印なし)
  const serverAdds = (id: string, shape: "synthetic-text" | "compaction" | "none" = "synthetic-text") => {
    record({ id, role: "user" })
    if (shape === "synthetic-text") ledger.recordPart({ messageID: id, sessionID: "s", type: "text", synthetic: true }, sessions)
    if (shape === "compaction") ledger.recordPart({ messageID: id, sessionID: "s", type: "compaction" }, sessions)
  }
  // /goal(#75)の自動継続: synthetic な text で metadata.source = "goal"
  const goalContinues = (id: string) => {
    record({ id, role: "user" })
    ledger.recordPart({ messageID: id, sessionID: "s", type: "text", synthetic: true, metadata: { source: "goal", goalID: "g1" } }, sessions)
  }
  const endRun = async () => {
    state.busy = false
    pending.splice(0).forEach((resolve) => resolve())
    await Promise.resolve()
    await Promise.resolve()
  }
  return { clock, sessions, ledger, state, aborted, events, manager, tick, lastLoop, step, userAsks, serverAdds, goalContinues, endRun, loopIDs, humanIDs }
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
    // 単独の「毎」は受け付けない(「5分毎日の…」を「日の…」と取り違えない)。「毎に」は可
    expect(Loop.parseCommand("/loop 5分毎日の売上を確認")).toEqual({ type: "invalid", reason: "interval" })
    expect(Loop.parseCommand("/loop 5分毎 確認")).toEqual({ type: "invalid", reason: "interval" })
    expect(Loop.parseCommand("/loop 5分毎に確認")).toEqual(start(300_000, "確認"))
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
    const item = h.manager.start({ target: target(), prompt: "hi", interval: 60_000, budget: 1 }).item!
    await h.advance(600_000)
    expect(h.count("hi")).toBe(3)
    expect(item.spent).toBeCloseTo(1.2)
    expect(h.events.some((event) => event.type === "finished" && event.reason === "budget")).toBe(true)
    expect(h.manager.list()).toEqual([])
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

  test("ledger records only conversations with a loop (and their subagents), and forgets them on unwatch", () => {
    const time = { created: 0, updated: 0 }
    const sessions = [
      { id: "s", time },
      { id: "child", parentID: "s", time },
      { id: "other", time },
    ]
    const ledger = Loop.createLedger()
    ledger.record({ id: "m0", sessionID: "s", role: "assistant", cost: 1 }, sessions)
    expect(ledger.size()).toBe(0)
    ledger.watch("s")
    ledger.record({ id: "m1", sessionID: "s", role: "assistant", cost: 1 }, sessions)
    ledger.record({ id: "c1", sessionID: "child", role: "assistant", cost: 1 }, sessions)
    ledger.record({ id: "o1", sessionID: "other", role: "assistant", cost: 1 }, sessions)
    expect(ledger.size()).toBe(2)
    ledger.unwatch("s")
    expect(ledger.size()).toBe(0)
  })

  test("--budget in a long conversation (round2 conditions): ends after 6 runs at $0.54", async () => {
    const w = world()
    w.ledger.watch("s")
    const item = w.manager.start({ target: target("s"), prompt: "x", interval: 60_000, budget: 0.5 }).item!
    for (let run = 0; run < 10 && w.manager.list().length; run++) {
      w.tick(Loop.SETTLE_MS + 1000)
      const id = w.lastLoop()
      ;[1, 2, 3].forEach(() => w.step(id, 0.03))
      await w.endRun()
      w.tick(60_000 - Loop.SETTLE_MS - 1000)
    }
    expect(item.runs).toBe(6)
    expect(item.spent).toBeCloseTo(0.54)
    expect(w.events.some((event) => event.type === "finished" && event.reason === "budget")).toBe(true)
  })

  test("budget is checked while a run generates; the session is interrupted only when the loop alone is running", async () => {
    const w = world()
    w.ledger.watch("s")
    w.manager.start({ target: target("s"), prompt: "x", interval: 60_000, budget: 1 })
    w.tick(Loop.SETTLE_MS + 1000)
    w.step(w.lastLoop(), 0.4)
    w.tick()
    expect(w.aborted).toEqual([])
    w.step(w.lastLoop(), 7)
    w.tick()
    expect(w.aborted).toEqual(["s"])
    const finished = w.events.find((event) => event.type === "finished")
    expect(finished && finished.type === "finished" && [finished.reason, finished.aborted, finished.item.spent]).toEqual(["budget", true, 7.4])
  })

  test("case C: the user asks during a loop run — their cost is not counted and the conversation is never interrupted", async () => {
    const w = world()
    w.ledger.watch("s")
    const item = w.manager.start({ target: target("s"), prompt: "x", interval: 60_000, budget: 0.1 }).item!
    w.tick(Loop.SETTLE_MS + 1000)
    const run = w.lastLoop()
    w.step(run, 0.09)
    w.tick()
    w.userAsks("msg_user1") // 回の最中に本人が依頼(入力欄から)
    w.tick()
    w.step("msg_user1", 0.3)
    w.step("msg_user1", 0.3)
    w.tick(3000)
    expect(w.aborted).toEqual([])
    expect(w.manager.list()).toEqual([item])
    expect(item.spent).toBe(0)
    await w.endRun()
    w.tick(2000)
    // 回の費用はループの $0.09 だけ(本人の $0.6 は数えない)
    expect(item.spent).toBeCloseTo(0.09)
    expect(w.aborted).toEqual([])
  })

  test("case C': the loop's own cost crosses the budget after the user joined — only the loop ends, the conversation keeps going", async () => {
    const w = world()
    w.ledger.watch("s")
    w.manager.start({ target: target("s"), prompt: "x", interval: 60_000, budget: 0.1 })
    w.tick(Loop.SETTLE_MS + 1000)
    w.step(w.lastLoop(), 0.05)
    w.userAsks("msg_userX", "other") // 別の端末から(パーツで本人と分かる)
    w.step(w.lastLoop(), 0.08) // 本人の依頼より前に届いていた扱いではない: 範囲外
    w.tick()
    expect(w.aborted).toEqual([])
    const w2 = world()
    w2.ledger.watch("s")
    w2.manager.start({ target: target("s"), prompt: "x", interval: 60_000, budget: 0.1 })
    w2.tick(Loop.SETTLE_MS + 1000)
    w2.step(w2.lastLoop(), 0.05)
    w2.step(w2.lastLoop(), 0.08)
    w2.userAsks("msg_userY")
    w2.tick()
    expect(w2.aborted).toEqual([])
    const finished = w2.events.find((event) => event.type === "finished")
    expect(finished && finished.type === "finished" && [finished.reason, finished.aborted, finished.interjected]).toEqual(["budget", false, true])
  })

  test("case B: the user asks within a second after a run — only the loop's own $0.02 is counted", async () => {
    const w = world()
    w.ledger.watch("s")
    const item = w.manager.start({ target: target("s"), prompt: "x", interval: 60_000, budget: 0.1 }).item!
    w.tick(Loop.SETTLE_MS + 1000)
    w.step(w.lastLoop(), 0.02)
    await w.endRun()
    w.clock.now += 500
    w.userAsks("msg_user2")
    w.state.busy = true // 本人の依頼で会話がまた動く(静かにならないまま)
    // 本人の依頼の中でサブエージェントも動く
    w.sessions.push({ id: "child_user", parentID: "s", time: { created: w.clock.now, updated: w.clock.now } })
    w.step("msg_user2", 0.09)
    w.step("msg_user2", 0.09)
    w.step("x", 0.5, "child_user")
    w.tick(5000)
    w.state.busy = false
    w.tick(3000)
    expect(w.aborted).toEqual([])
    expect(item.spent).toBeCloseTo(0.02)
    expect(w.manager.list()).toEqual([item])
  })

  test("subagent sessions created during the loop's own run count toward its budget", async () => {
    const w = world()
    w.ledger.watch("s")
    const item = w.manager.start({ target: target("s"), prompt: "x", interval: 60_000, budget: 5 }).item!
    w.tick(Loop.SETTLE_MS + 1000)
    w.step(w.lastLoop(), 0.1)
    w.sessions.push({ id: "child_loop", parentID: "s", time: { created: w.clock.now, updated: w.clock.now } })
    w.step("y", 0.25, "child_loop")
    await w.endRun()
    w.tick(2000)
    expect(item.spent).toBeCloseTo(0.35)
  })

  const autoScenarios = [
    ["todo follow-up (prompt.ts todo 催促)", "msg_auto_todo", "synthetic-text"],
    ["output-limit continuation (出力切れの続き)", "msg_auto_continue", "synthetic-text"],
    ["subagent result summary (サブエージェント結果まとめ)", "msg_auto_summary", "synthetic-text"],
    ["auto compaction (自動要約: compaction パーツ・synthetic 印なし)", "msg_auto_compaction", "compaction"],
  ] as const
  for (const [name, id, shape] of autoScenarios)
    test(`server-added message mid-run is part of the loop's run: ${name}`, async () => {
      const w = world()
      w.ledger.watch("s")
      w.manager.start({ target: target("s"), prompt: "x", interval: 60_000, budget: 1 })
      w.tick(Loop.SETTLE_MS + 1000)
      w.step(w.lastLoop(), 0.1)
      w.serverAdds(id, shape)
      if (id === "msg_auto_summary") {
        w.sessions.push({ id: "child_task", parentID: "s", time: { created: 0, updated: 0 } })
        w.step("y", 0.2, "child_task")
      }
      w.step(id, 0.5)
      w.tick()
      w.step(id, 0.5) // ここで実費が上限を超える
      w.tick()
      // 自動の差し込みは本人扱いしない: 費用は数え、ループだけが動いているので中断、誤通知なし
      expect(w.aborted).toEqual(["s"])
      const finished = w.events.find((event) => event.type === "finished")
      expect(finished && finished.type === "finished" && [finished.reason, finished.aborted, finished.interjected]).toEqual(["budget", true, false])
      expect(finished && finished.item.spent).toBeCloseTo(id === "msg_auto_summary" ? 1.3 : 1.1)
    })

  test("a user message whose parts have not arrived yet blocks the interruption until it is classified", async () => {
    const w = world()
    w.ledger.watch("s")
    w.manager.start({ target: target("s"), prompt: "x", interval: 60_000, budget: 0.1 })
    w.tick(Loop.SETTLE_MS + 1000)
    w.serverAdds("msg_unknown", "none")
    w.step(w.lastLoop(), 0.2)
    w.tick(3000)
    expect(w.aborted).toEqual([])
    expect(w.manager.list().length).toBe(1)
    // パーツが届いて自動と分かったら中断して終える
    w.ledger.recordPart({ messageID: "msg_unknown", sessionID: "s", type: "text", synthetic: true }, w.sessions)
    w.tick()
    expect(w.aborted).toEqual(["s"])
  })

  test("an unknown-kind user message is waited for at most UNKNOWN_KIND_MS, then treated as automatic", async () => {
    const w = world()
    w.ledger.watch("s")
    w.manager.start({ target: target("s"), prompt: "x", interval: 60_000, budget: 0.5 })
    w.tick(Loop.SETTLE_MS + 1000)
    w.serverAdds("msg_never_classified", "none")
    w.step(w.lastLoop(), 0.6)
    w.tick(Loop.UNKNOWN_KIND_MS - 2000)
    expect(w.aborted).toEqual([])
    const unknown = w.ledger.runCost("s", { messageID: w.lastLoop(), sentAt: 0 }, w.loopIDs, w.humanIDs).unknown
    expect(unknown).toEqual(["msg_never_classified"])
    w.tick(3000)
    // 期限を過ぎたので自動扱い(回の続き): 上限超えで中断して終える
    expect(w.aborted).toEqual(["s"])
    const finished = w.events.find((event) => event.type === "finished")
    expect(finished && finished.type === "finished" && [finished.aborted, finished.interjected, finished.third]).toEqual([true, false, false])
  })

  test("a /goal continuation is a third party: not counted, never interrupted, reported as such", async () => {
    const w = world()
    w.ledger.watch("s")
    const item = w.manager.start({ target: target("s"), prompt: "x", interval: 60_000, budget: 0.1 }).item!
    w.tick(Loop.SETTLE_MS + 1000)
    w.step(w.lastLoop(), 0.05)
    w.goalContinues("msg_goal_next")
    w.step("msg_goal_next", 2) // /goal の回の費用
    w.tick(3000)
    expect(w.aborted).toEqual([])
    expect(w.manager.list()).toEqual([item])
    await w.endRun()
    w.tick(2000)
    expect(item.spent).toBeCloseTo(0.05)
    // ループ自身の分が上限を超えた後に /goal が引き継いだ場合も、会話は止めずループだけ終える
    const w2 = world()
    w2.ledger.watch("s")
    w2.manager.start({ target: target("s"), prompt: "x", interval: 60_000, budget: 0.1 })
    w2.tick(Loop.SETTLE_MS + 1000)
    w2.step(w2.lastLoop(), 0.15)
    w2.goalContinues("msg_goal_next2")
    w2.tick()
    expect(w2.aborted).toEqual([])
    const finished = w2.events.find((event) => event.type === "finished")
    expect(finished && finished.type === "finished" && [finished.reason, finished.aborted, finished.interjected, finished.third]).toEqual([
      "budget",
      false,
      false,
      true,
    ])
  })

  test("a command loop's request replayed after auto compaction (same text, no metadata) stays part of the loop's run", async () => {
    const w = world()
    w.ledger.watch("s")
    w.manager.start({ target: target("s"), prompt: "/review", interval: 60_000, budget: 1 })
    w.tick(Loop.SETTLE_MS + 1000)
    w.step(w.lastLoop(), 0.1)
    w.serverAdds("msg_compact", "compaction")
    w.step("msg_compact", 0.2, "s")
    // サーバーが元の依頼を複製して送り直す: 印のない text パーツ(中身はループの依頼と同じ)
    w.serverAdds("msg_replay", "none")
    w.ledger.recordPart({ messageID: "msg_replay", sessionID: "s", type: "text", text: w.state.loopText }, w.sessions)
    w.step("msg_replay", 0.5)
    w.tick()
    w.step("msg_replay", 0.5)
    w.tick()
    expect(w.aborted).toEqual(["s"])
    const finished = w.events.find((event) => event.type === "finished")
    expect(finished && finished.type === "finished" && [finished.aborted, finished.interjected, finished.third]).toEqual([true, false, false])
    expect(finished && finished.item.spent).toBeCloseTo(1.3)
  })

  test("a subtask command loop replayed after compaction is recognised by its subtask content", async () => {
    const w = world()
    w.ledger.watch("s")
    w.manager.start({ target: target("s"), prompt: "/review", interval: 60_000, budget: 1 })
    w.tick(Loop.SETTLE_MS + 1000)
    const loop = w.lastLoop()
    w.ledger.recordPart({ messageID: loop, sessionID: "s", type: "subtask", command: "review", prompt: "Review it" }, w.sessions)
    w.step(loop, 0.1)
    w.serverAdds("msg_replay_sub", "none")
    w.ledger.recordPart({ messageID: "msg_replay_sub", sessionID: "s", type: "subtask", command: "review", prompt: "Review it" }, w.sessions)
    w.step("msg_replay_sub", 1)
    w.tick()
    expect(w.aborted).toEqual(["s"])
    // 中身が違う subtask(別端末から本人がコマンド)は本人
    const w2 = world()
    w2.ledger.watch("s")
    w2.manager.start({ target: target("s"), prompt: "/review", interval: 60_000, budget: 1 })
    w2.tick(Loop.SETTLE_MS + 1000)
    w2.step(w2.lastLoop(), 0.1)
    w2.serverAdds("msg_other_cmd", "none")
    w2.ledger.recordPart({ messageID: "msg_other_cmd", sessionID: "s", type: "subtask", command: "plan", prompt: "Plan it" }, w2.sessions)
    w2.step("msg_other_cmd", 5)
    w2.tick(3000)
    expect(w2.aborted).toEqual([])
  })

  test("a user's own text that differs from the loop request is still the user's", async () => {
    const w = world()
    w.ledger.watch("s")
    const item = w.manager.start({ target: target("s"), prompt: "/review", interval: 60_000, budget: 0.1 }).item!
    w.tick(Loop.SETTLE_MS + 1000)
    w.step(w.lastLoop(), 0.05)
    w.serverAdds("msg_other_device", "none")
    w.ledger.recordPart({ messageID: "msg_other_device", sessionID: "s", type: "text", text: "1+1は?" }, w.sessions)
    w.step("msg_other_device", 5)
    w.tick(3000)
    expect(w.aborted).toEqual([])
    expect(w.manager.list()).toEqual([item])
  })

  test("remember keeps only the newest entries", () => {
    const set = new Set<string>()
    Array.from({ length: 1005 }, (_, i) => Loop.remember(set, `m${i}`, 1000))
    expect(set.size).toBe(1000)
    expect(set.has("m4")).toBe(false)
    expect(set.has("m5")).toBe(true)
    expect(set.has("m1004")).toBe(true)
  })

  test("partKind: text without synthetic / file / agent = human, goal・hook source = third, others = automatic", () => {
    const part = (extra: Record<string, unknown>) => ({ messageID: "m", sessionID: "s", type: "text", ...extra })
    expect(Loop.partKind(part({}))).toBe("human")
    expect(Loop.partKind(part({ type: "file" }))).toBe("human")
    expect(Loop.partKind(part({ type: "agent" }))).toBe("human")
    expect(Loop.partKind(part({ synthetic: true }))).toBe("auto")
    expect(Loop.partKind(part({ ignored: true }))).toBe("auto")
    expect(Loop.partKind(part({ type: "compaction" }))).toBe("auto")
    expect(Loop.partKind(part({ type: "compaction", auto: true }))).toBe("auto")
    // 手動の /compact は本人の操作
    expect(Loop.partKind(part({ type: "compaction", auto: false }))).toBe("human")
    // subtask はコマンドを打った時にサーバーが作る(別端末からの本人のコマンド)。ループ自身の分は ID / 中身で見分ける
    expect(Loop.partKind(part({ type: "subtask", prompt: "p", command: "review" }))).toBe("human")
    expect(Loop.partKind(part({ type: "step-start" }))).toBe("auto")
    expect(Loop.partKind(part({ metadata: { source: "loop" } }))).toBe("auto")
    expect(Loop.partKind(part({ synthetic: true, metadata: { source: "goal" } }))).toBe("third")
    expect(Loop.partKind(part({ metadata: { source: "hook" } }))).toBe("third")
  })

  test("the user's input right after the loop message (same millisecond) is recognised by ID, not by time", async () => {
    const w = world()
    w.ledger.watch("s")
    const item = w.manager.start({ target: target("s"), prompt: "x", interval: 60_000, budget: 0.1 }).item!
    w.tick(Loop.SETTLE_MS + 1000)
    w.userAsks("msg_same_ms") // 時計は進めない(同一ミリ秒)
    w.step("msg_same_ms", 5)
    w.tick(2000)
    expect(w.aborted).toEqual([])
    expect(item.spent).toBe(0)
    expect(w.manager.list()).toEqual([item])
  })

  test("nextMessageID sorts after the last message already seen even if the local clock is behind", () => {
    const ahead = Loop.nextMessageID(undefined, Date.now() + 3_600_000) // 他の端末(時計が1時間進んでいる)が作ったID相当
    const mine = Loop.nextMessageID(ahead, Date.now())
    expect(mine > ahead).toBe(true)
    expect(mine.startsWith("msg_")).toBe(true)
    expect(Loop.nextMessageID(undefined, 0).startsWith("msg_")).toBe(true)
  })

  test("costLineExceeded follows the server rules (metadata, numeric strings, env, agent request_cost)", () => {
    const base = { own: undefined, root: undefined, rules: [], model: "teai/auto" }
    expect(Loop.costLineExceeded({ ...base, spent: 1.2 })).toBe(1)
    expect(Loop.costLineExceeded({ ...base, spent: 0.5 })).toBeUndefined()
    expect(Loop.costLineExceeded({ ...base, own: 0.1, root: 5, spent: 0.5 })).toBe(0.1)
    expect(Loop.costLineExceeded({ ...base, root: 5, spent: 2 })).toBeUndefined()
    expect(Loop.costLineExceeded({ ...base, own: "2", spent: 1.5 })).toBeUndefined()
    expect(Loop.costLineExceeded({ ...base, own: "2", spent: 2.5 })).toBe(2)
    expect(Loop.costLineExceeded({ ...base, own: "none", spent: 99 })).toBeUndefined()
    expect(Loop.costLineExceeded({ ...base, env: "3", spent: 2 })).toBeUndefined()
    expect(Loop.costLineExceeded({ ...base, env: "none", spent: 99 })).toBeUndefined()
    expect(Loop.costLineExceeded({ ...base, own: "abc", env: "0.5", spent: 0.6 })).toBe(0.5)
    const rule = (pattern: string, action: string) => ({ permission: "request_cost", pattern, action })
    expect(Loop.costLineExceeded({ ...base, rules: [rule("*", "allow")], spent: 99 })).toBeUndefined()
    expect(Loop.costLineExceeded({ ...base, rules: [rule("*", "allow"), rule("teai/*", "ask")], spent: 99 })).toBe(1)
    expect(Loop.costLineExceeded({ ...base, rules: [rule("openai/*", "allow")], spent: 99 })).toBe(1)
    expect(Loop.costLineExceeded({ ...base, rules: [{ permission: "*", pattern: "*", action: "allow" }], spent: 99 })).toBe(1)
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

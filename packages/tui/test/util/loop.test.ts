import { describe, expect, test } from "bun:test"
import { Loop } from "../../src/util/loop"

const target = (sessionID = "ses_a") => ({
  sessionID,
  agent: "build",
  model: { providerID: "teai", modelID: "cheap" },
})

function harness() {
  const clock = { now: 1_000_000 }
  const sessions = new Map<string, Loop.Session>()
  const sent: Loop.Item[] = []
  const events: Loop.Event[] = []
  const pending: { resolve: () => void; reject: () => void }[] = []
  const typed = { at: undefined as number | undefined }
  const manager = Loop.create({
    now: () => clock.now,
    session: (sessionID) => sessions.get(sessionID) ?? { busy: false, costGate: false },
    lastTyped: () => typed.at,
    send: (item) => {
      sent.push(structuredClone(item))
      return new Promise<void>((resolve, reject) => pending.push({ resolve, reject: () => reject(new Error("x")) }))
    },
    notify: (event) => events.push(event),
  })
  // 1秒ごとに tick する偽の時計。
  const advance = (ms: number) => {
    const end = clock.now + ms
    while (clock.now < end) {
      clock.now = Math.min(end, clock.now + 1000)
      manager.tick()
    }
  }
  const settle = async () => {
    pending.splice(0).forEach((item) => item.resolve())
    await Promise.resolve()
    await Promise.resolve()
  }
  return { clock, sessions, sent, events, pending, typed, manager, advance, settle }
}

describe("util.loop parse", () => {
  test("parses intervals and rounds up to the 60s minimum", () => {
    expect(Loop.parseInterval("5m")).toEqual({ ms: 300_000, rounded: false })
    expect(Loop.parseInterval("1h30m")).toEqual({ ms: 5_400_000, rounded: false })
    expect(Loop.parseInterval("90s")).toEqual({ ms: 90_000, rounded: false })
    expect(Loop.parseInterval("30s")).toEqual({ ms: 60_000, rounded: true })
    expect(Loop.parseInterval("5分")).toEqual({ ms: 300_000, rounded: false })
    expect(Loop.parseInterval("2時間")).toEqual({ ms: 7_200_000, rounded: false })
    expect(Loop.parseInterval("5")).toBeUndefined()
    expect(Loop.parseInterval("abc")).toBeUndefined()
    expect(Loop.parseInterval("5x")).toBeUndefined()
    expect(Loop.parseInterval("0m")).toBeUndefined()
  })

  test("parses /loop commands", () => {
    expect(Loop.parseCommand("/loop")).toEqual({ type: "list" })
    expect(Loop.parseCommand("/loop list")).toEqual({ type: "list" })
    expect(Loop.parseCommand("/loop stop")).toEqual({ type: "stop", target: "all" })
    expect(Loop.parseCommand("/loop stop 2")).toEqual({ type: "stop", target: "2" })
    expect(Loop.parseCommand("/loop resume all")).toEqual({ type: "resume", target: "all" })
    expect(Loop.parseCommand("/loops")).toBeUndefined()
    expect(Loop.parseCommand("loop 5m hi")).toBeUndefined()
    expect(Loop.parseCommand("/loop 1m 今の時刻を一言で")).toEqual({
      type: "start",
      interval: 60_000,
      rounded: false,
      prompt: "今の時刻を一言で",
      maxRuns: Loop.DEFAULT_MAX_RUNS,
      expiresIn: Loop.DEFAULT_EXPIRY_MS,
    })
    expect(Loop.parseCommand("/loop 10s --max 3 --for 30d /review now\nline2")).toEqual({
      type: "start",
      interval: 60_000,
      rounded: true,
      prompt: "/review now\nline2",
      maxRuns: 3,
      expiresIn: Loop.MAX_EXPIRY_MS,
    })
    expect(Loop.parseCommand("/loop hello")).toEqual({ type: "invalid", reason: "interval" })
    expect(Loop.parseCommand("/loop 5m")).toEqual({ type: "invalid", reason: "prompt" })
    expect(Loop.parseCommand("/loop 5m --max 0 hi")).toEqual({ type: "invalid", reason: "max" })
    expect(Loop.parseCommand("/loop 5m --for soon hi")).toEqual({ type: "invalid", reason: "for" })
    expect(Loop.parseCommand("/loop 5m /loop 1m x")).toEqual({ type: "invalid", reason: "nested" })
  })

  test("formats countdown and interval", () => {
    expect(Loop.countdown(65_000)).toBe("01:05")
    expect(Loop.countdown(3_725_000)).toBe("1:02:05")
    expect(Loop.countdown(-5)).toBe("00:00")
    expect(Loop.formatInterval(5_400_000)).toBe("1h30m")
  })
})

describe("util.loop scheduler", () => {
  test("sends once the session has settled, then every interval", async () => {
    const h = harness()
    h.manager.start({ target: target(), prompt: "hi", interval: 60_000 })
    h.advance(Loop.SETTLE_MS)
    expect(h.sent.length).toBe(1)
    await h.settle()
    h.advance(30_000)
    expect(h.sent.length).toBe(1)
    h.advance(30_000)
    expect(h.sent.length).toBe(2)
    expect(h.manager.list()[0].runs).toBe(2)
  })

  test("never sends below the 60s minimum", () => {
    const h = harness()
    const result = h.manager.start({ target: target(), prompt: "hi", interval: 1000 })
    expect(result.item?.interval).toBe(Loop.MIN_INTERVAL_MS)
  })

  test("skips the run while the session is still generating", async () => {
    const h = harness()
    h.manager.start({ target: target(), prompt: "hi", interval: 60_000 })
    h.advance(Loop.SETTLE_MS)
    expect(h.sent.length).toBe(1)
    // 前回の送信(生成)がまだ終わらない: 次の回は飛ばす
    h.advance(60_000)
    expect(h.sent.length).toBe(1)
    expect(h.manager.list()[0].skipped).toBe(1)
    await h.settle()
    // 生成中のステータスでも飛ばす(本人や /goal が送った分)
    h.sessions.set("ses_a", { busy: true, costGate: false })
    h.advance(60_000)
    expect(h.sent.length).toBe(1)
    expect(h.manager.list()[0].skipped).toBe(2)
    expect(h.events.filter((event) => event.type === "skipped").length).toBe(2)
    h.sessions.set("ses_a", { busy: false, costGate: false })
    h.advance(60_000)
    expect(h.sent.length).toBe(2)
  })

  test("waits for the session to settle right after a turn ends", async () => {
    const h = harness()
    h.manager.start({ target: target(), prompt: "hi", interval: 60_000 })
    h.advance(Loop.SETTLE_MS)
    await h.settle()
    // 期日は登録時刻から60秒ごと(初回送信は静穏待ちで5秒遅れ)
    h.advance(60_000 - Loop.SETTLE_MS - 2000)
    h.sessions.set("ses_a", { busy: true, costGate: false })
    h.advance(1000)
    // 期日ちょうどに生成が終わった: すぐには送らず、静かになってから送る
    h.sessions.set("ses_a", { busy: false, costGate: false })
    h.advance(1000)
    expect(h.sent.length).toBe(1)
    h.advance(Loop.SETTLE_MS)
    expect(h.sent.length).toBe(2)
  })

  test("defers while the user is typing", async () => {
    const h = harness()
    h.typed.at = h.clock.now
    h.manager.start({ target: target(), prompt: "hi", interval: 60_000 })
    h.advance(Loop.SETTLE_MS)
    expect(h.sent.length).toBe(0)
    h.advance(Loop.TYPING_GRACE_MS)
    expect(h.sent.length).toBe(1)
  })

  test("finishes at max runs and on expiry", async () => {
    const h = harness()
    h.manager.start({ target: target(), prompt: "hi", interval: 60_000, maxRuns: 2 })
    h.manager.start({ target: target("ses_b"), prompt: "yo", interval: 60_000, expiresIn: 90_000 })
    h.advance(Loop.SETTLE_MS)
    await h.settle()
    h.advance(60_000)
    await h.settle()
    expect(h.sent.filter((item) => item.prompt === "hi").length).toBe(2)
    h.advance(120_000)
    await h.settle()
    expect(h.sent.filter((item) => item.prompt === "hi").length).toBe(2)
    expect(h.sent.filter((item) => item.prompt === "yo").length).toBe(2)
    expect(h.manager.list()).toEqual([])
    const finished = h.events.flatMap((event) => (event.type === "finished" ? [event.reason] : []))
    expect(finished.toSorted()).toEqual(["expired", "max"])
  })

  test("caps expiry at 7 days and concurrent loops at the limit", () => {
    const h = harness()
    const first = h.manager.start({ target: target(), prompt: "x", interval: 60_000, expiresIn: 30 * 86_400_000 })
    expect(first.item!.expiresAt - h.clock.now).toBe(Loop.MAX_EXPIRY_MS)
    Array.from({ length: Loop.MAX_LOOPS - 1 }, () => h.manager.start({ target: target(), prompt: "x", interval: 60_000 }))
    expect(h.manager.list().length).toBe(Loop.MAX_LOOPS)
    expect(h.manager.start({ target: target(), prompt: "x", interval: 60_000 })).toEqual({ error: "limit" })
  })

  test("stop by id and all", () => {
    const h = harness()
    const a = h.manager.start({ target: target(), prompt: "a", interval: 60_000 }).item!
    h.manager.start({ target: target(), prompt: "b", interval: 60_000 })
    h.manager.start({ target: target("ses_b"), prompt: "c", interval: 60_000 })
    expect(h.manager.stop(a.id).map((item) => item.prompt)).toEqual(["a"])
    expect(h.manager.stop("nope")).toEqual([])
    expect(h.manager.stop("all").length).toBe(2)
    h.advance(120_000)
    expect(h.sent).toEqual([])
  })

  test("pauses on the cost gate and resumes on request", async () => {
    const h = harness()
    const item = h.manager.start({ target: target(), prompt: "hi", interval: 60_000 }).item!
    h.advance(Loop.SETTLE_MS)
    await h.settle()
    h.sessions.set("ses_a", { busy: true, costGate: true })
    h.advance(1000)
    expect(item.state).toBe("paused")
    expect(h.events.some((event) => event.type === "paused" && event.reason === "cost")).toBe(true)
    // 承認が済んでも、本人が再開するまで送らない
    h.sessions.set("ses_a", { busy: false, costGate: false })
    h.advance(180_000)
    expect(h.sent.length).toBe(1)
    expect(h.manager.next()).toBeUndefined()
    expect(h.manager.resume("all").length).toBe(1)
    h.advance(Loop.SETTLE_MS)
    expect(h.sent.length).toBe(2)
  })

  test("pauses after repeated send failures", async () => {
    const h = harness()
    const item = h.manager.start({ target: target(), prompt: "hi", interval: 60_000 }).item!
    h.advance(Loop.SETTLE_MS)
    for (const _ of Array.from({ length: Loop.MAX_CONSECUTIVE_ERRORS })) {
      h.pending.splice(0).forEach((entry) => entry.reject())
      await Promise.resolve()
      await Promise.resolve()
      h.advance(60_000)
    }
    expect(item.state).toBe("paused")
    expect(item.pauseReason).toBe("error")
  })

  test("several loops on one session do not stack in the same turn", async () => {
    const h = harness()
    h.manager.start({ target: target(), prompt: "a", interval: 60_000 })
    h.manager.start({ target: target(), prompt: "b", interval: 60_000 })
    h.manager.start({ target: target("ses_b"), prompt: "c", interval: 120_000 })
    h.advance(Loop.SETTLE_MS)
    // 同じセッションには1回分だけ。別セッションは独立に送る
    expect(h.sent.map((item) => item.prompt).toSorted()).toEqual(["a", "c"])
    expect(h.manager.list().find((item) => item.prompt === "b")!.skipped).toBe(1)
    await h.settle()
    h.advance(60_000)
    await h.settle()
    expect(h.sent.filter((item) => item.target.sessionID === "ses_a").length).toBe(2)
  })

  test("catches up after a long sleep without a burst", async () => {
    const h = harness()
    h.manager.start({ target: target(), prompt: "hi", interval: 60_000 })
    h.advance(Loop.SETTLE_MS)
    await h.settle()
    h.clock.now += 10 * 60_000
    h.manager.tick()
    expect(h.sent.length).toBe(2)
    await h.settle()
    h.manager.tick()
    expect(h.sent.length).toBe(2)
    expect(h.manager.next()! - h.clock.now).toBeLessThanOrEqual(60_000)
  })
})

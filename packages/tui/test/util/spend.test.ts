import { describe, expect, test } from "bun:test"
import {
  descendantIDs,
  formatSpend,
  formatUsd,
  formatYen,
  sessionCostWithSubagents,
  spendLabel,
  startOfDay,
  todayCost,
  turnCost,
  turnCostWithSubagents,
  yen,
} from "../../src/util/spend"

const NOW = new Date(2026, 9, 6, 15, 0, 0).getTime()
const TODAY = startOfDay(NOW)
const YESTERDAY = TODAY - 60 * 60 * 1000

function user(created: number) {
  return { role: "user", time: { created } }
}

function assistant(created: number, cost: number) {
  return { role: "assistant", cost, time: { created } }
}

describe("util.spend", () => {
  test("converts recorded USD to yen at the top-up rate (900cr/USD, ¥1 = 6cr)", () => {
    expect(yen(1)).toBe(150)
    expect(yen(0.04)).toBeCloseTo(6)
  })

  test("startOfDay is local midnight", () => {
    const date = new Date(TODAY)
    expect([date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()]).toEqual([0, 0, 0, 0])
    expect(date.getDate()).toBe(new Date(NOW).getDate())
  })

  test("turn cost sums every call after the latest user message", () => {
    expect(turnCost([])).toBeUndefined()
    expect(turnCost([user(1)])).toBe(0)
    expect(
      turnCost([user(1), assistant(2, 0.5), user(3), assistant(4, 0.02), assistant(5, 0.03)]),
    ).toBeCloseTo(0.05)
  })

  test("turn cost ignores missing or broken costs", () => {
    expect(turnCost([user(1), { role: "assistant", time: { created: 2 } }, assistant(3, Number.NaN), assistant(4, 0.1)])).toBeCloseTo(0.1)
  })

  test("today: a session started today counts in full", () => {
    const result = todayCost({
      sessions: [{ id: "a", cost: 0.4, time: { created: TODAY + 1, updated: NOW } }],
      messages: {},
      now: NOW,
    })
    expect(result).toEqual({ usd: 0.4, partial: false })
  })

  test("today: an older session counts only the calls made since midnight", () => {
    const result = todayCost({
      sessions: [{ id: "a", cost: 5, time: { created: YESTERDAY, updated: NOW } }],
      messages: { a: [user(YESTERDAY), assistant(YESTERDAY + 1, 4.8), user(TODAY + 5), assistant(TODAY + 6, 0.2)] },
      now: NOW,
    })
    expect(result.usd).toBeCloseTo(0.2)
    expect(result.partial).toBe(false)
  })

  test("today: an older session used today without loaded messages marks the total as a lower bound", () => {
    const result = todayCost({
      sessions: [
        { id: "new", cost: 0.1, time: { created: TODAY + 1, updated: NOW } },
        { id: "old", cost: 3, time: { created: YESTERDAY, updated: NOW } },
      ],
      messages: {},
      now: NOW,
    })
    expect(result).toEqual({ usd: 0.1, partial: true })
  })

  test("today: sessions not touched today are ignored", () => {
    const result = todayCost({
      sessions: [{ id: "old", cost: 3, time: { created: YESTERDAY - 10, updated: YESTERDAY } }],
      messages: {},
      now: NOW,
    })
    expect(result).toEqual({ usd: 0, partial: false })
  })

  test("yen formatting keeps small turns readable", () => {
    expect(formatYen(0.004, "ja-JP")).toBe("¥0.6")
    expect(formatYen(0.06, "ja-JP")).toBe("¥9")
    expect(formatYen(0.08, "ja-JP")).toBe("¥12")
    expect(formatYen(10, "ja-JP")).toBe("¥1,500")
    expect(formatYen(0, "ja-JP")).toBe("¥0")
  })

  test("USD formatting does not flatten sub-cent turns to $0.00", () => {
    expect(formatUsd(0.06, "en-US")).toBe("$0.06")
    expect(formatUsd(2.2, "en-US")).toBe("$2.20")
    expect(formatUsd(1234.5, "en-US")).toBe("$1,234.50")
    expect(formatUsd(0.0042, "en-US")).toBe("$0.0042")
    expect(formatUsd(0.00004, "en-US")).toBe("$0.00004")
    expect(formatUsd(0, "en-US")).toBe("$0.00")
  })

  test("currency follows the locale: yen for Japanese, recorded USD elsewhere", () => {
    expect(formatSpend(0.08, "ja-JP")).toBe("¥12")
    expect(formatSpend(0.08, "ja")).toBe("¥12")
    expect(formatSpend(0.08, "en-US")).toBe("$0.08")
    expect(formatSpend(0.08, "en-GB")).toContain("0.08")
    expect(formatSpend(0.08, "en-GB")).not.toContain("¥")
    expect(formatSpend(0.08, "de-DE")).not.toContain("¥")
  })

  test("label: turn / today in ja and en, with + for a lower bound", () => {
    expect(spendLabel({ turn: 0.08, today: { usd: 2.2, partial: false } }, "ja-JP")).toBe("今回 ¥12 / 今日 ¥330")
    expect(spendLabel({ turn: 0.08, today: { usd: 2.2, partial: true } }, "en-US")).toBe("turn $0.08 / today $2.20+")
    expect(spendLabel({ turn: 0.004, today: { usd: 0.004, partial: false } }, "en-US")).toBe("turn $0.004 / today $0.004")
    expect(spendLabel({ turn: undefined, today: { usd: 2.2, partial: false } }, "ja-JP")).toBe("今日 ¥330")
  })

  test("label: nothing spent shows nothing (free or unpriced models)", () => {
    expect(spendLabel({ turn: 0, today: { usd: 0, partial: false } }, "ja-JP")).toBeUndefined()
    expect(spendLabel({ turn: undefined, today: { usd: 0, partial: false } }, "ja-JP")).toBeUndefined()
    expect(spendLabel({ turn: 0, today: { usd: 0.5, partial: false } }, "ja-JP")).toBe("今回 ¥0 / 今日 ¥75")
  })

  test("descendants walk subagent sessions depth-first without loops", () => {
    const sessions = [
      { id: "root", parentID: undefined, time: { created: 1, updated: 1 } },
      { id: "a", parentID: "root", time: { created: 1, updated: 1 } },
      { id: "b", parentID: "root", time: { created: 1, updated: 1 } },
      { id: "a1", parentID: "a", time: { created: 1, updated: 1 } },
      { id: "other", parentID: "elsewhere", time: { created: 1, updated: 1 } },
    ]
    expect(descendantIDs(sessions, "root").sort()).toEqual(["a", "a1", "b"])
    expect(descendantIDs(sessions, "leaf")).toEqual([])
  })

  test("turn cost includes subagent calls made after the parent's latest user message", () => {
    const sessions = [
      { id: "root", time: { created: 1, updated: 9 } },
      { id: "child", parentID: "root", cost: 0.5, time: { created: 2, updated: 9 } },
    ]
    expect(
      turnCostWithSubagents({
        sessionID: "root",
        sessions,
        messages: {
          root: [user(1), assistant(2, 0.1), user(5), assistant(6, 0.02)],
          child: [user(1), assistant(2, 0.4), user(5), assistant(7, 0.03)],
        },
      }),
    ).toBeCloseTo(0.05)
  })

  test("turn cost falls back to a subagent session total when its messages are not loaded", () => {
    const sessions = [
      { id: "root", time: { created: 1, updated: 9 } },
      { id: "child", parentID: "root", cost: 0.5, time: { created: 2, updated: 9 } },
    ]
    expect(
      turnCostWithSubagents({
        sessionID: "root",
        sessions,
        messages: { root: [user(1), assistant(2, 0.1)] },
      }),
    ).toBeCloseTo(0.6)
  })

  test("turn cost is undefined before the first user message", () => {
    expect(turnCostWithSubagents({ sessionID: "root", sessions: [], messages: {} })).toBeUndefined()
  })

  test("session total includes every subagent session below it", () => {
    const sessions = [
      { id: "root", cost: 1, time: { created: 1, updated: 9 } },
      { id: "a", parentID: "root", cost: 0.2, time: { created: 2, updated: 9 } },
      { id: "a1", parentID: "a", cost: 0.05, time: { created: 2, updated: 9 } },
      { id: "unrelated", cost: 9, time: { created: 2, updated: 9 } },
    ]
    expect(sessionCostWithSubagents({ sessionID: "root", sessions })).toBeCloseTo(1.25)
    expect(sessionCostWithSubagents({ sessionID: "missing", sessions })).toBe(0)
  })
})

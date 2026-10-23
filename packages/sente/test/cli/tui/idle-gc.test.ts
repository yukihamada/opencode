import { describe, expect, test } from "bun:test"
import { IdleGc } from "../../../src/cli/tui/idle-gc"

function fakeTimers() {
  const timers = new Map<number, () => void>()
  let id = 0
  return {
    setTimer: (fn: () => void) => {
      timers.set(++id, fn)
      return id
    },
    clearTimer: (timer: unknown) => timers.delete(timer as number),
    flush() {
      const pending = [...timers.values()]
      timers.clear()
      for (const fn of pending) fn()
    },
    get size() {
      return timers.size
    },
  }
}

describe("IdleGc", () => {
  test("collects once after activity stops, and not again while idle", () => {
    const timers = fakeTimers()
    let collected = 0
    const idle = IdleGc.create({ delay: 3000, collect: () => collected++, ...timers })
    idle.touch()
    idle.touch()
    idle.touch()
    expect(timers.size).toBe(1)
    timers.flush()
    expect(collected).toBe(1)
    timers.flush()
    expect(collected).toBe(1)
    idle.touch()
    timers.flush()
    expect(collected).toBe(2)
  })

  test("stop cancels a pending collection", () => {
    const timers = fakeTimers()
    let collected = 0
    const idle = IdleGc.create({ delay: 3000, collect: () => collected++, ...timers })
    idle.touch()
    idle.stop()
    timers.flush()
    expect(collected).toBe(0)
  })

  test("env switches", () => {
    expect(IdleGc.mode({})).toBe("gc")
    expect(IdleGc.mode({ SENTE_IDLE_GC: "0" })).toBe("off")
    expect(IdleGc.mode({ SENTE_IDLE_GC: "shrink" })).toBe("shrink")
    expect(IdleGc.delay({})).toBe(3000)
    expect(IdleGc.delay({ SENTE_IDLE_GC_MS: "500" })).toBe(500)
    expect(IdleGc.delay({ SENTE_IDLE_GC_MS: "x" })).toBe(3000)
    expect(IdleGc.start({ SENTE_IDLE_GC: "0" })).toBeUndefined()
  })
})

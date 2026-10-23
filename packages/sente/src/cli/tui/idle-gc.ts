/**
 * The TUI's engine runs in a worker and mostly sits idle between turns. JavaScriptCore only collects
 * when something allocates, so the garbage from startup and from the last turn (tens of MB of
 * short-lived Effect scopes, response bodies, …) stays resident while the user is reading or typing.
 * After a quiet period, collect once.
 *
 * `SENTE_IDLE_GC=0` turns it off, `SENTE_IDLE_GC_MS` sets the quiet period (default 3 s).
 */
const DEFAULT_MS = 3_000

export function mode(env: Record<string, string | undefined> = process.env) {
  const value = env.SENTE_IDLE_GC
  if (value === "0" || value === "off") return "off" as const
  if (value === "shrink") return "shrink" as const
  return "gc" as const
}

export function delay(env: Record<string, string | undefined> = process.env) {
  const value = Number(env.SENTE_IDLE_GC_MS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MS
}

export function create(input: {
  delay: number
  collect: () => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}) {
  const setTimer = input.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = input.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  let timer: unknown
  // Only collect after something happened since the last collection.
  let dirty = true
  const fire = () => {
    timer = undefined
    if (!dirty) return
    dirty = false
    input.collect()
  }
  return {
    /** Call on any activity; the collection runs once activity has stopped for `delay` ms. */
    touch() {
      dirty = true
      if (timer !== undefined) clearTimer(timer)
      timer = setTimer(fire, input.delay)
      ;(timer as { unref?: () => void } | undefined)?.unref?.()
    },
    stop() {
      if (timer !== undefined) clearTimer(timer)
      timer = undefined
    },
  }
}

export function start(env: Record<string, string | undefined> = process.env) {
  const m = mode(env)
  if (m === "off" || typeof Bun === "undefined") return undefined
  // Measurement aid: `SENTE_IDLE_GC_LOG=<file>` appends one line per collection.
  const log = env.SENTE_IDLE_GC_LOG
  let touches = 0
  const idle = create({
    delay: delay(env),
    collect: () => {
      const before = log ? process.memoryUsage() : undefined
      const started = performance.now()
      if (m === "shrink") Bun.shrink()
      else Bun.gc(true)
      if (!log || !before) return
      const after = process.memoryUsage()
      const mb = (n: number) => Math.round(n / 1048576)
      require("node:fs").appendFileSync(
        log,
        `${new Date().toISOString()} ${m} touches=${touches} ms=${Math.round(performance.now() - started)} heapUsed ${mb(before.heapUsed)}->${mb(after.heapUsed)} rss ${mb(before.rss)}->${mb(after.rss)}\n`,
      )
    },
  })
  idle.touch()
  return {
    touch() {
      touches++
      idle.touch()
    },
    stop: idle.stop,
  }
}

export * as IdleGc from "./idle-gc"

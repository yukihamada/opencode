import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { HostResources } from "@/effect/host-resources"

describe("HostResources.limitFor", () => {
  const base = { cores: 8, loadPerCore: 0.5, freeMemoryMB: 8192, config: {} }

  test("idle host allows the default ceiling of min(cores, 8)", () => {
    expect(HostResources.limitFor(base)).toBe(8)
    expect(HostResources.limitFor({ ...base, cores: 4 })).toBe(4)
  })

  test("respects the configured max ceiling", () => {
    expect(HostResources.limitFor({ ...base, config: { maxConcurrent: 3 } })).toBe(3)
  })

  test("shrinks to 1 under high load", () => {
    expect(HostResources.limitFor({ ...base, loadPerCore: 1.5 })).toBe(1)
    expect(HostResources.limitFor({ ...base, loadPerCore: 3 })).toBe(1)
  })

  test("scales linearly between 1x and 1.5x load factor", () => {
    const limit = HostResources.limitFor({ ...base, loadPerCore: 1.25 })
    expect(limit).toBeGreaterThan(1)
    expect(limit).toBeLessThan(8)
  })

  test("shrinks to 1 when free memory is low", () => {
    expect(HostResources.limitFor({ ...base, freeMemoryMB: 512 })).toBe(1)
  })

  test("honours the configured memory threshold", () => {
    expect(
      HostResources.limitFor({ ...base, freeMemoryMB: 512, config: { lowMemoryMB: 256 } }),
    ).toBe(8)
  })

  test("disabled config always returns the ceiling", () => {
    expect(
      HostResources.limitFor({ ...base, loadPerCore: 5, freeMemoryMB: 1, config: { disabled: true } }),
    ).toBe(8)
  })

  test("never returns less than 1 or more than the ceiling", () => {
    expect(HostResources.limitFor({ ...base, config: { maxConcurrent: 0 as never } })).toBe(1)
    expect(HostResources.limitFor({ ...base, config: { maxConcurrent: 999 } })).toBe(32)
  })
})

describe("HostResources.withSlot", () => {
  test("runs the effect and returns its value", async () => {
    const resources = HostResources.make({ disabled: true, maxConcurrent: 2 })
    const value = await Effect.runPromise(resources.withSlot(Effect.succeed(42)))
    expect(value).toBe(42)
  })

  test("limits concurrency to the configured ceiling", async () => {
    const resources = HostResources.make({ disabled: true, maxConcurrent: 2 })
    let active = 0
    let peak = 0
    const task = Effect.gen(function* () {
      active++
      peak = Math.max(peak, active)
      const gate = yield* Deferred.make<void>()
      yield* Deferred.await(gate)
      active--
    })

    const program = Effect.gen(function* () {
      const gates = Array.from({ length: 4 }, () => Deferred.makeUnsafe<void>())
      const fibers = []
      for (let i = 0; i < 4; i++) {
        const gate = gates[i]!
        const fiber = yield* Effect.forkChild(
          resources.withSlot(
            Effect.gen(function* () {
              active++
              peak = Math.max(peak, active)
              yield* Deferred.await(gate)
              active--
            }),
          ),
        )
        fibers.push(fiber)
      }
      // Let slots fill, then release one at a time.
      for (const gate of gates) {
        yield* Effect.sleep("20 millis")
        yield* Deferred.succeed(gate, undefined)
      }
      for (const fiber of fibers) yield* Fiber.join(fiber)
    })

    await Effect.runPromise(program)
    expect(peak).toBeLessThanOrEqual(2)
    expect(peak).toBeGreaterThanOrEqual(1)
  })

  test("snapshot reports running count", async () => {
    const resources = HostResources.make({ disabled: true, maxConcurrent: 4 })
    const gate = Deferred.makeUnsafe<void>()
    const program = Effect.gen(function* () {
      yield* Effect.forkChild(resources.withSlot(Deferred.await(gate)))
      yield* Effect.sleep("20 millis")
      const snap = yield* resources.snapshot
      expect(snap.running).toBe(1)
      expect(snap.limit).toBeGreaterThanOrEqual(1)
      expect(snap.cores).toBeGreaterThan(0)
      yield* Deferred.succeed(gate, undefined)
    })
    await Effect.runPromise(program)
  })
})

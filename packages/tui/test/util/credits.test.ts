import { describe, expect, test } from "bun:test"
import {
  creditsRemaining,
  isPremiumModel,
  LOW_CREDITS_THRESHOLD,
  PREMIUM_OUTPUT_COST_THRESHOLD,
} from "../../src/util/credits"

describe("util.credits", () => {
  test("returns null when the route file does not exist", async () => {
    const result = await creditsRemaining("/tmp/sente-credits-missing/last-route.json")
    expect(result).toBeNull()
  })

  test("treats missing credits as unknown", async () => {
    const file = "/tmp/sente-credits-test-null.json"
    await Bun.write(file, JSON.stringify({ at: Date.now(), credits_remaining: null }))
    expect(await creditsRemaining(file)).toBeNull()
  })

  test("reads a numeric credit balance", async () => {
    const file = "/tmp/sente-credits-test-value.json"
    await Bun.write(file, JSON.stringify({ at: Date.now(), credits_remaining: 4_321 }))
    expect(await creditsRemaining(file)).toBe(4_321)
  })

  test("classifies premium models by output cost", () => {
    expect(isPremiumModel({ output: PREMIUM_OUTPUT_COST_THRESHOLD + 1 })).toBe(true)
    expect(isPremiumModel({ output: PREMIUM_OUTPUT_COST_THRESHOLD })).toBe(false)
    expect(isPremiumModel({ output: 0 })).toBe(false)
    expect(isPremiumModel(undefined)).toBe(false)
    expect(isPremiumModel(null)).toBe(false)
  })

  test("low-credit threshold is 10,000cr", () => {
    expect(LOW_CREDITS_THRESHOLD).toBe(10_000)
  })
})

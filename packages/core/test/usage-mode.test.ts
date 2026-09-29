import { describe, expect, test } from "bun:test"
import { UsageMode } from "@sente-ai/core/usage-mode"

describe("UsageMode", () => {
  test("parses Japanese and English names, ignoring case and spaces", () => {
    expect(UsageMode.parse("節約")).toBe("saver")
    expect(UsageMode.parse("標準")).toBe("standard")
    expect(UsageMode.parse("たっぷり")).toBe("max")
    expect(UsageMode.parse(" SAVER ")).toBe("saver")
    expect(UsageMode.parse("Max")).toBe("max")
    expect(UsageMode.parse("turbo")).toBeUndefined()
    expect(UsageMode.parse("")).toBeUndefined()
    expect(UsageMode.parse(undefined)).toBeUndefined()
  })

  test("maps modes to thresholds and pruning", () => {
    expect(UsageMode.MODES.map((mode) => [UsageMode.maxContext(mode), UsageMode.prune(mode)])).toEqual([
      [128_000, true],
      [256_000, false],
      [0, false],
    ])
  })

  test("SENTE_MODE beats the config file, which beats the standard default", () => {
    expect(UsageMode.resolve({ env: "max", config: "saver" })).toEqual({ mode: "max", source: "env" })
    expect(UsageMode.resolve({ config: "saver" })).toEqual({ mode: "saver", source: "config", invalid: undefined })
    expect(UsageMode.resolve({})).toEqual({ mode: "standard", source: "default", invalid: undefined })
  })

  test("an invalid SENTE_MODE is reported and ignored", () => {
    expect(UsageMode.resolve({ env: "turbo", config: "saver" })).toEqual({
      mode: "saver",
      source: "config",
      invalid: "turbo",
    })
    expect(UsageMode.resolve({ env: "turbo" })).toEqual({ mode: "standard", source: "default", invalid: "turbo" })
    expect(UsageMode.resolve({ env: "  " }).invalid).toBeUndefined()
  })

  test("an explicit max_context beats the mode; 0 means the model window", () => {
    expect(UsageMode.threshold({ mode: "saver", window: 1_000_000 })).toBe(128_000)
    expect(UsageMode.threshold({ mode: "max", window: 1_000_000 })).toBe(1_000_000)
    expect(UsageMode.threshold({ mode: "saver", override: 400_000, window: 1_000_000 })).toBe(400_000)
    expect(UsageMode.threshold({ mode: "saver", override: 0, window: 1_000_000 })).toBe(1_000_000)
    expect(UsageMode.threshold({ mode: "standard", window: 100_000 })).toBe(100_000)
  })
})

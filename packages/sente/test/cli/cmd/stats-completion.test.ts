import { describe, expect, test } from "bun:test"
import { aggregateCompletionRates, formatCompletionRates } from "@/cli/cmd/stats"

const ledger = [
  JSON.stringify({ model: "teai/gpt-5", outcome: "completed", durationMs: 1000 }),
  JSON.stringify({ model: "teai/gpt-5", outcome: "completed", durationMs: 3000 }),
  JSON.stringify({ model: "teai/gpt-5", outcome: "error", durationMs: 500 }),
  JSON.stringify({ model: "teai/claude-sonnet-4-5", outcome: "completed", durationMs: 2000 }),
  JSON.stringify({ outcome: "error", durationMs: 100 }),
  "not-json-line",
  "",
].join("\n")

describe("stats --completion aggregation", () => {
  test("groups by model and counts outcomes", () => {
    const { rows, byModel } = aggregateCompletionRates(ledger)
    expect(rows.length).toBe(5)

    const gpt = byModel.get("teai/gpt-5")!
    expect(gpt.total).toBe(3)
    expect(gpt.completed).toBe(2)
    expect(gpt.errored).toBe(1)
    expect(gpt.totalMs).toBe(4500)

    const sonnet = byModel.get("teai/claude-sonnet-4-5")!
    expect(sonnet.total).toBe(1)
    expect(sonnet.completed).toBe(1)

    const fallback = byModel.get("(default)")!
    expect(fallback.total).toBe(1)
    expect(fallback.errored).toBe(1)
  })

  test("skips malformed lines without failing", () => {
    const { rows } = aggregateCompletionRates("{broken\n" + JSON.stringify({ outcome: "completed" }))
    expect(rows.length).toBe(1)
  })

  test("formats rates sorted by total descending", () => {
    const lines = formatCompletionRates(ledger)
    expect(lines[0]).toBe("Model completion rates (5 runs)")
    expect(lines[1]).toMatch(/^─+$/)
    expect(lines[2]).toContain("teai/gpt-5")
    expect(lines[2]).toContain("67%")
    expect(lines[2]).toContain("2/3")
    expect(lines[3]).toContain("teai/claude-sonnet-4-5")
    expect(lines[4]).toContain("(default)")
  })

  test("handles empty ledger", () => {
    const lines = formatCompletionRates("")
    expect(lines[0]).toBe("Model completion rates (0 runs)")
    expect(lines.length).toBe(2)
  })
})

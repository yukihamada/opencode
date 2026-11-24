import { describe, expect, test } from "bun:test"
import { LLMEvent } from "@sente-ai/llm"
import { Effect, Stream } from "effect"
import { SessionGoalRunner } from "../../src/session/goal-runner"

// $1 per million input tokens.
const cost = (event: { usage?: { inputTokens?: number } }) => (event.usage?.inputTokens ?? 0) / 1_000_000

describe("goal review reading", () => {
  test("a finished review reports its text and cost", async () => {
    const events = Stream.make(
      LLMEvent.textDelta({ id: "t", text: "VERDICT: done" }),
      LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 100_000 } }),
      LLMEvent.finish({ reason: "stop", usage: { inputTokens: 100_000 } }),
    )
    const read = await Effect.runPromise(SessionGoalRunner.readReview(events, cost))
    expect(read.text).toBe("VERDICT: done")
    expect(read.cost).toBeCloseTo(0.1, 6)
    expect(read.error).toBeUndefined()
  })

  test("a review that fails part way still reports the cost of the steps it finished", async () => {
    const events = Stream.concat(
      Stream.make(
        LLMEvent.textDelta({ id: "t", text: "VERDICT: do" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 100_000 } }),
      ),
      Stream.fail("connection dropped"),
    )
    const read = await Effect.runPromise(SessionGoalRunner.readReview(events, cost))
    expect(read.cost).toBeCloseTo(0.1, 6)
    expect(read.error).toBeDefined()
  })

  test("a review that fails before any step costs nothing it can know of", async () => {
    const read = await Effect.runPromise(SessionGoalRunner.readReview(Stream.fail("refused"), cost))
    expect(read.cost).toBe(0)
    expect(read.error).toBeDefined()
  })
})

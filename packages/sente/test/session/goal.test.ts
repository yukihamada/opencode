import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@sente-ai/core/v1/session"
import { SessionGoal } from "../../src/session/goal"

const goal = (patch: Partial<SessionGoal.State> = {}): SessionGoal.State => ({
  ...SessionGoal.create("make the tests pass", 1, {}),
  ...patch,
})

const text = (value: string, extra: Record<string, unknown> = {}) =>
  ({ id: "p", sessionID: "s", messageID: "m", type: "text", text: value, ...extra }) as SessionV1.Part

describe("session goal", () => {
  test("parses show, clear, resume and a quoted condition", () => {
    expect(SessionGoal.parse("", "en")).toEqual({ type: "show" })
    expect(SessionGoal.parse("  clear ", "en")).toEqual({ type: "clear" })
    expect(SessionGoal.parse("解除", "ja")).toEqual({ type: "clear" })
    expect(SessionGoal.parse("resume", "en")).toEqual({ type: "resume" })
    expect(SessionGoal.parse('"ship the release"', "en")).toEqual({ type: "set", objective: "ship the release" })
    expect(SessionGoal.parse("「テストを通す」", "ja")).toEqual({ type: "set", objective: "テストを通す" })
    expect(SessionGoal.parse("x".repeat(SessionGoal.MAX_OBJECTIVE + 1), "en").type).toBe("invalid")
  })

  test("the loop can be turned off", () => {
    expect(SessionGoal.enabled({})).toBe(true)
    expect(SessionGoal.enabled({ SENTE_GOAL_LOOP: "0" })).toBe(false)
    expect(SessionGoal.enabled({ SENTE_GOAL_LOOP: "off" })).toBe(false)
    expect(SessionGoal.enabled({ SENTE_GOAL_LOOP: "1" })).toBe(true)
  })

  test("max rounds defaults to 20 and can be set", () => {
    expect(SessionGoal.maxRounds({})).toBe(20)
    expect(SessionGoal.maxRounds({ SENTE_GOAL_MAX_ROUNDS: "5" })).toBe(5)
    expect(SessionGoal.maxRounds({ SENTE_GOAL_MAX_ROUNDS: "0" })).toBe(20)
    expect(SessionGoal.maxRounds({ SENTE_GOAL_MAX_ROUNDS: "abc" })).toBe(20)
    expect(SessionGoal.maxRounds({ SENTE_GOAL_MAX_ROUNDS: "9999" })).toBe(SessionGoal.MAX_ROUNDS_CEILING)
  })

  test("metadata round-trips and other keys are kept", () => {
    const state = goal()
    const metadata = SessionGoal.withGoal({ cost_limit_usd: 2 }, state)
    expect(metadata.cost_limit_usd).toBe(2)
    expect(SessionGoal.read(metadata)).toEqual(state)
    expect(SessionGoal.withGoal(metadata, undefined)).toEqual({ cost_limit_usd: 2 })
    expect(SessionGoal.read({ goal: { id: 1 } })).toBeUndefined()
  })

  test("done completes, blocked pauses, continue counts a round", () => {
    expect(SessionGoal.decide(goal(), { verdict: "done", reason: "tests pass" }, 2, "en")).toEqual({
      type: "complete",
      reason: "tests pass",
    })
    expect(SessionGoal.decide(goal(), { verdict: "blocked", reason: "needs a key" }, 2, "en")).toEqual({
      type: "pause",
      reason: "needs a key",
    })
    const next = SessionGoal.decide(goal(), { verdict: "continue", reason: "no tests run", next: "run them" }, 2, "en")
    expect(next.type).toBe("continue")
    if (next.type === "continue") {
      expect(next.goal.rounds).toBe(1)
      expect(next.goal.repeats).toBe(1)
      expect(next.goal.reason).toBe("no tests run")
      expect(next.next).toBe("run them")
    }
  })

  test("no verdict pauses instead of looping", () => {
    expect(SessionGoal.decide(goal(), undefined, 2, "en").type).toBe("pause")
  })

  test("stops at the round limit", () => {
    expect(SessionGoal.exhausted(goal({ rounds: 19, maxRounds: 20 }), "en")).toBeUndefined()
    expect(SessionGoal.exhausted(goal({ rounds: 20, maxRounds: 20 }), "en")).toContain("20")
    expect(
      SessionGoal.decide(goal({ rounds: 20, maxRounds: 20 }), { verdict: "continue", reason: "x" }, 2, "en").type,
    ).toBe("pause")
  })

  test("stops when the same missing point comes back three times in a row", () => {
    let state = goal()
    const decisions = ["The build still fails.", "the build still fails", "The build  still fails!"].map((reason) => {
      const decision = SessionGoal.decide(state, { verdict: "continue", reason }, 2, "en")
      if (decision.type === "continue") state = decision.goal
      return decision.type
    })
    expect(decisions).toEqual(["continue", "continue", "pause"])
  })

  test("a different missing point resets the repeat count", () => {
    let state = goal()
    const decisions = ["build fails", "build fails", "lint fails", "build fails"].map((reason) => {
      const decision = SessionGoal.decide(state, { verdict: "continue", reason }, 2, "en")
      if (decision.type === "continue") state = decision.goal
      return decision.type
    })
    expect(decisions).toEqual(["continue", "continue", "continue", "continue"])
  })

  test("parses labelled lines, JSON and decorated answers", () => {
    expect(SessionGoal.parseVerdict("VERDICT: continue\nREASON: no tests\nNEXT: run tests")).toEqual({
      verdict: "continue",
      reason: "no tests",
      next: "run tests",
    })
    expect(SessionGoal.parseVerdict('{"verdict":"done","reason":"all green"}')).toEqual({
      verdict: "done",
      reason: "all green",
      next: undefined,
    })
    expect(SessionGoal.parseVerdict("<think>hmm</think>\n**Verdict**: Blocked\n**Reason**: 鍵が必要")).toEqual({
      verdict: "blocked",
      reason: "鍵が必要",
      next: undefined,
    })
    expect(SessionGoal.parseVerdict("VERDICT: done\nREASON: `cat a.txt` shows 1 2 3")?.reason).toBe(
      "`cat a.txt` shows 1 2 3",
    )
    expect(SessionGoal.parseVerdict('VERDICT: done\nREASON: "quoted"')?.reason).toBe("quoted")
    expect(SessionGoal.parseVerdict("I think it is fine")).toBeUndefined()
  })

  test("the user's own message is an interjection; goal and synthetic messages are not", () => {
    const meta = { metadata: { source: "goal", goalID: "g" } }
    expect(SessionGoal.interjected([text("what is the status?")])).toBe(true)
    expect(SessionGoal.interjected([text("Goal: x", meta), text("instructions", { ...meta, synthetic: true })])).toBe(
      false,
    )
    expect(SessionGoal.interjected([text("continue", { synthetic: true })])).toBe(false)
  })

  test("the reminder goes after the first message only when history lost the goal", () => {
    const state = goal()
    const make = (value: string) => ({ role: "user", content: value })
    const model = [
      { role: "user", content: "summary" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "latest" },
    ]
    const lost = SessionGoal.withReminder(model, state, [], make)
    expect(lost).toHaveLength(4)
    expect(lost[1]?.content).toContain("make the tests pass")
    // The cached tail stays where it was.
    expect(lost.at(-1)).toEqual(model.at(-1))
    const kept = [
      { info: { id: "m" }, parts: [text("Goal", { metadata: { source: "goal", goalID: state.id } })] },
    ] as unknown as SessionV1.WithParts[]
    expect(SessionGoal.withReminder(model, state, kept, make)).toBe(model)
    expect(SessionGoal.withReminder(model, { ...state, status: "paused" }, [], make)).toBe(model)
  })

  test("the continuation states the goal, what is missing and the round", () => {
    const state = goal({ rounds: 2, maxRounds: 20 })
    const ja = SessionGoal.continuation(state, "テスト未実行", "テストを実行", "ja")
    expect(ja).toContain("ゴール: make the tests pass")
    expect(ja).toContain("未達の点: テスト未実行")
    expect(ja).toContain("次の一手: テストを実行")
    expect(ja).toContain("2/20")
    expect(SessionGoal.continuation(state, "no tests", undefined, "en")).toContain("Not met yet: no tests")
  })

  test("the transcript starts at the goal, clips tool output and lists open todos", () => {
    const messages = [
      { info: { id: "a", role: "user" }, parts: [text("earlier chat")] },
      {
        info: { id: "b", role: "user" },
        parts: [text("Goal: x", { metadata: { source: "goal", goalID: "g" } })],
      },
      {
        info: { id: "c", role: "assistant" },
        parts: [
          text("running tests"),
          {
            type: "tool",
            tool: "bash",
            state: { status: "completed", input: { command: "bun test" }, output: "ok ".repeat(1000) },
          },
        ],
      },
    ] as unknown as SessionV1.WithParts[]
    const log = SessionGoal.transcript(messages, { id: "g" }, [
      { content: "docs", status: "pending" },
      { content: "code", status: "completed" },
    ])
    expect(log).not.toContain("earlier chat")
    expect(log).toContain("[user] Goal: x")
    expect(log).toContain("[tool bash]")
    expect(log).toContain("bun test")
    expect(log.length).toBeLessThan(2_000)
    expect(log).toContain("- [pending] docs")
    expect(log).not.toContain("code")
  })
})

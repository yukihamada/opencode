import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@sente-ai/core/v1/session"
import { SessionGoal } from "../../src/session/goal"

const goal = (patch: Partial<SessionGoal.State> = {}): SessionGoal.State => ({
  ...SessionGoal.create({ objective: "make the tests pass" }, 1, {}),
  ...patch,
})

const text = (value: string, extra: Record<string, unknown> = {}) =>
  ({ id: "p", sessionID: "s", messageID: "m", type: "text", text: value, ...extra }) as SessionV1.Part

const cont = (reason: string) => ({ verdict: "continue" as const, reason })

describe("session goal", () => {
  test("parses show, clear, resume, flags and a quoted condition", () => {
    expect(SessionGoal.parse("", "en")).toEqual({ type: "show" })
    expect(SessionGoal.parse("  clear ", "en")).toEqual({ type: "clear" })
    expect(SessionGoal.parse("解除", "ja")).toEqual({ type: "clear" })
    expect(SessionGoal.parse("resume", "en")).toEqual({ type: "resume" })
    expect(SessionGoal.parse('"ship the release"', "en")).toEqual({ type: "set", objective: "ship the release" })
    expect(SessionGoal.parse("「テストを通す」", "ja")).toEqual({ type: "set", objective: "テストを通す" })
    expect(SessionGoal.parse("--budget $5 --max-rounds 4 ship it", "en")).toEqual({
      type: "set",
      objective: "ship it",
      budget: 5,
      maxRounds: 4,
    })
    expect(SessionGoal.parse("--budget=0.5 ship", "en")).toEqual({ type: "set", objective: "ship", budget: 0.5 })
    expect(SessionGoal.parse("--budget 0 ship", "en").type).toBe("invalid")
    expect(SessionGoal.parse("x".repeat(SessionGoal.MAX_OBJECTIVE + 1), "en").type).toBe("invalid")
  })

  test("limits may follow the condition and --loop asks for the built-in loop", () => {
    expect(SessionGoal.parse("ship it --budget 5", "en")).toEqual({ type: "set", objective: "ship it", budget: 5 })
    expect(SessionGoal.parse("--budget 2 ship it --max-rounds 3", "en")).toEqual({
      type: "set",
      objective: "ship it",
      budget: 2,
      maxRounds: 3,
    })
    expect(SessionGoal.parse("--loop --budget 1 ship it", "en")).toEqual({
      type: "set",
      objective: "ship it",
      budget: 1,
      loop: true,
    })
    expect(SessionGoal.parse("--loop resume", "en")).toEqual({ type: "resume", loop: true })
    expect(SessionGoal.parse("ship it --loop", "en")).toEqual({ type: "set", objective: "ship it", loop: true })
    // In the middle, flags are words of the condition.
    expect(SessionGoal.parse("sente run に --loop オプションを追加する", "ja")).toEqual({
      type: "set",
      objective: "sente run に --loop オプションを追加する",
    })
    expect(SessionGoal.parse("--budget の説明を README に書く", "ja")).toEqual({
      type: "set",
      objective: "--budget の説明を README に書く",
    })
    expect(SessionGoal.parse("README に --budget の説明を書く", "ja")).toEqual({
      type: "set",
      objective: "README に --budget の説明を書く",
    })
    // A word that only looks like a flag inside the condition stays.
    expect(SessionGoal.parse("explain the --budget flag in the README", "en")).toEqual({
      type: "set",
      objective: "explain the --budget flag in the README",
    })
    // At the start or the end, a single ASCII word after the flag is a mistyped value.
    expect(SessionGoal.parse("--budget abc ship it", "en").type).toBe("invalid")
    expect(SessionGoal.parse("ship it --max-rounds three", "en").type).toBe("invalid")
    expect(SessionGoal.parse("ship it --budget three", "ja")).toMatchObject({
      type: "invalid",
      reason: expect.stringContaining("three"),
    })
    // At the end it may be the condition's own words: the notice says how to keep them.
    expect(SessionGoal.parse("explain the --budget flag", "ja")).toMatchObject({
      type: "invalid",
      reason: expect.stringContaining("引用符"),
    })
    expect(SessionGoal.parse('"explain the --budget flag"', "en")).toEqual({
      type: "set",
      objective: "explain the --budget flag",
    })
  })

  test("amounts are read the way people type them, and unreadable ones are errors", () => {
    const budget = (text: string) => {
      const parsed = SessionGoal.parse(text, "en")
      return parsed.type === "set" ? parsed.budget : parsed.type
    }
    expect(budget("--budget ５ ship")).toBe(5)
    expect(budget("--budget ０．５ ship")).toBe(0.5)
    expect(budget("--budget .5 ship")).toBe(0.5)
    expect(budget("--budget $3 ship")).toBe(3)
    expect(budget("--budget ＄３ ship")).toBe(3)
    expect(budget("--budget 3ドル ship")).toBe(3)
    expect(budget("--budget 3usd ship")).toBe(3)
    expect(budget("ship it --budget ０．２５")).toBe(0.25)
    // Other currencies are not converted, and nothing falls back to the default silently.
    expect(budget("--budget 300円 ship")).toBe("invalid")
    expect(SessionGoal.parse("--budget 300円 ship", "ja")).toMatchObject({ reason: expect.stringContaining("ドル") })
    expect(budget("--budget 3x ship")).toBe("invalid")
    expect(budget("ship it --budget 1..2")).toBe("invalid")
    expect(budget("--budget 0 ship")).toBe("invalid")
    const rounds = (text: string) => {
      const parsed = SessionGoal.parse(text, "en")
      return parsed.type === "set" ? parsed.maxRounds : parsed.type
    }
    expect(rounds("--max-rounds ５ ship")).toBe(5)
    expect(rounds("--max-rounds 5回 ship")).toBe(5)
    expect(rounds("--max-rounds 2.5 ship")).toBe("invalid")
    // A plain word after the flag is still the condition.
    expect(SessionGoal.parse("--budget の説明を README に書く", "ja")).toEqual({
      type: "set",
      objective: "--budget の説明を README に書く",
    })
  })

  test("a user's own goal command wins unless SENTE_GOAL_LOOP=1", () => {
    expect(SessionGoal.useLoop(false, {})).toBe(true)
    expect(SessionGoal.useLoop(true, {})).toBe(false)
    expect(SessionGoal.useLoop(true, { SENTE_GOAL_LOOP: "1" })).toBe(true)
    expect(SessionGoal.useLoop(false, { SENTE_GOAL_LOOP: "0" })).toBe(false)
  })

  test("defaults: 20 rounds and a $3 budget, both configurable", () => {
    expect(SessionGoal.maxRounds({})).toBe(20)
    expect(SessionGoal.maxRounds({ SENTE_GOAL_MAX_ROUNDS: "5" })).toBe(5)
    expect(SessionGoal.maxRounds({ SENTE_GOAL_MAX_ROUNDS: "0" })).toBe(20)
    expect(SessionGoal.maxRounds({ SENTE_GOAL_MAX_ROUNDS: "9999" })).toBe(SessionGoal.MAX_ROUNDS_CEILING)
    expect(SessionGoal.budget({})).toBe(3)
    expect(SessionGoal.budget({ SENTE_GOAL_BUDGET_USD: "$1.5" })).toBe(1.5)
    expect(goal().budget).toBe(3)
  })

  test("metadata round-trips and other keys are kept", () => {
    const state = goal()
    const metadata = SessionGoal.withGoal({ cost_limit_usd: 2 }, state)
    expect(metadata.cost_limit_usd).toBe(2)
    expect(SessionGoal.read(metadata)).toEqual(state)
    expect(SessionGoal.withGoal(metadata, undefined)).toEqual({ cost_limit_usd: 2 })
    expect(SessionGoal.read({ goal: { id: 1 } })).toBeUndefined()
  })

  test("a goal of an exited process or an earlier boot is orphaned; a live owner's is not", () => {
    expect(SessionGoal.orphaned(goal())).toBe(false)
    expect(SessionGoal.orphaned(goal({ owner: { pid: process.pid, boot: "earlier" } }))).toBe(true)
    expect(SessionGoal.orphaned(goal({ owner: { pid: 999_999, boot: "x" } }), () => false)).toBe(true)
    expect(SessionGoal.orphaned(goal({ owner: { pid: 999_999, boot: "x" } }), () => true)).toBe(false)
    expect(SessionGoal.orphaned(goal({ status: "paused", owner: undefined }))).toBe(false)
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
    const next = SessionGoal.decide(goal(), { ...cont("no tests run"), next: "run them" }, 2, "en")
    expect(next.type).toBe("continue")
    if (next.type === "continue") {
      expect(next.goal.rounds).toBe(1)
      expect(next.goal.repeats).toBe(1)
      expect(next.next).toBe("run them")
    }
    expect(SessionGoal.decide(goal(), undefined, 2, "en").type).toBe("pause")
  })

  test("the last round is still reviewed: done wins over the round limit", () => {
    const last = goal({ rounds: 20, maxRounds: 20 })
    expect(SessionGoal.decide(last, { verdict: "done", reason: "ok" }, 2, "en").type).toBe("complete")
    const stop = SessionGoal.decide(last, cont("x"), 2, "en")
    expect(stop.type).toBe("pause")
    expect(stop.reason).toContain("20")
  })

  test("continue stops once the budget is spent", () => {
    const decision = SessionGoal.decide(goal({ budget: 1, spent: 1.2 }), cont("more work"), 2, "en")
    expect(decision.type).toBe("pause")
    expect(decision.reason).toContain("$1.00")
  })

  test("stops when the same missing point comes back three times, worded differently", () => {
    let state = goal()
    const decisions = ["The build still fails.", "the build still fails", "The build  still fails!"].map((reason) => {
      const decision = SessionGoal.decide(state, cont(reason), 2, "en")
      if (decision.type === "continue") state = decision.goal
      return decision.type
    })
    expect(decisions).toEqual(["continue", "continue", "pause"])
  })

  test("a falling count is progress, not a repeat", () => {
    let state = goal()
    const decisions = ["5 tests fail", "3 tests fail", "1 tests fail", "1 tests fail"].map((reason) => {
      const decision = SessionGoal.decide(state, cont(reason), 2, "en")
      if (decision.type === "continue") state = decision.goal
      return decision.type
    })
    expect(decisions).toEqual(["continue", "continue", "continue", "continue"])
    expect(SessionGoal.sameReason("テストが5件失敗", "テストが3件失敗")).toBe(false)
    expect(SessionGoal.sameReason("テストが5件失敗しています", "テストが5件失敗している")).toBe(true)
  })

  test("parses only an exact VERDICT line and takes the last one", () => {
    expect(SessionGoal.parseVerdict("VERDICT: continue\nREASON: no tests\nNEXT: run tests")).toEqual({
      verdict: "continue",
      reason: "no tests",
      next: "run tests",
    })
    expect(SessionGoal.parseVerdict("<think>hmm</think>\n**VERDICT**: Blocked\n**REASON**: 鍵が必要")).toEqual({
      verdict: "blocked",
      reason: "鍵が必要",
      next: undefined,
    })
    expect(SessionGoal.parseVerdict("VERDICT: done\nREASON: `cat a.txt` shows 1 2 3")?.reason).toBe(
      "`cat a.txt` shows 1 2 3",
    )
    // Bold, numbered and bulleted labels are read.
    expect(SessionGoal.parseVerdict("**VERDICT:** continue\n**REASON:** lint fails")).toEqual({
      verdict: "continue",
      reason: "lint fails",
      next: undefined,
    })
    expect(SessionGoal.parseVerdict("VERDICT:** done\nREASON:** ok")?.verdict).toBe("done")
    expect(SessionGoal.parseVerdict("1. VERDICT: done\n2. REASON: tests pass")).toEqual({
      verdict: "done",
      reason: "tests pass",
      next: undefined,
    })
    expect(SessionGoal.parseVerdict("- **Verdict**: blocked")?.verdict).toBe("blocked")
    // An example in the answer is not the verdict, even as the last match.
    expect(SessionGoal.parseVerdict("VERDICT: continue\nREASON: x\nExample: VERDICT: done")?.verdict).toBe("continue")
    expect(SessionGoal.parseVerdict("例: VERDICT: done")).toBeUndefined()
    // Lines in a code block are quoted material, not the answer.
    expect(
      SessionGoal.parseVerdict("VERDICT: continue\nREASON: lint fails\n```\nVERDICT: done\nREASON: all green\n```"),
    ).toEqual({ verdict: "continue", reason: "lint fails", next: undefined })
    // An answer wrapped whole in a code block is still read.
    expect(SessionGoal.parseVerdict("```\nVERDICT: continue\nREASON: lint fails\nNEXT: fix lint\n```")).toEqual({
      verdict: "continue",
      reason: "lint fails",
      next: "fix lint",
    })
    expect(SessionGoal.parseVerdict("```text\nVERDICT: done\nREASON: all green\n```")).toEqual({
      verdict: "done",
      reason: "all green",
      next: undefined,
    })
    expect(SessionGoal.parseVerdict("```\nVERDICT: blocked\nREASON: needs a key\n```")?.verdict).toBe("blocked")
    expect(SessionGoal.parseVerdict("```\nno verdict here\n```")).toBeUndefined()
    // An ordinary lead-in of any length outside the block still lets the block be read.
    expect(
      SessionGoal.parseVerdict(
        "作業ログを確認しました。テストの実行結果と生成されたファイルの内容をもとに、ゴールの達成状況を判定します。\n```\nVERDICT: done\nREASON: テストが全件通過\n```",
      )?.verdict,
    ).toBe("done")
    expect(
      SessionGoal.parseVerdict(
        "Based on the work log, here is my assessment of the goal:\n```\nVERDICT: continue\nREASON: lint fails\n```",
      )?.verdict,
    ).toBe("continue")
    // Text outside that says the work is not finished, or names a verdict, wins over the block.
    expect(
      SessionGoal.parseVerdict("Here is my log:\n```\nVERDICT: done\n```\nI think it is not finished."),
    ).toBeUndefined()
    expect(
      SessionGoal.parseVerdict("ログを貼ります。\n```\nVERDICT: done\n```\nただしテストはまだ通っていません。"),
    ).toBeUndefined()
    expect(SessionGoal.parseVerdict("The README shows this verdict format:\n```\nVERDICT: done\n```")).toBeUndefined()
    // An example block after the answer is not the answer, and REASON comes from the chosen block.
    expect(
      SessionGoal.parseVerdict(
        "VERDICT: continue\nREASON: lint fails\nNEXT: fix lint\n\nExample:\nVERDICT: done\nREASON: all green",
      ),
    ).toEqual({ verdict: "continue", reason: "lint fails", next: "fix lint" })
    expect(SessionGoal.parseVerdict("VERDICT: blocked\nREASON: needs a key\n例:\n**VERDICT:** done")?.verdict).toBe(
      "blocked",
    )
    // Prose and echoed instructions never read as done.
    expect(SessionGoal.parseVerdict("VERDICT: not done yet, continue")).toBeUndefined()
    expect(SessionGoal.parseVerdict("VERDICT: done | continue | blocked")).toBeUndefined()
    expect(SessionGoal.parseVerdict("I think it is done.")).toBeUndefined()
    expect(SessionGoal.parseVerdict("VERDICT: done\nwait, no.\nVERDICT: continue\nREASON: lint fails")?.verdict).toBe(
      "continue",
    )
    // The prompt's own instruction line, echoed back, is not a verdict.
    const echoed = SessionGoal.judgePrompt(goal(), "log", "en")
      .split("\n")
      .filter((line) => line.startsWith("Line 1"))
      .join("\n")
    expect(SessionGoal.parseVerdict(echoed)).toBeUndefined()
  })

  test("the user's own message is an interjection; goal, synthetic and automated messages are not", () => {
    const meta = { metadata: { source: "goal", goalID: "g" } }
    expect(SessionGoal.interjected([text("what is the status?")])).toBe(true)
    expect(SessionGoal.interjected([text("Goal: x", meta), text("instructions", { ...meta, synthetic: true })])).toBe(
      false,
    )
    expect(SessionGoal.interjected([text("continue", { synthetic: true })])).toBe(false)
    expect(SessionGoal.interjected([text("check the queue", { metadata: { source: "loop", loopID: "l1" } })])).toBe(
      false,
    )
    // The user's own words next to an automated part still count.
    expect(
      SessionGoal.interjected([
        text("check the queue", { metadata: { source: "loop", loopID: "l1" } }),
        text("and also stop the deploy"),
      ]),
    ).toBe(true)
    // Files attached to the goal's kickoff belong to the goal.
    expect(
      SessionGoal.interjected([
        text("Goal: x", meta),
        {
          id: "f",
          sessionID: "s",
          messageID: "m",
          type: "file",
          mime: "image/png",
          url: "file:///a.png",
        } as SessionV1.Part,
      ]),
    ).toBe(false)
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
    expect(lost.at(-1)).toEqual(model.at(-1))
    const kept = [
      { info: { id: "m", role: "user" }, parts: [text("Goal", { metadata: { source: "goal", goalID: state.id } })] },
    ] as unknown as SessionV1.WithParts[]
    expect(SessionGoal.withReminder(model, state, kept, make)).toBe(model)
    expect(SessionGoal.withReminder(model, { ...state, status: "paused" }, [], make)).toBe(model)
  })

  test("a review that pushes a met goal past its budget is called out", () => {
    const note = SessionGoal.judgeOverrunNote(goal({ budget: 0.15, spent: 0.2 }), "ja")
    expect(note).toContain("判定費用で予算を超過")
    expect(note).toContain("$0.20")
  })

  test("a $0 model is called out: only the round limit stops the goal", () => {
    const state = goal({ note: SessionGoal.freeModelNote("en") })
    expect(SessionGoal.describe(state, "en")).toContain("only the round limit")
    expect(SessionGoal.settledNote({ ...state, status: "paused", reason: "x" }, "en")).toContain("$0")
    expect(SessionGoal.read(SessionGoal.withGoal(undefined, state))?.note).toBe(state.note)
  })

  test("the continuation states the goal, what is missing and the round", () => {
    const state = goal({ rounds: 2, maxRounds: 20 })
    const ja = SessionGoal.continuation(state, "テスト未実行", "テストを実行", "ja")
    expect(ja).toContain("ゴール: make the tests pass")
    expect(ja).toContain("未達の点: テスト未実行")
    expect(ja).toContain("次の一手: テストを実行")
    expect(ja).toContain("2/20")
    expect(SessionGoal.continuation(state, "no tests", "-", "en")).not.toContain("Next step")
  })

  test("long tool output keeps its end, where test summaries are", () => {
    const output = "line\n".repeat(2_000) + "Tests: 42 passed, 0 failed"
    const messages = [
      { info: { id: "b", role: "user" }, parts: [text("Goal: x", { metadata: { source: "goal", goalID: "g" } })] },
      {
        info: { id: "c", role: "assistant" },
        parts: [{ type: "tool", tool: "bash", state: { status: "completed", input: { command: "bun test" }, output } }],
      },
    ] as unknown as SessionV1.WithParts[]
    const log = SessionGoal.transcript(messages, { id: "g" })
    expect(log).toContain("Tests: 42 passed, 0 failed")
    expect(log).toContain("chars omitted")
    expect(log.length).toBeLessThan(1_500)
  })

  test("the transcript starts at the goal, keeps the newest work and lists open todos", () => {
    const messages = [
      { info: { id: "a", role: "user" }, parts: [text("earlier chat")] },
      { info: { id: "b", role: "user" }, parts: [text("Goal: x", { metadata: { source: "goal", goalID: "g" } })] },
      ...Array.from({ length: 60 }, (_, i) => ({
        info: { id: `c${i}`, role: "assistant" },
        parts: [text(`step ${i} ` + "x".repeat(1_000))],
      })),
    ] as unknown as SessionV1.WithParts[]
    const log = SessionGoal.transcript(messages, { id: "g" }, [
      { content: "docs", status: "pending" },
      { content: "code", status: "completed" },
    ])
    expect(log).not.toContain("earlier chat")
    expect(log).toContain("step 59")
    expect(log).not.toContain("step 0 ")
    expect(log).toContain("- [pending] docs")
    expect(log).not.toContain("[completed] code")
  })
})

import { describe, expect, test } from "bun:test"
import {
  describeGoal,
  goalLabel,
  goalSettledNotice,
  parseGoalCommand,
  readGoal,
  withoutGoal,
} from "../../src/util/goal"

const active = { id: "g", objective: "ship it", status: "active" as const, rounds: 3, maxRounds: 20 }

describe("util.goal", () => {
  test("handles show and clear locally and sends everything else to the server", () => {
    expect(parseGoalCommand("/goal")).toEqual({ type: "show" })
    expect(parseGoalCommand(" /goal clear ")).toEqual({ type: "clear" })
    expect(parseGoalCommand("/goal 解除")).toEqual({ type: "clear" })
    expect(parseGoalCommand("/goal ship the release")).toBeUndefined()
    expect(parseGoalCommand("/goal resume")).toBeUndefined()
    expect(parseGoalCommand("/goals")).toBeUndefined()
  })

  test("reads the goal from session metadata", () => {
    expect(readGoal({ goal: { ...active, repeats: 1, updatedAt: 1 } })).toEqual(active)
    expect(readGoal({ goal: { id: "g" } })).toBeUndefined()
    expect(readGoal(undefined)).toBeUndefined()
    expect(withoutGoal({ goal: active, cost_limit_usd: 2 })).toEqual({ cost_limit_usd: 2 })
  })

  test("shows a short label only while the goal is active", () => {
    expect(goalLabel(active, "ja")).toBe("ゴール 3/20")
    expect(goalLabel(active, "en")).toBe("goal 3/20")
    expect(goalLabel({ ...active, status: "complete" }, "ja")).toBeUndefined()
    expect(goalLabel(undefined, "ja")).toBeUndefined()
  })

  test("describes the goal in both languages", () => {
    expect(describeGoal(active, "ja")).toContain("ゴール進行中")
    expect(describeGoal({ ...active, status: "paused", reason: "上限" }, "en")).toContain("Goal paused")
    expect(describeGoal(undefined, "ja")).toContain("使い方")
  })

  test("notices only when an active goal ends", () => {
    expect(goalSettledNotice(active, { ...active, status: "complete", reason: "done" }, "ja")).toEqual({
      variant: "success",
      message: "ゴール達成: done",
    })
    expect(goalSettledNotice(active, { ...active, status: "paused", reason: "limit" }, "en")?.variant).toBe("warning")
    expect(goalSettledNotice(active, { ...active, rounds: 4 }, "ja")).toBeUndefined()
    expect(goalSettledNotice(undefined, { ...active, status: "complete" }, "ja")).toBeUndefined()
    expect(goalSettledNotice(active, { ...active, id: "other", status: "complete" }, "ja")).toBeUndefined()
  })
})

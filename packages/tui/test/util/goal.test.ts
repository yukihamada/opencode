import { describe, expect, test } from "bun:test"
import {
  BUILTIN_GOAL_DESCRIPTION,
  describeGoal,
  goalLabel,
  goalSettledNotice,
  readGoal,
  showsGoalLocally,
} from "../../src/util/goal"

const active = {
  id: "g",
  objective: "ship it",
  status: "active" as const,
  rounds: 3,
  maxRounds: 20,
  budget: 3,
  spent: 0.42,
  judgeCost: 0.003,
}

describe("util.goal", () => {
  test("shows /goal locally only for the built-in command or an existing goal", () => {
    const builtin = { description: BUILTIN_GOAL_DESCRIPTION }
    const custom = { description: "完了条件から仕事を進める" }
    expect(showsGoalLocally("/goal", builtin, false)).toBe(true)
    expect(showsGoalLocally("/goal ", custom, true)).toBe(true)
    // A user's own goal command with no arguments still runs as that command.
    expect(showsGoalLocally("/goal", custom, false)).toBe(false)
    // Setting, resume and clear go to the server.
    expect(showsGoalLocally("/goal clear", builtin, true)).toBe(false)
    expect(showsGoalLocally("/goal ship it", builtin, false)).toBe(false)
    expect(showsGoalLocally("/goals", builtin, false)).toBe(false)
  })

  test("reads the goal and its costs from session metadata", () => {
    expect(readGoal({ goal: { ...active, repeats: 1, updatedAt: 1, baseCost: 0 } })).toEqual(active)
    expect(readGoal({ goal: { id: "g" } })).toBeUndefined()
    expect(readGoal(undefined)).toBeUndefined()
  })

  test("shows a short label with rounds and spend only while the goal is active", () => {
    expect(goalLabel(active, "ja")).toBe("ゴール 3/20 · $0.42/$3.00")
    expect(goalLabel(active, "en")).toBe("goal 3/20 · $0.42/$3.00")
    expect(goalLabel({ ...active, status: "complete" }, "ja")).toBeUndefined()
    expect(goalLabel(undefined, "ja")).toBeUndefined()
  })

  test("describes the goal with its costs in both languages", () => {
    expect(describeGoal(active, "ja")).toContain("ゴール進行中")
    expect(describeGoal(active, "ja")).toContain("うち判定 $0.0030")
    expect(describeGoal({ ...active, status: "paused", reason: "上限" }, "en")).toContain("Goal paused")
    expect(describeGoal(undefined, "ja")).toContain("使い方")
  })

  test("notices only when an active goal ends, with what it cost", () => {
    const met = goalSettledNotice(active, { ...active, status: "complete", reason: "done" }, "ja")
    expect(met?.variant).toBe("success")
    expect(met?.message).toContain("ゴール達成: done")
    expect(met?.message).toContain("予算 $3.00")
    expect(goalSettledNotice(active, { ...active, status: "paused", reason: "limit" }, "en")?.variant).toBe("warning")
    expect(goalSettledNotice(active, { ...active, rounds: 4 }, "ja")).toBeUndefined()
    expect(goalSettledNotice(undefined, { ...active, status: "complete" }, "ja")).toBeUndefined()
    expect(goalSettledNotice(active, { ...active, id: "other", status: "complete" }, "ja")).toBeUndefined()
  })
})

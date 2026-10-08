import { expect, test } from "bun:test"
import { agentNavigation, agentNavigationText, cycleAgent } from "../src/util/agent-navigation"

const agents = [
  "build", "plan", "browser", "travel", "studio", "full", "investigator", "hawaii",
  "director", "evolve-hy4", "evolve-glm", "door-unlock", "door-entrance", "fb-messenger",
].map((name) => ({ name, mode: "all", permission: { edit: "ask" } }))
const config = {
  groups: {
    director: "excluded", "evolve-hy4": "excluded", "evolve-glm": "excluded", "fb-messenger": "excluded",
    "door-unlock": "operation", "door-entrance": "operation",
  },
} as const

test("shows three entrances and separates specialists, projects and verified operations", () => {
  const groups = agentNavigation(agents, config, "en-US")
  expect(groups.home.map((item) => item.agent.name)).toEqual(["full", "plan", "investigator"])
  expect(groups.specialist.map((item) => item.agent.name)).toEqual(["build", "browser", "travel", "studio"])
  expect(groups.project.map((item) => item.agent.name)).toEqual(["hawaii"])
  expect(groups.operation.map((item) => item.agent.name)).toEqual(["door-unlock", "door-entrance"])
  expect(groups.home[0].title).toBe("Delegate · full")
})

test("presentation never mutates IDs, permissions, mode or direct-selection inventory", () => {
  const before = structuredClone(agents)
  agentNavigation(agents, config)
  cycleAgent(agents, "director", 1, config)
  expect(agents).toEqual(before)
  expect(agents.find((agent) => agent.name === "director")?.mode).toBe("all")
})

test("Tab cycles only entrances, in either direction, including from a specialist", () => {
  expect(cycleAgent(agents, "full", 1, config)?.name).toBe("plan")
  expect(cycleAgent(agents, "plan", 1, config)?.name).toBe("investigator")
  expect(cycleAgent(agents, "investigator", 1, config)?.name).toBe("full")
  expect(cycleAgent(agents, "full", -1, config)?.name).toBe("investigator")
  expect(cycleAgent(agents, "travel", 1, config)?.name).toBe("full")
  expect(cycleAgent(agents, "travel", -1, config)?.name).toBe("investigator")
})

test("works without custom agents and respects hidden/subagent modes", () => {
  const groups = agentNavigation([
    { name: "full", mode: "primary", hidden: true },
    { name: "investigator", mode: "subagent" },
    { name: "build", mode: "primary" },
    { name: "plan", mode: "primary" },
  ])
  expect(groups.home.map((item) => item.agent.name)).toEqual(["build", "plan"])
  expect(groups.specialist).toEqual([])
  expect(cycleAgent([], undefined, 1)).toBeUndefined()
  expect(cycleAgent([{ name: "custom", mode: "all" }], undefined, -1)?.name).toBe("custom")
  expect(cycleAgent([{ name: "door-unlock", mode: "all" }], undefined, 1, config)).toBeUndefined()
})

test("localizes navigation and leaves unknown project names intact", () => {
  expect(agentNavigation(agents, config, "ja-JP").home.map((item) => item.title))
    .toEqual(["任せる · full", "相談・計画 · plan", "調べる · investigator"])
  expect(agentNavigation(agents, config, "ja-JP").project[0].title).toBe("hawaii")
  expect(agentNavigationText("ja-JP").operation).toBe("本人確認付き操作")
  expect(agentNavigationText("fr-FR").operation).toBe("Verified operations")
})

test("configuration classifies new agents and can exclude an entrance", () => {
  const groups = agentNavigation(agents, { groups: { full: "excluded", hawaii: "specialist" } })
  expect(groups.home.map((item) => item.agent.name)).toEqual(["build", "plan", "investigator"])
  expect(groups.specialist.some((item) => item.agent.name === "hawaii")).toBe(true)
  expect(Object.values(groups).flat().some((item) => item.agent.name === "full")).toBe(false)
})

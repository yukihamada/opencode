import type { AgentNavigation } from "../config"
import type { Schema } from "effect"
import { terminalLocale } from "./locale"

type Navigation = Schema.Schema.Type<typeof AgentNavigation>
type Agent = { name: string; mode: string; hidden?: boolean; description?: string }
export type AgentGroup = "home" | "specialist" | "project" | "operation"

export function agentNavigationText(locale = terminalLocale()) {
  return locale.startsWith("ja")
    ? {
        home: "用途で選ぶ", specialist: "その他・専門モード", project: "案件担当", operation: "本人確認付き操作",
        delegate: "任せる", plan: "相談・計画", investigate: "調べる", build: "開発", browser: "ブラウザ",
        travel: "旅行", studio: "制作", back: "戻る", search: "名前・IDで検索",
        approval: "選択だけでは実行しません。実行時は既存の承認・本人確認が必要です。",
      }
    : {
        home: "Choose by task", specialist: "More · specialist modes", project: "Project agents", operation: "Verified operations",
        delegate: "Delegate", plan: "Discuss & plan", investigate: "Investigate", build: "Development", browser: "Browser",
        travel: "Travel", studio: "Create", back: "Back", search: "Search by name or ID",
        approval: "Selecting does not execute. Existing approval and identity checks still apply.",
      }
}

// Exclusion is presentation-only. Never mutate mode/hidden or use these groups as
// an authorization boundary: --agent and resumed conversations retain their IDs.
export function agentNavigation<T extends Agent>(agents: readonly T[], config: Navigation = {}, locale = terminalLocale()) {
  const text = agentNavigationText(locale)
  const available = agents.filter((agent) => agent.mode !== "subagent" && !agent.hidden)
  const visible = available.filter((agent) => config.groups?.[agent.name] !== "excluded")
  const delegate = visible.find((agent) => agent.name === "full") ?? visible.find((agent) => agent.name === "build")
  const home = [delegate, visible.find((agent) => agent.name === "plan"), visible.find((agent) => agent.name === "investigator")]
    .filter((agent): agent is T => !!agent)
  const names: Record<string, string> = {
    full: text.delegate, build: delegate?.name === "build" ? text.delegate : text.build,
    plan: text.plan, investigator: text.investigate, browser: text.browser, travel: text.travel, studio: text.studio,
  }
  const items = visible.map((agent) => {
    const configured = config.groups?.[agent.name]
    const group: AgentGroup = home.includes(agent)
      ? "home"
      : configured && configured !== "excluded"
        ? configured
        : ["build", "browser", "travel", "studio"].includes(agent.name)
          ? "specialist"
          : "project"
    return {
      agent,
      title: names[agent.name] ? `${names[agent.name]} · ${agent.name}` : agent.name,
      group,
    }
  })
  return {
    home: home.map((agent) => items.find((item) => item.agent === agent)!),
    specialist: items.filter((item) => item.group === "specialist"),
    project: items.filter((item) => item.group === "project"),
    operation: items.filter((item) => item.group === "operation"),
  }
}

export function cycleAgent<T extends Agent>(agents: readonly T[], current: string | undefined, direction: 1 | -1, config: Navigation = {}) {
  const groups = agentNavigation(agents, config)
  const choices = groups.home.length ? groups.home : [...groups.specialist, ...groups.project]
  if (!choices.length) return undefined
  const index = choices.findIndex((item) => item.agent.name === current)
  return choices[index < 0 ? (direction === 1 ? 0 : choices.length - 1) : (index + direction + choices.length) % choices.length].agent
}

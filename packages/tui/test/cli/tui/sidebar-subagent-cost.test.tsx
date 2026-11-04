import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import type { AssistantMessage, Message, Part } from "@sente-ai/sdk/v2"
import type { TuiSlotPlugin } from "@sente-ai/plugin/tui"
import plugin from "../../../src/feature-plugins/sidebar/context"
import { createTuiPluginApi } from "../../fixture/tui-plugin"

const spent = (process.env.TE_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "en").startsWith("ja")
  ? "費用"
  : "Cost"

function assistant(id: string, cost: number): AssistantMessage {
  return {
    id, sessionID: "session", role: "assistant", parentID: "user",
    time: { created: 1 }, providerID: "local", modelID: "chat", agent: "build", mode: "build",
    path: { cwd: "/", root: "/" }, cost,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop",
  }
}

test("sidebar cost includes subagent sessions", async () => {
  const messages: Message[] = [assistant("parent", 0.4)]
  const sessions = [
    { id: "session", slug: "session", projectID: "project", directory: "/", title: "test", version: "test", time: { created: 1, updated: 1 }, cost: 0.4 },
    { id: "child", parentID: "session", slug: "child", projectID: "project", directory: "/", title: "child", version: "test", time: { created: 1, updated: 1 }, cost: 0.25 },
    { id: "grandchild", parentID: "child", slug: "grandchild", projectID: "project", directory: "/", title: "grandchild", version: "test", time: { created: 1, updated: 1 }, cost: 0.05 },
    { id: "unrelated", slug: "unrelated", projectID: "project", directory: "/", title: "unrelated", version: "test", time: { created: 1, updated: 1 }, cost: 9 },
  ]
  const api = createTuiPluginApi({
    state: {
      session: {
        messages: () => messages,
        get: (id) => sessions.find((session) => session.id === id),
        list: () => sessions,
      },
    },
  })
  api.state.part = (_id: string) => [] as Part[]
  Object.defineProperty(api.state, "provider", { value: [{ id: "local", models: { chat: { limit: { context: 128000 } } } }] })
  let view!: () => JSX.Element
  api.slots = {
    register(input: TuiSlotPlugin) {
      const render = input.slots?.sidebar_content
      if (!render) throw new Error("missing sidebar slot")
      view = () => render({ theme: api.theme }, { session_id: "session" })
      return "test-context"
    },
  }
  await plugin.tui(api, undefined, {
    id: plugin.id, source: "internal", spec: plugin.id, target: plugin.id,
    first_time: 0, last_time: 0, time_changed: 0, load_count: 1, fingerprint: "test", state: "first",
  })
  const app = await testRender(() => view(), { width: 60, height: 8 })
  try {
    await app.renderOnce()
    // 0.4 + 0.25 + 0.05; the unrelated session must not leak in.
    expect(app.captureCharFrame()).toContain(`${spent} $0.70`)
  } finally {
    app.renderer.destroy()
  }
})

import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type { AssistantMessage, Message, Part } from "@sente-ai/sdk/v2"
import type { TuiSlotPlugin } from "@sente-ai/plugin/tui"
import plugin from "../../../src/feature-plugins/sidebar/context"
import { createTuiPluginApi } from "../../fixture/tui-plugin"

test("sidebar rerenders from measured usage to compacted estimate and back", async () => {
  const japanese = (process.env.TE_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "en").startsWith("ja")
  const tokens = japanese ? "トークン" : "tokens"
  const remaining = japanese ? "残り" : "remaining"
  const spent = japanese ? "費用" : "Cost"
  const elapsed = japanese ? "経過時間" : "Elapsed"
  const used = japanese ? "使用" : "used"
  const before: AssistantMessage = {
    id: "before", sessionID: "session", role: "assistant", parentID: "old",
    time: { created: 1 }, providerID: "local", modelID: "chat", agent: "build", mode: "build",
    path: { cwd: "/", root: "/" }, cost: 0,
    tokens: { input: 90000, output: 1000, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop",
  }
  const [store, set] = createStore<{ messages: Message[]; parts: Record<string, Part[]>; cost: number; created: number }>({
    messages: [before], parts: {}, cost: 0.41, created: Date.now() - 3_720_000,
  })
  const api = createTuiPluginApi({ state: { session: {
    messages: () => store.messages,
    get: () => ({
      id: "session", slug: "session", projectID: "project", directory: "/",
      title: "test", version: "test", time: { created: store.created, updated: 1 }, cost: store.cost,
    }),
  } } })
  api.state.part = (id) => store.parts[id] ?? []
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
    expect(app.captureCharFrame()).toContain(`${used} ${(91000).toLocaleString()}`)
    expect(app.captureCharFrame()).toContain(`${remaining} ${(37000).toLocaleString()} ${tokens}`)
    expect(app.captureCharFrame()).toContain("█")
    expect(app.captureCharFrame()).toContain(`${spent} $0.41 (≈369 cr)`)
    expect(app.captureCharFrame()).toContain(`${elapsed} 1h 2m`)
    set("cost", 0.82)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(`${spent} $0.82 (≈738 cr)`)
    set("messages", [...store.messages, {
      id: "compact", sessionID: "session", role: "user", time: { created: 2 }, agent: "build",
      model: { providerID: "local", modelID: "chat" },
    }, { ...before, id: "summary", parentID: "compact", summary: true }])
    set("parts", "compact", [{ id: "marker", messageID: "compact", sessionID: "session", type: "compaction", auto: false }])
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(`${used} —`)
    set("parts", "summary", [{ id: "text", messageID: "summary", sessionID: "session", type: "text", text: "x".repeat(400) }])
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(`${used} ~106`)
    expect(app.captureCharFrame()).toContain(`${remaining} ~${(127894).toLocaleString()} ${tokens}`)
    expect(app.captureCharFrame()).not.toContain((91000).toLocaleString())
    set("messages", [...store.messages, {
      ...before, id: "next", tokens: { ...before.tokens, input: 3000, output: 200 },
    }])
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(`${used} ${(3200).toLocaleString()}`)
    expect(app.captureCharFrame()).not.toContain("~")
    expect(app.captureCharFrame()).toContain(`${remaining} ${(124800).toLocaleString()} ${tokens}`)
    set("messages", [{ ...before, tokens: { ...before.tokens, input: 150000 } }])
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(`${remaining} 0 ${tokens}`)
    set("created", Date.now() - 172_805_000)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(`${elapsed} 2d 0h`)
    set("created", Date.now() + 60_000)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(`${elapsed} 0s`)
    set("created", Date.now())
    await Bun.sleep(2100)
    await app.renderOnce()
    expect(app.captureCharFrame()).toMatch(new RegExp(`${elapsed} [12]\\.0s`))
  } finally {
    app.renderer.destroy()
  }
})

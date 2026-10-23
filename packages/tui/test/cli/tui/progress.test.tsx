import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type { PermissionRequest, QuestionRequest, SessionStatus } from "@sente-ai/sdk/v2"
import type { TuiSidebarTodoItem, TuiSlotPlugin } from "@sente-ai/plugin/tui"
import plugin from "../../../src/feature-plugins/sidebar/todo"
import { ThemeProvider } from "../../../src/context/theme"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { tmpdir } from "../../fixture/fixture"

test("progress distinguishes work, human gates, idle, cancellation and task completion", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const [store, set] = createStore<{
    todo: TuiSidebarTodoItem[]
    status: SessionStatus | undefined
    permissions: PermissionRequest[]
    questions: QuestionRequest[]
    session: string
  }>({
    todo: [
      { content: "Inspect evidence", status: "completed" },
      { content: "Check result", status: "in_progress" },
      { content: "Retired work", status: "cancelled" },
    ],
    status: { type: "busy" }, permissions: [], questions: [], session: "session",
  })
  const api = createTuiPluginApi({ state: { session: {
    todo: (id) => id === "session" ? store.todo : [],
    status: (id) => id === "session" ? store.status : { type: "idle" },
    permission: (id) => id === "session" ? store.permissions : [],
    question: (id) => id === "session" ? store.questions : [],
  } } })
  let view!: () => JSX.Element
  api.slots = { register(input: TuiSlotPlugin) {
    view = () => input.slots!.sidebar_content!({ theme: api.theme }, { get session_id() { return store.session } })
    return "progress-test"
  } }
  await plugin.tui(api, undefined, {
    id: plugin.id, source: "internal", spec: plugin.id, target: plugin.id,
    first_time: 0, last_time: 0, time_changed: 0, load_count: 1, fingerprint: "test", state: "first",
  })
  const app = await testRender(() => (
    <TestTuiContexts paths={{ state: tmp.path }}>
      <TuiConfigProvider config={createTuiResolvedConfig()}>
        <KVProvider><ThemeProvider mode="dark">{view()}</ThemeProvider></KVProvider>
      </TuiConfigProvider>
    </TestTuiContexts>
  ), { width: 60, height: 18 })
  const ja = (process.env.TE_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "en").startsWith("ja")
  async function frame() {
    await app.renderOnce()
    await Bun.sleep(25)
    await app.renderOnce()
    return app.captureCharFrame()
  }
  try {
    // Context providers render their children only after asynchronous KV/theme initialization.
    for (let i = 0; i < 100 && !(await frame()).trim(); i++) {}
    expect(await frame()).toContain(ja ? "実行中" : "Working")
    expect(await frame()).toContain("1/2")
    expect(await frame()).toContain(ja ? "1 取消" : "1 cancelled")
    expect(await frame()).not.toContain("Retired work")
    expect(await frame()).toContain(ja ? "現在: Check result" : "Current: Check result")

    set("permissions", [{ id: "permission", sessionID: "session", permission: "bash", patterns: [], metadata: {}, always: [] }])
    set("questions", [{ id: "question", sessionID: "session", questions: [] }])
    expect(await frame()).toContain(ja ? "本人待ち" : "Waiting for you")
    expect(await frame()).toContain(ja ? "許可リクエストを確認" : "review the permission request")
    set("permissions", [])
    expect(await frame()).toContain(ja ? "質問に回答" : "answer the question")
    set("questions", [])
    set("status", { type: "retry", attempt: 1, message: "busy", next: 1 })
    expect(await frame()).toContain(ja ? "再試行待ち" : "Waiting to retry")
    set("status", { type: "retry", attempt: 3, message: "busy", next: 1 })
    expect(await frame()).toContain(ja ? "再試行待ち（3回目）" : "Waiting to retry (attempt 3)")
    expect(await frame()).not.toContain(ja ? "本人待ち" : "Waiting for you")

    // Long items stay on one row each; only the current item is spelled out in full above the list.
    const long = "KOEで音声を制作し、再生・認識検証と本人確認用の成果物を渡す。Produce audio, verify playback and recognition, then hand over."
    set("todo", 0, "content", long)
    const rows = (await frame()).split("\n").filter((row) => row.includes("[✓]"))
    expect(rows).toHaveLength(1)
    if (process.env.SHOW_FRAME) console.log(await frame())
    set("todo", 0, "content", "Inspect evidence")

    set("status", { type: "idle" })
    expect(await frame()).toContain(ja ? "残件を確認して続行を依頼" : "review remaining work and ask to continue")
    expect(await frame()).not.toContain(ja ? "本人待ち" : "Waiting for you")
    set("todo", 1, "status", "completed")
    expect(await frame()).toContain("2/2")
    expect(await frame()).toContain(ja ? "結果と証拠を確認" : "review results and evidence")

    set("session", "other")
    expect((await frame()).trim()).toBe("")
    set("session", "session")
    set("todo", [{ content: "Retired work", status: "cancelled" }])
    expect(await frame()).not.toContain(ja ? "結果と証拠を確認" : "review results and evidence")
    set("todo", [])
    expect((await frame()).trim()).toBe("")
    set("questions", [{ id: "question", sessionID: "session", questions: [] }])
    expect(await frame()).toContain(ja ? "作業一覧なし" : "No task list")
    expect(await frame()).toContain(ja ? "質問に回答" : "answer the question")
    set("questions", [])
    set("todo", [{ content: "Pending work", status: "pending" }])
    set("status", undefined)
    expect(await frame()).toContain(ja ? "状態未確認" : "Status unavailable")
    expect(await frame()).not.toContain(ja ? "続行を依頼" : "ask to continue")
  } finally {
    app.renderer.destroy()
  }
})

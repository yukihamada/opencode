/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { onCleanup } from "solid-js"
import { KVProvider, useKV } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { TaskCardApproval } from "../../../src/component/dialog-task-budget"
import { TaskBudget } from "../../../src/util/task-budget"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { tmpdir } from "../../fixture/fixture"
import { wait } from "../cmd/tui/sync-fixture"

test.each(["ja", "en"])("confirmation card requires explicit selection and keeps retry identity (%s)", async (locale) => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify({ language: locale }))
  const requests: unknown[] = []
  const approval: TaskBudget.Approval = {
    id: crypto.randomUUID(), approval_id: crypto.randomUUID(), card: {
      goal: "Fixture greeting", criteria: ["Hello appears"], scope: ["Text only"], prohibited: ["Publishing"], stop_conditions: ["Budget"],
      session_id: "session", price_version: "fixture", run_limit: 9000, month_limit: 9000, duration_ms: 600000,
      interval_ms: null, first_at: Date.now(), expires_at: Date.now() + 3600000,
    },
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    requests.push(await req.json())
    return requests.length === 1 ? Response.json({ error: "task_unavailable" }, { status: 503 }) : Response.json({ id: approval.id, approved: true })
  } })
  const client = TaskBudget.create({ api: server.url.toString(), protected: () => false })
  client.login("owner-fixture", "session")
  const state = { done: false }
  let ctx!: { dialog: ReturnType<typeof useDialog>; kv: ReturnType<typeof useKV> }
  function Probe() { ctx = { dialog: useDialog(), kv: useKV() }; return null }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({})
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return <TestTuiContexts paths={{ state: tmp.path, home: tmp.path }}>
      <OpencodeKeymapProvider keymap={keymap}><TuiConfigProvider config={config}><KVProvider><ThemeProvider mode="dark">
        <ToastProvider><DialogProvider><Probe /></DialogProvider></ToastProvider>
      </ThemeProvider></KVProvider></TuiConfigProvider></OpencodeKeymapProvider>
    </TestTuiContexts>
  }
  const app = await testRender(() => <Harness />, { width: 100, height: 55, kittyKeyboard: true })
  try {
    await wait(() => !!ctx && ctx.kv.ready)
    ctx.dialog.replace(() => <TaskCardApproval client={client} approval={approval} session="session" locale={locale} onDone={() => { state.done = true }} />)
    await wait(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Fixture greeting")
    expect(frame).toContain(locale === "ja" ? "仕事の確認カード" : "Job confirmation card")
    expect(frame).toContain(locale === "ja" ? "この条件で承認" : "Approve these terms")
    expect(requests).toHaveLength(0)
    app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    await wait(() => requests.length === 1)
    const deadline = Date.now() + 2000
    while (true) {
      await app.renderOnce()
      if (app.captureCharFrame().includes("task_unavailable")) break
      if (Date.now() >= deadline) throw new Error("Approval error did not render")
      await Bun.sleep(10)
    }
    expect(state.done).toBe(false)
    app.mockInput.pressEnter()
    await wait(() => state.done)
    expect(requests).toEqual([approval, approval])
    expect(client.isArmed(approval.id)).toBe(true)
  } finally {
    app.renderer.destroy()
    server.stop(true)
  }
})

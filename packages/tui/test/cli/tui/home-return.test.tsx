/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createSlot, createSolidSlotRegistry, testRender, useRenderer } from "@opentui/solid"
import type { TuiSlotMap, TuiSlotContext } from "@sente-ai/plugin/tui"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { onCleanup } from "solid-js"
import type { Session } from "@sente-ai/sdk/v2"
import path from "node:path"
import { ArgsProvider } from "../../../src/context/args"
import { KVProvider } from "../../../src/context/kv"
import { ProjectProvider } from "../../../src/context/project"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { LocalProvider, useLocal } from "../../../src/context/local"
import { PermissionProvider } from "../../../src/context/permission"
import { ExitProvider } from "../../../src/context/exit"
import { ThemeProvider, useTheme } from "../../../src/context/theme"
import { RouteProvider, useRoute } from "../../../src/context/route"
import { ToastProvider } from "../../../src/ui/toast"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { DataProvider } from "../../../src/context/data"
import { EditorContextProvider } from "../../../src/context/editor"
import { LocationProvider } from "../../../src/context/location"
import { PromptRefProvider, usePromptRef } from "../../../src/context/prompt"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { PluginRuntimeProvider, createPluginRuntime } from "../../../src/plugin/runtime"
import { Home } from "../../../src/routes/home"
import { homeLabels } from "../../../src/routes/home/recent-work"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createFetch, createEventSource, directory, json } from "../../fixture/tui-sdk"
import { tmpdir } from "../../fixture/fixture"
import { wait } from "../cmd/tui/sync-fixture"

function session(id: string, updated: number, extra: Partial<Session> = {}): Session {
  return {
    id, title: `Task ${id}`, slug: id, projectID: "proj_test", directory, version: "1",
    time: { created: 1, updated }, ...extra,
  }
}

async function mount(state: string, width: number, height = 40, initial = [
  session("old", 100), session("second", 300), session("first", 400), session("third", 200),
  session("child", 600, { parentID: "first" }),
  session("archived", 500, { time: { created: 1, updated: 500, archived: 501 } }),
], fail = false) {
  const response = { sessions: initial, fail }
  const calls = createFetch((url) => {
    if (url.pathname === "/session") {
      if (response.fail && url.searchParams.has("roots")) return json({ message: "Unavailable" }, { status: 503 })
      return json(response.sessions)
    }
  })
  const events = createEventSource()
  let ctx!: {
    local: ReturnType<typeof useLocal>; sync: ReturnType<typeof useSync>; route: ReturnType<typeof useRoute>
    dialog: ReturnType<typeof useDialog>; prompt: ReturnType<typeof usePromptRef>
  }
  function Probe() {
    ctx = { local: useLocal(), sync: useSync(), route: useRoute(), dialog: useDialog(), prompt: usePromptRef() }
    const runtime = createPluginRuntime()
    const theme = useTheme()
    const registry = createSolidSlotRegistry<TuiSlotMap<Record<string, object>>, TuiSlotContext>(useRenderer(), {
      theme: { ...theme, current: theme.theme, install: async () => { throw new Error("unused") } },
    })
    return <PluginRuntimeProvider value={{ ...runtime, Slot: createSlot(registry) }}><Home /></PluginRuntimeProvider>
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({})
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts paths={{ state, home: state }}>
        <ArgsProvider>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                      <PermissionProvider>
                        <ProjectProvider>
                          <ExitProvider exit={() => {}}>
                            <SyncProvider>
                              <RouteProvider>
                                <LocalProvider>
                                  <DialogProvider>
                                    <PluginRuntimeProvider value={createPluginRuntime()}>
                                      <DataProvider>
                                        <PromptStashProvider>
                                          <FrecencyProvider>
                                            <PromptHistoryProvider>
                                              <EditorContextProvider integration={{}}>
                                                <LocationProvider>
                                                  <PromptRefProvider><Probe /></PromptRefProvider>
                                                </LocationProvider>
                                              </EditorContextProvider>
                                            </PromptHistoryProvider>
                                          </FrecencyProvider>
                                        </PromptStashProvider>
                                      </DataProvider>
                                    </PluginRuntimeProvider>
                                  </DialogProvider>
                                </LocalProvider>
                              </RouteProvider>
                            </SyncProvider>
                          </ExitProvider>
                        </ProjectProvider>
                      </PermissionProvider>
                    </SDKProvider>
                  </ToastProvider>
                </ThemeProvider>
              </KVProvider>
            </TuiConfigProvider>
          </OpencodeKeymapProvider>
        </ArgsProvider>
      </TestTuiContexts>
    )
  }
  await Bun.write(path.join(state, "kv.json"), "{}")
  const app = await testRender(() => <Harness />, { width, height, kittyKeyboard: true })
  await wait(() => !!ctx && ctx.local.model.ready && ctx.sync.status === "complete")
  await app.renderOnce()
  expect(ctx.prompt.current).toBeDefined()
  await wait(() => !!app.renderer.root.findDescendantById(fail ? "home-history-retry" : initial.length ? "home-previous-work" : "home-example-0"))
  await app.renderOnce()
  async function click(id: string) {
    await app.renderOnce()
    const target = app.renderer.root.findDescendantById(id)
    if (!target) throw new Error(`Missing ${id}`)
    expect(target.y).toBeGreaterThanOrEqual(0)
    expect(target.y).toBeLessThan(height)
    await app.mockMouse.click(target.x + 1, target.y)
    await app.renderOnce()
  }
  async function resume() {
    app.mockInput.pressKey("x", { ctrl: true })
    await app.renderOnce()
    app.mockInput.pressKey("p")
    await app.renderOnce()
  }
  return { app, ctx, calls, events, response, click, resume }
}

test.each([40, 80, 140])("home shows latest work below prompt and opens by click or <leader>p at %i columns", async (width) => {
  await using tmp = await tmpdir()
  const { app, ctx, calls, click, resume } = await mount(tmp.path, width)
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Sente")
    expect(frame).toContain(homeLabels().previous)
    expect(frame).toContain("Task first")
    expect(frame.indexOf("Task second")).toBeLessThan(frame.indexOf("Task third"))
    for (const id of ["old", "child", "archived"]) expect(frame).not.toContain(`Task ${id}`)
    expect(calls.session.some((url) => url.searchParams.get("path") === "packages/tui" && url.searchParams.get("roots") === "true" && !url.searchParams.has("start"))).toBe(true)
    const previous = app.renderer.root.findDescendantById("home-previous-work")!
    expect(previous.y).toBeGreaterThan(app.renderer.currentFocusedRenderable!.y)
    await click("home-previous-work")
    expect(ctx.route.data).toEqual({ type: "session", sessionID: "first" })
    ctx.route.navigate({ type: "home" })
    await click("home-recent-second")
    expect(ctx.route.data).toEqual({ type: "session", sessionID: "second" })
    ctx.route.navigate({ type: "home" })
    ctx.prompt.current!.focus()
    // ctrl+r stays reserved for session rename; it must not resume from home.
    app.mockInput.pressKey("r", { ctrl: true })
    await app.renderOnce()
    expect(ctx.route.data.type).toBe("home")
    await resume()
    await wait(() => ctx.route.data.type === "session")
    expect(ctx.route.data).toEqual({ type: "session", sessionID: "first" })
  } finally { app.renderer.destroy() }
})

test("home preserves drafts and attachments and does not resume through an open dialog", async () => {
  await using tmp = await tmpdir()
  const { app, ctx, click, resume } = await mount(tmp.path, 80)
  try {
    const prompt = ctx.prompt.current!
    for (const draft of [
      { input: "Unsent draft", parts: [] },
      { input: "[test.txt]", parts: [{ type: "file" as const, mime: "text/plain", filename: "test.txt", url: "file:///test.txt",
        source: { type: "file" as const, path: "/test.txt", text: { start: 0, end: 10, value: "[test.txt]" } },
      }] },
    ]) {
      prompt.set(draft)
      expect(prompt.current).toEqual(draft)
      await click("home-previous-work")
      expect(ctx.route.data.type, `after click ${draft.input || "attachment"}`).toBe("home")
      await resume()
      expect(ctx.route.data.type, `after key ${draft.input || "attachment"}`).toBe("home")
      expect(prompt.current).toEqual(draft)
      expect(app.captureCharFrame()).toContain(homeLabels().draft)
    }
    prompt.reset()
    ctx.dialog.replace(() => <text>Open dialog</text>)
    await resume()
    expect(ctx.route.data.type).toBe("home")
    ctx.dialog.clear()
    await click("home-history")
    expect(ctx.dialog.stack.length).toBe(1)
  } finally {
    ctx.prompt.current?.reset()
    app.renderer.destroy()
  }
})

test("empty history offers examples that populate the real prompt", async () => {
  await using tmp = await tmpdir()
  const { app, ctx, click } = await mount(tmp.path, 80, 24, [])
  try {
    expect(app.captureCharFrame()).toContain(homeLabels().start)
    await click("home-example-0")
    expect(ctx.prompt.current!.current.input).toBe(homeLabels().examples[0])
    expect(ctx.route.data.type).toBe("home")
    expect(ctx.prompt.current!.focused).toBe(true)
  } finally {
    // Prompt preserves drafts across remounts; do not leak this example into another test.
    ctx.prompt.current?.reset()
    app.renderer.destroy()
  }
})

test("failed history can be retried and short terminals retain the resume action", async () => {
  await using tmp = await tmpdir()
  const { app, ctx, response, click } = await mount(tmp.path, 40, 24, [session("first", 400)], true)
  try {
    expect(app.captureCharFrame()).toContain(homeLabels().error)
    expect(app.captureCharFrame()).not.toContain(homeLabels().start)
    response.fail = false
    await click("home-history-retry")
    await wait(() => !!app.renderer.root.findDescendantById("home-resume"))
    await click("home-resume")
    expect(ctx.route.data).toEqual({ type: "session", sessionID: "first" })
  } finally { app.renderer.destroy() }
})

test("session updates refresh titles and order without claiming idle work is complete", async () => {
  await using tmp = await tmpdir()
  const { app, ctx, events, response } = await mount(tmp.path, 80)
  try {
    ctx.sync.set("session_status", "first", { type: "busy" })
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(homeLabels().busy)
    response.sessions = [session("third", 900, { title: "Updated task" })]
    events.emit({ directory, payload: { id: "evt_update", type: "session.updated", properties: { sessionID: "third", info: response.sessions[0]! } } })
    await wait(() => ctx.sync.session.get("third")?.title === "Updated task")
    await Bun.sleep(20)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Updated task")
    expect(app.captureCharFrame()).not.toContain(homeLabels().busy)
    expect(app.captureCharFrame()).not.toMatch(/Completed|完了/)
  } finally { app.renderer.destroy() }
})

test("home resume default does not share a key with session rename", async () => {
  const { TuiKeybind } = await import("../../../src/config/keybind")
  expect(TuiKeybind.Definitions.home_resume.default).toBe("<leader>p")
  expect(TuiKeybind.Definitions.home_resume.default).not.toBe(TuiKeybind.Definitions.session_rename.default)
})

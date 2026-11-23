/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

type Call = { input: { sessionID: string; question: string; main?: unknown; approve?: boolean }; signal?: AbortSignal }
type Reply = { data?: Record<string, unknown>; error?: unknown }

async function mount(root: string, replies: (call: Call) => Promise<Reply>, question = "What is it doing?") {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), JSON.stringify({ language: "en" }))
  const [{ DialogProvider, useDialog }, { DialogBtw }, { KVProvider }, { ThemeProvider }, { TuiConfigProvider }, { ToastProvider }, keymapModule] =
    await Promise.all([
      import("../../../src/ui/dialog"),
      import("../../../src/component/dialog-btw"),
      import("../../../src/context/kv"),
      import("../../../src/context/theme"),
      import("../../../src/config"),
      import("../../../src/ui/toast"),
      import("../../../src/keymap"),
    ])
  const calls: Call[] = []
  const client = {
    session: {
      btw: (input: Call["input"], options?: { signal?: AbortSignal }) => {
        const call = { input, signal: options?.signal }
        calls.push(call)
        return replies(call)
      },
    },
  }

  function Open() {
    const dialog = useDialog()
    onMount(() =>
      dialog.replace(() => (
        <DialogBtw
          client={client as Parameters<typeof DialogBtw>[0]["client"]}
          sessionID="ses_1"
          question={question}
          main={{ providerID: "sente", modelID: "main" }}
        />
      )),
    )
    return <text>main screen</text>
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({ leader_timeout: 1000 })
    onCleanup(keymapModule.registerOpencodeKeymap(keymap, renderer, resolvedConfig))
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <keymapModule.OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <Open />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </keymapModule.OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 120, height: 40 })
  const frame = async () => {
    await app.renderOnce()
    return app.captureCharFrame()
  }
  return { app, calls, frame }
}

const answer = (text: string, extra: Record<string, unknown> = {}) =>
  Promise.resolve({ data: { text, providerID: "sente", modelID: "gpt-nano", cost: 0, ...extra } })

test("shows the answer, the model and the main model hint it sent", async () => {
  await using tmp = await tmpdir()
  const ui = await mount(tmp.path, () => answer("It is fixing the login form."))
  try {
    await wait(() => ui.calls.length === 1)
    let frame = ""
    await wait(() => (frame = ui.app.captureCharFrame()).includes("It is fixing the login form."))
    frame = await ui.frame()
    expect(frame).toContain("Side question (/btw)")
    expect(frame).toContain("sente/gpt-nano")
    expect(ui.calls[0]!.input.main).toEqual({ providerID: "sente", modelID: "main" })
  } finally {
    ui.app.renderer.destroy()
  }
})

test("over the cost limit it asks first and sends again with approval on y", async () => {
  await using tmp = await tmpdir()
  const ui = await mount(tmp.path, (call) =>
    call.input.approve
      ? answer("approved answer")
      : Promise.resolve({ data: { text: "", providerID: "sente", modelID: "gpt-nano", cost: 0, approval: { spent: 1, limit: 1, estimate: 0.01 } } }),
  )
  try {
    await wait(() => ui.app.captureCharFrame().includes("y to run once"))
    expect(await ui.frame()).toContain("approval line")
    await ui.app.mockInput.pressKeys(["y"])
    await wait(() => ui.calls.length === 2)
    expect(ui.calls[1]!.input.approve).toBe(true)
    await wait(() => ui.app.captureCharFrame().includes("approved answer"))
  } finally {
    ui.app.renderer.destroy()
  }
})

test("closing with esc aborts the pending request", async () => {
  await using tmp = await tmpdir()
  const ui = await mount(tmp.path, () => new Promise<Reply>(() => {}))
  try {
    await wait(() => ui.calls.length === 1)
    expect(ui.calls[0]!.signal?.aborted).toBe(false)
    ui.app.mockInput.pressEscape()
    await wait(() => ui.calls[0]!.signal?.aborted === true)
    await wait(() => !ui.app.captureCharFrame().includes("Side question"))
  } finally {
    ui.app.renderer.destroy()
  }
})

test("errors keep the partial answer, the fallback model is named, and long questions are cut to one line", async () => {
  await using tmp = await tmpdir()
  const long = "why ".repeat(100)
  const ui = await mount(
    tmp.path,
    () => answer("partial text so far", { error: "connection reset", fallback: true, modelID: "big-model" }),
    long,
  )
  try {
    await wait(() => ui.app.captureCharFrame().includes("partial text so far"))
    const frame = await ui.frame()
    expect(frame).toContain("partial text so far")
    expect(frame).toContain("main model sente/big-model")
    expect(frame).toContain("…")
    expect(frame.split("\n").filter((line) => line.includes("why")).length).toBe(1)
  } finally {
    ui.app.renderer.destroy()
  }
})

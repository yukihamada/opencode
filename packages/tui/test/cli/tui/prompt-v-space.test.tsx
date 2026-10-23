/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { KeyEvent, TextareaRenderable } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { onCleanup } from "solid-js"
import type { Model } from "@sente-ai/sdk/v2"
import path from "node:path"
import { ArgsProvider } from "../../../src/context/args"
import { KVProvider } from "../../../src/context/kv"
import { ProjectProvider } from "../../../src/context/project"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { LocalProvider, useLocal } from "../../../src/context/local"
import { PermissionProvider } from "../../../src/context/permission"
import { ExitProvider } from "../../../src/context/exit"
import { ThemeProvider } from "../../../src/context/theme"
import { RouteProvider } from "../../../src/context/route"
import { ToastProvider } from "../../../src/ui/toast"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { Prompt, type PromptRef } from "../../../src/component/prompt"
import { DataProvider } from "../../../src/context/data"
import { EditorContextProvider } from "../../../src/context/editor"
import { LocationProvider } from "../../../src/context/location"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createFetch, createEventSource, directory, json } from "../../fixture/tui-sdk"
import { tmpdir } from "../../fixture/fixture"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function model(id: string): Model {
  return {
    id, providerID: "teai", name: id,
    api: { id, url: "https://example.test", npm: "@ai-sdk/openai-compatible" },
    capabilities: {
      temperature: true, reasoning: true, attachment: true, toolcall: true, interleaved: false,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    cost: { input: 10, output: 50, cache: { read: 0, write: 0 } },
    limit: { context: 1048576, output: 32768 }, status: "active", release_date: "2026-09-10",
    options: {}, headers: {},
  }
}

const sessionID = "ses_v_space_test"

async function mount(state: string, width: number, height: number) {
  const provider = { id: "teai", name: "teai", env: [], models: { auto: model("auto") } }
  // Every command request is recorded so we can assert which command name fired.
  const commands: string[] = []
  const commandRequests: Array<{ command: string; arguments: string; parts: unknown[] }> = []
  const base = createFetch((url) => {
    if (url.pathname === "/config/providers") return json({ providers: [provider], default: { teai: "auto" } })
    if (url.pathname === "/provider") return json({ all: [provider], default: { teai: "auto" }, connected: ["teai"] })
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", native: true, options: {}, permission: [] }])
      if (url.pathname === "/command") return json([{ name: "v", description: "Voice input", hints: [], template: "" }])
    if (url.pathname === `/session/${sessionID}/command`) return json({})
    return undefined
  })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === `/session/${sessionID}/command`) {
      const request = input instanceof Request ? input : undefined
      const body = request ? await request.clone().json() : init?.body ? JSON.parse(String(init.body)) : undefined
      if (body?.command) {
        commands.push(body.command)
        commandRequests.push({ command: body.command, arguments: body.arguments, parts: body.parts })
      }
    }
    return base.fetch(input as RequestInfo, init)
  }) as typeof globalThis.fetch
  const calls = { fetch }
  const events = createEventSource()
  let prompt!: PromptRef
  let ctx!: { local: ReturnType<typeof useLocal>; sync: ReturnType<typeof useSync>; dialog: ReturnType<typeof useDialog> }
  function Probe() {
    ctx = { local: useLocal(), sync: useSync(), dialog: useDialog() }
    return (
      <DataProvider><PromptStashProvider><FrecencyProvider><PromptHistoryProvider>
        <EditorContextProvider integration={{}}><LocationProvider>
          <Prompt sessionID={sessionID} ref={(value) => { if (value) prompt = value }} />
        </LocationProvider></EditorContextProvider>
      </PromptHistoryProvider></FrecencyProvider></PromptStashProvider></DataProvider>
    )
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({})
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts paths={{ state, home: state }}><ArgsProvider>
        <OpencodeKeymapProvider keymap={keymap}><TuiConfigProvider config={config}><KVProvider>
          <ThemeProvider mode="dark"><ToastProvider>
            <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
              <PermissionProvider><ProjectProvider><ExitProvider exit={() => {}}><SyncProvider><RouteProvider><LocalProvider>
                <DialogProvider><Probe /></DialogProvider>
              </LocalProvider></RouteProvider></SyncProvider></ExitProvider></ProjectProvider></PermissionProvider>
            </SDKProvider>
          </ToastProvider></ThemeProvider>
        </KVProvider></TuiConfigProvider></OpencodeKeymapProvider>
      </ArgsProvider></TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width, height, kittyKeyboard: true })
  await wait(() => !!ctx && ctx.local.model.ready && ctx.sync.status === "complete")
  return { app, ctx, prompt, commands, commandRequests }
}

function releaseSpace(app: Awaited<ReturnType<typeof mount>>["app"]) {
  app.renderer.keyInput.emit("keyrelease", new KeyEvent({
    name: "space",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: " ",
    number: false,
    raw: " ",
    eventType: "release",
    source: "kitty",
  }))
}

test("space tap inserts a space; /v is not required for voice input", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  await Bun.write(path.join(tmp.path, "model.json"), JSON.stringify({ recent: [{ providerID: "teai", modelID: "auto" }] }))
  const { app, prompt, commands } = await mount(tmp.path, 80, 24)
  try {
    prompt.focus()
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)

    // A plain space with empty input must stay a space, not fire the command.
    await app.mockInput.pressKeys([" "])
    await app.renderOnce()
    await Bun.sleep(20)
    releaseSpace(app)
    expect(commands).toEqual([])
    expect(prompt.current.input).toBe(" ")

    prompt.reset()
    await app.renderOnce()

    // Voice activation only happens on a long hold with an empty input.
    app.mockInput.pressKey(" ")
    await Bun.sleep(350)
    await wait(() => commands.includes("v"))
    expect(prompt.current.input).toBe("")
    releaseSpace(app)
    await wait(() => commands.includes("v"))
    expect(commands).toEqual(["v"])
    expect(prompt.current.input).toBe("")
  } finally {
    prompt.reset()
    app.renderer.destroy()
  }
})

test("holding space starts voice input and releasing it stops the microphone", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  await Bun.write(path.join(tmp.path, "model.json"), JSON.stringify({ recent: [{ providerID: "teai", modelID: "auto" }] }))
  const { app, prompt, commandRequests } = await mount(tmp.path, 80, 24)
  try {
    prompt.focus()
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)

    app.mockInput.pressKey(" ")
    await Bun.sleep(30)
    releaseSpace(app)
    await app.renderOnce()
    expect(prompt.current.input).toBe(" ")

    prompt.reset()
    await app.renderOnce()
    app.mockInput.pressKey(" ")
    await Bun.sleep(350)
    await wait(() => commandRequests.some((request) => request.command === "v" && request.arguments === ""))
    expect(prompt.current.input).toBe("")
    releaseSpace(app)
    await wait(() => commandRequests.some((request) => request.command === "v" && request.arguments === "off"))

    expect(commandRequests.map((request) => request.arguments)).toEqual(["", "off"])
    expect(commandRequests[0].parts).toEqual([])
  } finally {
    prompt.reset()
    app.renderer.destroy()
  }
})

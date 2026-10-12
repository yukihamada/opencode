/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
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
import { Prompt, type PromptRef, type PromptProps } from "../../../src/component/prompt"
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

async function mount(state: string, width: number, height: number, captureVoice: PromptProps["captureVoice"] = () => {
  throw new Error("Unexpected microphone start in test")
}) {
  const provider = { id: "teai", name: "teai", env: [], models: { auto: model("auto") } }
  const commands: string[] = []
  const commandRequests: Array<{ command: string; arguments: string }> = []
  const submissions: string[] = []
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
    if (/\/session\/[^/]+\/(command|message|prompt_async)$/.test(url.pathname)) submissions.push(url.pathname)
    if (url.pathname === `/session/${sessionID}/command`) {
      const request = input instanceof Request ? input : undefined
      const body = request ? await request.clone().json() : init?.body ? JSON.parse(String(init.body)) : undefined
      if (body?.command) {
        commands.push(body.command)
        commandRequests.push({ command: body.command, arguments: body.arguments })
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
          <Prompt sessionID={sessionID} captureVoice={captureVoice} ref={(value) => { if (value) prompt = value }} />
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
  return { app, ctx, prompt, commands, commandRequests, submissions }
}

function releaseSpace(app: Awaited<ReturnType<typeof mount>>["app"]) {
  app.renderer.stdin.emit("data", Buffer.from("\x1b[32;1:3u"))
}

test.each(["raw", "kitty"])("%s /v space requires transcript selection without a command or model request", async (source) => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  await Bun.write(path.join(tmp.path, "model.json"), JSON.stringify({ recent: [{ providerID: "teai", modelID: "auto" }] }))
  let started = 0
  const { app, ctx, prompt, commands, commandRequests, submissions } = await mount(tmp.path, 80, 24, ({ ready }) => {
    started++
    ready()
    return { finish: async () => "録音した内容だけ", cancel: () => {} }
  })
  try {
    prompt.focus()
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    if (source === "kitty") app.mockInput.pressKey(" ")
    else await app.mockInput.pressKeys([" "])
    await app.renderOnce()
    await Bun.sleep(20)
    releaseSpace(app)
    await wait(() => prompt.current.input === " ")
    expect(commands).toEqual([])
    expect(prompt.current.input).toBe(" ")
    prompt.reset()
    await app.renderOnce()
    await app.mockInput.typeText("/v")
    await app.renderOnce()
    expect(prompt.current.input).toBe("/v")
    if (source === "kitty") app.mockInput.pressKey(" ")
    else await app.mockInput.pressKeys([" "])
    await wait(() => started === 1)
    releaseSpace(app)
    expect(commands).toEqual([])
    await wait(() => prompt.current.input === "")
    expect(prompt.current.input).toBe("")
    app.mockInput.pressKey("RETURN")
    await wait(() => ctx.dialog.stack.length === 1)
    await app.renderOnce()
    expect(prompt.current.input).toBe("")
    app.mockInput.pressKey("RETURN")
    prompt.submit()
    await Bun.sleep(20)
    expect(prompt.current.input).toBe("")
    expect(ctx.dialog.stack).toHaveLength(1)
    app.mockInput.pressKey("1")
    await wait(() => prompt.current.input === "録音した内容だけ")
    expect(started).toBe(1)
    expect(ctx.dialog.stack).toHaveLength(0)
    expect(commandRequests).toEqual([])
    expect(submissions).toEqual([])
  } finally {
    prompt.reset()
    app.renderer.destroy()
  }
})

test.each(["enter", "escape", "error"])("/v Enter stays local on %s", async (action) => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  await Bun.write(path.join(tmp.path, "model.json"), JSON.stringify({ recent: [{ providerID: "teai", modelID: "auto" }] }))
  let started = 0
  let canceled = 0
  let finished = 0
  const { app, ctx, prompt, submissions } = await mount(tmp.path, 80, 24, ({ ready }) => {
    started++
    ready()
    return {
      finish: async () => {
        finished++
        if (action === "error") throw new Error("STT unavailable")
        return "文字だけ"
      },
      cancel: () => { canceled++ },
    }
  })
  try {
    prompt.focus()
    await app.mockInput.typeText("/v")
    await app.renderOnce()
    prompt.submit()
    await wait(() => started === 1)
    expect(prompt.current.input).toBe("")
    app.mockInput.pressKey(action === "escape" ? "ESCAPE" : "RETURN")
    await wait(() => canceled === 1)
    expect(finished).toBe(action === "escape" ? 0 : 1)
    expect(prompt.current.input).toBe("")
    if (action === "enter") {
      await wait(() => ctx.dialog.stack.length === 1)
      await app.renderOnce()
      app.mockInput.pressKey("1")
      await wait(() => prompt.current.input === "文字だけ")
    }
    expect(prompt.current.input).toBe(action === "enter" ? "文字だけ" : "")
    expect(submissions).toEqual([])
  } finally {
    prompt.reset()
    app.renderer.destroy()
  }
})

test("/v arguments cannot fall through to a model template", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  await Bun.write(path.join(tmp.path, "model.json"), JSON.stringify({ recent: [{ providerID: "teai", modelID: "auto" }] }))
  const { app, prompt, submissions } = await mount(tmp.path, 80, 24)
  try {
    prompt.focus()
    prompt.set({ input: "/v off", parts: [] })
    prompt.submit()
    await Bun.sleep(30)
    expect(submissions).toEqual([])
    expect(prompt.current.input).toBe("/v off")
  } finally {
    prompt.reset()
    app.renderer.destroy()
  }
})

test("raw terminal space remains text and never starts recording", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  await Bun.write(path.join(tmp.path, "model.json"), JSON.stringify({ recent: [{ providerID: "teai", modelID: "auto" }] }))
  const { app, prompt, commandRequests } = await mount(tmp.path, 80, 24)
  try {
    prompt.focus()
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    app.renderer.stdin.emit("data", Buffer.from(" "))
    await Bun.sleep(400)
    expect(commandRequests).toEqual([])
    expect(prompt.current.input).toBe(" ")
  } finally {
    prompt.reset()
    app.renderer.destroy()
  }
})

test("hold releases once and requires selection without submitting or sending /v off", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  await Bun.write(path.join(tmp.path, "model.json"), JSON.stringify({ recent: [{ providerID: "teai", modelID: "auto" }] }))
  let started = 0
  let finished = 0
  let resolve!: (text: string) => void
  const { app, ctx, prompt, commandRequests, submissions } = await mount(tmp.path, 80, 24, ({ ready, level }) => {
    started++
    ready()
    level(0.5)
    return {
      finish: () => { finished++; return new Promise<string>((r) => { resolve = r }) },
      cancel: () => {},
    }
  })
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
    await wait(() => started === 1)
    releaseSpace(app)
    releaseSpace(app)
    expect(finished).toBe(1)
    app.mockInput.pressKey("RETURN")
    prompt.submit()
    resolve("こんにちは")
    await wait(() => ctx.dialog.stack.length === 1)
    await app.renderOnce()
    expect(prompt.current.input).toBe("")
    app.mockInput.pressKey("1")
    await wait(() => prompt.current.input === "こんにちは")
    expect(started).toBe(1)
    expect(finished).toBe(1)
    expect(commandRequests).toEqual([])
    expect(submissions).toEqual([])
  } finally {
    prompt.reset()
    app.renderer.destroy()
  }
})

test.each(["select", "escape", "reset", "replace"])("voice review %s preserves draft ownership and never replays a transcript", async (action) => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  await Bun.write(path.join(tmp.path, "model.json"), JSON.stringify({ recent: [{ providerID: "teai", modelID: "auto" }] }))
  let started = 0
  let finished = 0
  const { app, ctx, prompt, submissions } = await mount(tmp.path, 80, 24, ({ ready }) => {
    started++
    ready()
    return { finish: async () => { finished++; return "原文" }, cancel: () => {} }
  })
  try {
    prompt.focus()
    prompt.set({ input: "既存の下書き", parts: [] })
    await app.renderOnce()
    app.mockInput.pressKey(" ")
    await wait(() => started === 1)
    releaseSpace(app)
    await wait(() => ctx.dialog.stack.length === 1)
    await app.renderOnce()
    expect(prompt.current.input).toBe("既存の下書き")
    prompt.submit()
    app.mockInput.pressKey("RETURN")
    // Repeated recording/stop keys must neither select nor start a new capture.
    app.mockInput.pressKey(" ")
    releaseSpace(app)
    expect(submissions).toEqual([])
    if (action === "select") app.mockInput.pressKey("1")
    if (action === "escape") app.mockInput.pressKey("ESCAPE")
    if (action === "reset") prompt.reset()
    if (action === "replace") prompt.set({ input: "別の下書き", parts: [] })
    await wait(() => ctx.dialog.stack.length === 0)
    await Bun.sleep(50)
    expect(prompt.current.input).toBe(action === "select" ? "既存の下書き原文" : action === "escape" ? "既存の下書き" : action === "reset" ? "" : "別の下書き")
    expect(started).toBe(1)
    expect(finished).toBe(1)
    expect(submissions).toEqual([])
    prompt.reset()
    await app.renderOnce()
    await Bun.sleep(50)
    expect(prompt.current.input).toBe("")
    expect(ctx.dialog.stack).toHaveLength(0)
  } finally {
    prompt.reset()
    app.renderer.destroy()
  }
})

test.each(["blur", "reset", "escape", "raw escape"])("%s discards late transcription", async (reason) => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  await Bun.write(path.join(tmp.path, "model.json"), JSON.stringify({ recent: [{ providerID: "teai", modelID: "auto" }] }))
  let started = false
  let canceled = 0
  let resolve!: (text: string) => void
  const { app, prompt, submissions } = await mount(tmp.path, 80, 24, () => {
    started = true
    return {
      finish: () => new Promise<string>((r) => { resolve = r }),
      cancel: () => { canceled++ },
    }
  })
  try {
    prompt.focus()
    app.mockInput.pressKey(" ")
    await wait(() => started)
    releaseSpace(app)
    if (reason === "blur") prompt.blur()
    if (reason === "reset") prompt.reset()
    if (reason === "escape") app.mockInput.pressKey("ESCAPE")
    if (reason === "raw escape") await app.mockInput.pressKeys(["ESCAPE"])
    // A bare ESC waits for the terminal parser to disambiguate an escape sequence.
    await wait(() => canceled === 1)
    resolve("must not appear")
    await Bun.sleep(20)
    expect(canceled).toBe(1)
    expect(prompt.current.input).toBe("")
    expect(submissions).toEqual([])
  } finally {
    prompt.reset()
    app.renderer.destroy()
  }
})

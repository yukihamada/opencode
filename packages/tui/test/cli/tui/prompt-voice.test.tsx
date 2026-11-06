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
import { OpencodeKeymapProvider, registerOpencodeKeymap, SENTE_BASE_MODE, useBindings } from "../../../src/keymap"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createFetch, createEventSource, directory, json } from "../../fixture/tui-sdk"
import { tmpdir } from "../../fixture/fixture"
import { backend } from "../../../src/util/dictation"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach } from "bun:test"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function model(id: string): Model {
  return {
    id,
    providerID: "teai",
    name: id,
    api: { id, url: "https://example.test", npm: "@ai-sdk/openai-compatible" },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      interleaved: false,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    cost: { input: 10, output: 50, cache: { read: 0, write: 0 } },
    limit: { context: 1048576, output: 32768 },
    status: "active",
    release_date: "2026-09-10",
    options: {},
    headers: {},
  }
}

const sessionID = "ses_v_space_test"

async function mount(
  state: string,
  width: number,
  height: number,
  options: { sessionID?: string | null; sessionDelayMs?: number } = {},
) {
  const promptSessionID = options.sessionID === undefined ? sessionID : (options.sessionID ?? undefined)
  const provider = { id: "teai", name: "teai", env: [], models: { auto: model("auto") } }
  // Every command request is recorded so we can assert which command name fired.
  const commands: string[] = []
  const commandRequests: Array<{ command: string; arguments: string; parts: unknown[]; sessionID: string }> = []
  const createdSessions: string[] = []
  const posts: string[] = []
  const appCalls = { exit: 0, interrupt: 0 }
  const base = createFetch((url) => {
    if (url.pathname === "/config/providers") return json({ providers: [provider], default: { teai: "auto" } })
    if (url.pathname === "/provider") return json({ all: [provider], default: { teai: "auto" }, connected: ["teai"] })
    if (url.pathname === "/agent")
      return json([{ name: "build", mode: "primary", native: true, options: {}, permission: [] }])
    if (url.pathname === "/command") return json([{ name: "v", description: "Voice input", hints: [], template: "" }])
    return undefined
  })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/session" && (input instanceof Request ? input.method : init?.method) === "POST") {
      const id = `ses_created_${createdSessions.length + 1}`
      createdSessions.push(id)
      if (options.sessionDelayMs) await Bun.sleep(options.sessionDelayMs)
      return json({ id })
    }
    if ((input instanceof Request ? input.method : init?.method) === "POST") posts.push(url.pathname)
    if (url.pathname.startsWith("/session/") && !url.pathname.endsWith("/command") && (input instanceof Request ? input.method : init?.method) === "POST")
      return json({})
    if (url.pathname.startsWith("/session/") && url.pathname.endsWith("/command")) {
      const request = input instanceof Request ? input : undefined
      const body = request ? await request.clone().json() : init?.body ? JSON.parse(String(init.body)) : undefined
      if (body?.command) {
        commands.push(body.command)
        commandRequests.push({
          command: body.command,
          arguments: body.arguments,
          parts: body.parts,
          sessionID: url.pathname.split("/")[2],
        })
      }
      return json({})
    }
    return base.fetch(input as RequestInfo, init)
  }) as typeof globalThis.fetch
  const calls = { fetch }
  const events = createEventSource()
  let prompt!: PromptRef
  let ctx!: {
    local: ReturnType<typeof useLocal>
    sync: ReturnType<typeof useSync>
    dialog: ReturnType<typeof useDialog>
  }
  function Probe() {
    ctx = { local: useLocal(), sync: useSync(), dialog: useDialog() }
    // 本体と同じ「空欄の Ctrl+C で終了」「Esc で作業中断」の割り当てを置き、音声入力が先に受け取るかを確かめる。
    useBindings(() => ({
      mode: SENTE_BASE_MODE,
      commands: [
        { name: "app.exit", title: "exit", run: () => void appCalls.exit++ },
        { name: "session.interrupt", title: "interrupt", run: () => void appCalls.interrupt++ },
      ],
      bindings: [
        { key: "ctrl+c", cmd: "app.exit" },
        { key: "escape", cmd: "session.interrupt" },
      ],
    }))
    return (
      <DataProvider>
        <PromptStashProvider>
          <FrecencyProvider>
            <PromptHistoryProvider>
              <EditorContextProvider integration={{}}>
                <LocationProvider>
                  <Prompt
                    sessionID={promptSessionID}
                    ref={(value) => {
                      if (value) prompt = value
                    }}
                  />
                </LocationProvider>
              </EditorContextProvider>
            </PromptHistoryProvider>
          </FrecencyProvider>
        </PromptStashProvider>
      </DataProvider>
    )
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
                                    <Probe />
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
  const app = await testRender(() => <Harness />, { width, height, kittyKeyboard: true })
  await wait(() => !!ctx && ctx.local.model.ready && ctx.sync.status === "complete")
  return { app, ctx, prompt, commands, commandRequests, createdSessions, posts, appCalls }
}


const original = { ...backend, limits: { ...backend.limits } }
afterEach(() => Object.assign(backend, { ...original, limits: { ...original.limits } }))

// 録音プログラムと文字起こしを差し替える。録音が始まると声相当の音を流し続ける。
function fakeVoice(text = "テストを直して", delayMs = 0) {
  const state = { spawned: 0, killed: 0, transcribed: 0, text }
  backend.findRecorder = () => ({ name: "fake", command: "fake", args: [] })
  backend.gitBranch = () => "feat/voice"
  backend.spawn = () => {
    state.spawned++
    const stdout = new PassThrough()
    const proc = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new PassThrough(),
      killed: false,
      kill() {
        if (proc.killed) return
        proc.killed = true
        state.killed++
        clearInterval(timer)
        setImmediate(() => proc.emit("close", null, "SIGKILL"))
      },
    })
    const loud = Buffer.alloc(3200)
    for (let i = 0; i < 1600; i++) loud.writeInt16LE(Math.round(Math.sin(i / 5) * 8000), i * 2)
    const timer = setInterval(() => stdout.write(loud), 20)
    return proc as never
  }
  backend.keyRepeatDelayMs = () => undefined
  backend.fetch = async () => {
    state.transcribed++
    if (delayMs) await Bun.sleep(delayMs)
    return Response.json({ ok: true, text: state.text })
  }
  return state
}

function key(name: string, eventType: "press" | "repeat" | "release", source: "kitty" | "raw", extra: Partial<{ ctrl: boolean }> = {}) {
  const sequence = name === "space" ? " " : name === "escape" ? "\x1b" : name === "return" ? "\r" : name
  return new KeyEvent({
    name,
    ctrl: extra.ctrl ?? false,
    meta: false,
    shift: false,
    option: false,
    sequence,
    number: false,
    raw: sequence,
    eventType,
    source,
  })
}

async function setup(kv: Record<string, unknown> = { voice_input: { enabled: true }, voice_input_consent: true }) {
  const tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), JSON.stringify(kv))
  await Bun.write(path.join(tmp.path, "model.json"), JSON.stringify({ recent: [{ providerID: "teai", modelID: "auto" }] }))
  const mounted = await mount(tmp.path, 100, 24)
  mounted.prompt.focus()
  await wait(() => mounted.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const emit = (event: KeyEvent) =>
    mounted.app.renderer.keyInput.emit(event.eventType === "release" ? "keyrelease" : "keypress", event)
  return { ...mounted, tmp, emit }
}

async function teardown(s: Awaited<ReturnType<typeof setup>>) {
  s.prompt.reset()
  s.app.renderer.destroy()
  await s.tmp[Symbol.asyncDispose]()
}

test("kitty: a short space tap is a normal space and nothing is transcribed", async () => {
  const voice = fakeVoice()
  const s = await setup()
  try {
    await s.app.mockInput.pressKeys([" "])
    await Bun.sleep(20)
    s.emit(key("space", "release", "kitty"))
    await s.app.renderOnce()
    expect(s.prompt.current.input).toBe(" ")
    await wait(() => voice.killed === voice.spawned)
    expect(voice.transcribed).toBe(0)
    expect(s.commands).toEqual([])
  } finally {
    await teardown(s)
  }
})

test("kitty: hold space to talk, release inserts the transcript without sending anything", async () => {
  const voice = fakeVoice()
  const s = await setup()
  try {
    s.emit(key("space", "press", "kitty"))
    await wait(() => voice.spawned === 1)
    await Bun.sleep(250)
    await s.app.renderOnce()
    expect(s.app.captureCharFrame()).toContain("録音中")
    s.emit(key("space", "repeat", "kitty"))
    await Bun.sleep(80)
    s.emit(key("space", "release", "kitty"))
    await wait(() => s.prompt.current.input === "テストを直して")
    expect(voice.killed).toBe(1)
    expect(voice.transcribed).toBe(1)
    await Bun.sleep(30)
    // セッション作成・/v コマンド・モデルへの送信のどれも起きない。
    expect(s.posts).toEqual([])
    expect(s.commands).toEqual([])
  } finally {
    await teardown(s)
  }
})

test("other terminals: holding space is detected from key repeat and ends when repeat stops", async () => {
  const voice = fakeVoice("fix the failing test")
  const s = await setup()
  try {
    s.emit(key("space", "press", "raw"))
    await Bun.sleep(300)
    // 話し始めを落とさないよう録音は先に始まるが、まだ画面には出ない。
    expect(voice.spawned).toBe(1)
    await s.app.renderOnce()
    expect(s.app.captureCharFrame()).not.toContain("録音中")
    // 端末はキーリピートを普通の押下として送ってくる。
    for (let i = 0; i < 6; i++) {
      s.emit(key("space", "press", "raw"))
      await Bun.sleep(40)
    }
    expect(voice.spawned).toBe(1)
    expect(s.prompt.current.input).toBe("")
    await wait(() => s.prompt.current.input === "fix the failing test", 3000)
    expect(voice.killed).toBe(1)
    expect(s.posts).toEqual([])
  } finally {
    await teardown(s)
  }
})

test("other terminals: a single space still types a space, and a following key keeps its order", async () => {
  const voice = fakeVoice()
  const s = await setup()
  try {
    s.emit(key("space", "press", "raw"))
    await Bun.sleep(800)
    expect(s.prompt.current.input).toBe(" ")
    s.prompt.reset()
    await s.app.renderOnce()
    s.emit(key("space", "press", "raw"))
    await s.app.mockInput.pressKeys(["a"])
    await s.app.renderOnce()
    expect(s.prompt.current.input).toBe(" a")
    await wait(() => voice.killed === voice.spawned)
    expect(voice.transcribed).toBe(0)
  } finally {
    await teardown(s)
  }
})

test("Esc cancels a recording: nothing is transcribed or inserted", async () => {
  const voice = fakeVoice()
  const s = await setup()
  try {
    s.emit(key("space", "press", "kitty"))
    await wait(() => voice.spawned === 1)
    await Bun.sleep(250)
    s.emit(key("escape", "press", "kitty"))
    await wait(() => voice.killed === 1)
    s.emit(key("space", "release", "kitty"))
    await Bun.sleep(50)
    expect(voice.transcribed).toBe(0)
    expect(s.prompt.current.input).toBe("")
  } finally {
    await teardown(s)
  }
})

test("tap mode: space starts, second space sends the transcript", async () => {
  const voice = fakeVoice("テストを直して")
  const s = await setup({ voice_input: { enabled: true, mode: "tap" }, voice_input_consent: true })
  try {
    s.emit(key("space", "press", "kitty"))
    await wait(() => voice.spawned === 1)
    s.emit(key("space", "release", "kitty"))
    await Bun.sleep(600)
    expect(voice.killed).toBe(0)
    s.emit(key("space", "press", "kitty"))
    await wait(() => voice.transcribed === 1)
    // 文字起こしがそのまま送信され、入力欄は空に戻る。
    await wait(() => s.posts.includes("/session/ses_v_space_test/message"), 3000)
    expect(s.prompt.current.input).toBe("")
    expect(s.commands).toEqual([])
  } finally {
    await teardown(s)
  }
})

test("/v off is handled locally and disables the space shortcut", async () => {
  const voice = fakeVoice()
  const s = await setup()
  try {
    s.prompt.set({ input: "/v off", parts: [] })
    await s.app.renderOnce()
    await s.prompt.submit()
    await Bun.sleep(20)
    expect(s.prompt.current.input).toBe("")
    expect(s.posts).toEqual([])
    s.emit(key("space", "press", "kitty"))
    await Bun.sleep(350)
    s.emit(key("space", "release", "kitty"))
    expect(voice.spawned).toBe(0)
    expect(s.prompt.current.input).toBe(" ")
  } finally {
    await teardown(s)
  }
})

test("/v starts a recording that Ctrl+Space finishes", async () => {
  const voice = fakeVoice()
  const s = await setup({ voice_input: { enabled: false }, voice_input_consent: true })
  try {
    await s.app.mockInput.typeText("/v")
    await s.app.renderOnce()
    s.app.mockInput.pressEnter()
    await wait(() => voice.spawned === 1)
    expect(s.prompt.current.input).toBe("")
    await Bun.sleep(600)
    s.emit(key("space", "press", "kitty", { ctrl: true }))
    await wait(() => s.prompt.current.input === "テストを直して")
    expect(s.posts).toEqual([])
    expect(s.commands).toEqual([])
  } finally {
    await teardown(s)
  }
})

test("Ctrl+C while recording cancels instead of quitting Sente", async () => {
  const voice = fakeVoice()
  const s = await setup()
  try {
    s.emit(key("space", "press", "kitty"))
    await wait(() => voice.spawned === 1)
    await Bun.sleep(250)
    s.emit(key("c", "press", "kitty", { ctrl: true }))
    await wait(() => voice.killed === 1)
    expect(s.appCalls.exit).toBe(0)
    expect(voice.transcribed).toBe(0)
    // 録音していない時の Ctrl+C は今まで通り本体へ届く。
    s.emit(key("space", "release", "kitty"))
    s.emit(key("c", "press", "kitty", { ctrl: true }))
    expect(s.appCalls.exit).toBe(1)
  } finally {
    await teardown(s)
  }
})

test("Esc while recording cancels and is not passed on as an interrupt", async () => {
  const voice = fakeVoice()
  const s = await setup()
  try {
    s.emit(key("space", "press", "kitty"))
    await Bun.sleep(260)
    s.emit(key("escape", "press", "kitty"))
    await wait(() => voice.killed === 1)
    expect(s.appCalls.interrupt).toBe(0)
  } finally {
    await teardown(s)
  }
})

test("a short tap never sends audio for transcription even though recording starts early", async () => {
  const voice = fakeVoice()
  const s = await setup()
  try {
    s.emit(key("space", "press", "kitty"))
    await Bun.sleep(60)
    s.emit(key("space", "release", "kitty"))
    await wait(() => voice.killed === 1)
    await Bun.sleep(50)
    expect(voice.transcribed).toBe(0)
    expect(s.prompt.current.input).toBe(" ")
    expect(s.app.captureCharFrame()).not.toContain("取り消し")
  } finally {
    await teardown(s)
  }
})

test("Japanese IME: holding the full-width space also starts dictation", async () => {
  const voice = fakeVoice()
  const s = await setup()
  try {
    const wide = () =>
      new KeyEvent({ name: "\u3000", ctrl: false, meta: false, shift: false, option: false, sequence: "\u3000", number: false, raw: "\u3000", eventType: "press", source: "raw" })
    s.emit(wide())
    await Bun.sleep(300)
    for (let i = 0; i < 5; i++) {
      s.emit(wide())
      await Bun.sleep(40)
    }
    expect(voice.spawned).toBe(1)
    await wait(() => s.prompt.current.input === "テストを直して", 3000)
    // 単発の全角空白は全角空白のまま入る。
    s.prompt.reset()
    await s.app.renderOnce()
    s.emit(wide())
    await Bun.sleep(800)
    expect(s.prompt.current.input).toBe("\u3000")
  } finally {
    await teardown(s)
  }
})

test("dictation appended to Japanese text gets no extra space", async () => {
  fakeVoice("テストも直して")
  const s = await setup()
  try {
    await s.app.mockInput.typeText("この関数を直して")
    await s.app.renderOnce()
    s.emit(key("space", "press", "kitty", { ctrl: true }))
    await Bun.sleep(300)
    s.emit(key("space", "press", "kitty", { ctrl: true }))
    await wait(() => s.prompt.current.input === "この関数を直してテストも直して")
  } finally {
    await teardown(s)
  }
})

test("after a hold auto-stops, the still-held space does not leak into the prompt", async () => {
  const voice = fakeVoice()
  const s = await setup()
  backend.limits = { silenceMs: 60_000, maxMs: 400 }
  try {
    s.emit(key("space", "press", "raw"))
    await Bun.sleep(300)
    for (let i = 0; i < 30; i++) {
      s.emit(key("space", "press", "raw"))
      await Bun.sleep(40)
    }
    await wait(() => s.prompt.current.input.startsWith("テストを直して"), 3000)
    await Bun.sleep(100)
    expect(voice.killed).toBe(1)
    expect(s.prompt.current.input).toBe("テストを直して")
  } finally {
    await teardown(s)
  }
})

test("Enter pressed while transcribing sends once the text arrives", async () => {
  const voice = fakeVoice("テストを直して", 300)
  const s = await setup()
  try {
    s.emit(key("space", "press", "kitty"))
    await Bun.sleep(600)
    s.emit(key("space", "release", "kitty"))
    await wait(() => voice.transcribed === 1)
    s.emit(key("return", "press", "kitty"))
    await wait(() => s.posts.includes("/session/ses_v_space_test/message"), 3000)
  } finally {
    await teardown(s)
  }
})

test("tap mode in other terminals: holding the space a little longer does not finish at once", async () => {
  const voice = fakeVoice()
  const s = await setup({ voice_input: { enabled: true, mode: "tap" }, voice_input_consent: true })
  try {
    s.emit(key("space", "press", "raw"))
    await wait(() => voice.spawned === 1)
    for (let i = 0; i < 6; i++) {
      await Bun.sleep(40)
      s.emit(key("space", "press", "raw"))
    }
    await Bun.sleep(100)
    expect(voice.killed).toBe(0)
    await Bun.sleep(400)
    s.emit(key("space", "press", "raw"))
    await wait(() => voice.transcribed === 1)
  } finally {
    await teardown(s)
  }
})

test("before consent, a space never opens the microphone and a hold asks first", async () => {
  const voice = fakeVoice()
  const s = await setup({})
  try {
    // ただのタップ: マイクは一度も開かない。
    s.emit(key("space", "press", "kitty"))
    await Bun.sleep(60)
    s.emit(key("space", "release", "kitty"))
    await s.app.renderOnce()
    expect(s.prompt.current.input).toBe(" ")
    expect(voice.spawned).toBe(0)
    s.prompt.reset()
    await s.app.renderOnce()
    // 長押し: 録音せずに説明と確認を出す。
    s.emit(key("space", "press", "kitty"))
    await Bun.sleep(300)
    await s.app.renderOnce()
    expect(voice.spawned).toBe(0)
    expect(s.app.captureCharFrame()).toContain("音声入力を使いますか")
    expect(s.app.captureCharFrame()).toContain("ElevenLabs")
    s.emit(key("space", "release", "kitty"))
    expect(voice.transcribed).toBe(0)
  } finally {
    await teardown(s)
  }
})

test("a fast double space types two spaces instead of starting a recording", async () => {
  const voice = fakeVoice()
  const s = await setup()
  try {
    s.emit(key("space", "press", "raw"))
    await Bun.sleep(30)
    s.emit(key("space", "press", "raw"))
    await s.app.renderOnce()
    expect(s.prompt.current.input).toBe("  ")
    await wait(() => voice.killed === voice.spawned)
    expect(voice.transcribed).toBe(0)
  } finally {
    await teardown(s)
  }
})

test("full-width space from a kitty terminal is still judged by key repeat", async () => {
  const voice = fakeVoice()
  const s = await setup()
  try {
    const wide = () =>
      new KeyEvent({ name: "\u3000", ctrl: false, meta: false, shift: false, option: false, sequence: "\u3000", number: false, raw: "\u3000", eventType: "press", source: "kitty" })
    s.emit(wide())
    await Bun.sleep(300)
    for (let i = 0; i < 5; i++) {
      s.emit(wide())
      await Bun.sleep(40)
    }
    // 離した合図が来なくても、リピートが止まれば確定する。
    await wait(() => s.prompt.current.input === "テストを直して", 3000)
    expect(voice.killed).toBe(1)
  } finally {
    await teardown(s)
  }
})

test("recording hint lists every voice key, including the leader one", async () => {
  fakeVoice()
  const s = await setup()
  try {
    s.emit(key("space", "press", "kitty", { ctrl: true }))
    await Bun.sleep(150)
    await s.app.renderOnce()
    const frame = s.app.captureCharFrame()
    expect(frame).toContain("録音中")
    expect(frame).toMatch(/ctrl\+space か \S+ v/)
  } finally {
    await teardown(s)
  }
})

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
import { ToastProvider, useToast } from "../../../src/ui/toast"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { Prompt, type PromptRef } from "../../../src/component/prompt"
import { DataProvider } from "../../../src/context/data"
import { EditorContextProvider } from "../../../src/context/editor"
import { LocationProvider } from "../../../src/context/location"
import { LoopProvider, useLoop } from "../../../src/context/loop"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createFetch, createEventSource, directory, json } from "../../fixture/tui-sdk"
import { tmpdir } from "../../fixture/fixture"

// 入力欄で /loop を打ったときの受け付け・状態表示・費用確認の受け取りを、本物の Prompt と LoopProvider で確かめる。

async function wait(fn: () => boolean, timeout = 3000) {
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
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
    limit: { context: 100000, output: 8000 },
    status: "active",
    release_date: "2026-09-10",
    options: {},
    headers: {},
  }
}

const sessionID = "ses_loop_test"

async function setup() {
  const tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), JSON.stringify({ language: "ja" }))
  await Bun.write(path.join(tmp.path, "model.json"), JSON.stringify({ recent: [{ providerID: "teai", modelID: "auto" }] }))
  const provider = { id: "teai", name: "teai", env: [], models: { auto: model("auto") } }
  const prompts: Array<{ at: number; text: string }> = []
  const base = createFetch((url) => {
    if (url.pathname === "/config/providers") return json({ providers: [provider], default: { teai: "auto" } })
    if (url.pathname === "/provider") return json({ all: [provider], default: { teai: "auto" }, connected: ["teai"] })
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", native: true, options: {}, permission: [] }])
    if (url.pathname === "/command") return json([{ name: "review", description: "Review", hints: [], template: "" }])
    return undefined
  })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined
    const url = new URL(request ? request.url : String(input))
    const method = request ? request.method : init?.method
    if (method === "POST" && url.pathname === `/session/${sessionID}/message`) {
      const body = request ? await request.clone().json() : JSON.parse(String(init?.body))
      prompts.push({ at: Date.now(), text: body.parts.find((part: { type: string }) => part.type === "text")?.text })
      return json({})
    }
    return base.fetch(input as RequestInfo, init)
  }) as typeof globalThis.fetch
  const events = createEventSource()
  let prompt!: PromptRef
  let ctx!: { dialog: ReturnType<typeof useDialog>; loop: ReturnType<typeof useLoop>; sync: ReturnType<typeof useSync>; local: ReturnType<typeof useLocal>; toast: ReturnType<typeof useToast> }
  function Probe() {
    ctx = { dialog: useDialog(), loop: useLoop(), sync: useSync(), local: useLocal(), toast: useToast() }
    return null
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({})
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts paths={{ state: tmp.path, home: tmp.path }}>
        <ArgsProvider>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <SDKProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
                      <PermissionProvider>
                        <ProjectProvider>
                          <ExitProvider exit={() => {}}>
                            <SyncProvider>
                              <RouteProvider>
                                <LocalProvider>
                                  <LoopProvider>
                                  <DialogProvider>
                                    <DataProvider>
                                      <PromptStashProvider>
                                        <FrecencyProvider>
                                          <PromptHistoryProvider>
                                            <EditorContextProvider integration={{}}>
                                              <LocationProvider>
                                                <Probe />
                                                <Prompt sessionID={sessionID} ref={(value) => value && (prompt = value)} />
                                              </LocationProvider>
                                            </EditorContextProvider>
                                          </PromptHistoryProvider>
                                        </FrecencyProvider>
                                      </PromptStashProvider>
                                    </DataProvider>
                                  </DialogProvider>
                                  </LoopProvider>
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
  const app = await testRender(() => <Harness />, { width: 120, height: 24 })
  await wait(() => !!ctx && ctx.local.model.ready && ctx.sync.status === "complete")
  prompt.focus()
  await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const submit = async (input: string) => {
    prompt.set({ input, parts: [] })
    await app.renderOnce()
    await prompt.submit()
    await app.renderOnce()
  }
  const emit = (payload: { type: string; properties: Record<string, unknown> }) =>
    events.emit({ directory, payload: { id: `evt_${Math.random()}`, ...payload } } as never)
  const teardown = async () => {
    ctx.loop.stop("all")
    prompt.reset()
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
  return { app, ctx, prompts, submit, emit, teardown, prompt: () => prompt }
}

test("/loop is handled locally: registers, clears the input, shows the footer and sends ~5s later", async () => {
  const s = await setup()
  try {
    const startedAt = Date.now()
    await s.submit("/loop 1m 今の時刻を一言で")
    expect(s.prompt().current.input).toBe("")
    expect(s.prompts).toEqual([])
    const items = s.ctx.loop.list(sessionID)
    expect(items.map((item) => [item.prompt, item.interval, item.target.model.modelID, item.budget])).toEqual([
      ["今の時刻を一言で", 60_000, "auto", 1],
    ])
    expect(s.ctx.toast.currentToast?.message).toContain("約5秒後")
    expect(s.ctx.toast.currentToast?.message).toContain("teai/auto で固定")
    await s.app.renderOnce()
    expect(s.app.captureCharFrame()).toContain("ループ 1件")
    // 自分の入力欄クリアで待たされない: 静穏 5 秒 + tick 1 秒以内に1回目が届く
    await wait(() => s.prompts.length > 0, 8000)
    const elapsed = s.prompts[0].at - startedAt
    expect(elapsed).toBeGreaterThanOrEqual(4500)
    expect(elapsed).toBeLessThan(7000)
    expect(s.prompts[0].text).toBe("今の時刻を一言で")
  } finally {
    await s.teardown()
  }
}, 20_000)

test("/loop rejects local screen commands but accepts other '/' prompts; stop without target clears this session", async () => {
  const s = await setup()
  try {
    await s.submit("/loop 1m /mode max")
    expect(s.ctx.toast.currentToast?.message).toContain("手元の画面操作")
    expect(s.prompt().current.input).toBe("/loop 1m /mode max")
    expect(s.ctx.loop.list()).toEqual([])
    await s.submit("/loop 5分ごとに /usr を確認")
    await s.submit("/loop 1m --max 1000000 /review")
    expect(s.ctx.toast.currentToast?.message).toContain("回数は最大1000回")
    expect(s.ctx.loop.list().map((item) => item.prompt)).toEqual(["/usr を確認", "/review"])
    s.ctx.loop.stop("all")
    await s.submit("/loop 5m git log --max 5")
    expect(s.ctx.toast.currentToast?.message).toContain("回数5回(--max)")
    expect(s.ctx.toast.currentToast?.message).toContain("-- の後に書いて")
    expect(s.ctx.toast.currentToast?.message).toContain("上限$1.00(約¥150)")
    s.ctx.loop.stop("all")
    await s.submit("/loop 2日間 毎日の確認")
    expect(s.ctx.toast.currentToast?.message).toContain("間隔を読み取れませんでした")
    await s.submit("/loop 5m")
    expect(s.ctx.toast.currentToast?.message).toContain("5分")
    await s.submit("/loop 1m 確認")
    expect(s.ctx.loop.list().length).toBe(1)
    await s.submit("/loop stop")
    expect(s.ctx.loop.list()).toEqual([])
  } finally {
    await s.teardown()
  }
})

test("cost approval events pause the loop and resume it automatically once approved", async () => {
  const s = await setup()
  try {
    await s.submit("/loop 1m 状況確認")
    const item = s.ctx.loop.list()[0]
    s.emit({
      type: "permission.asked",
      properties: { id: "per_cost", sessionID, permission: "request_cost", patterns: ["teai/auto"], metadata: {}, always: [] },
    })
    await wait(() => item.state === "paused", 3000)
    expect(item.pauseReason).toBe("cost")
    expect(s.ctx.toast.currentToast?.message).toContain("先に画面の確認で承認すると自動で再開")
    await s.app.renderOnce()
    expect(s.app.captureCharFrame()).toContain("費用確認で停止中")
    await s.submit("/loop resume")
    expect(s.ctx.toast.currentToast?.message).toContain("承認待ちです")
    expect(item.state).toBe("paused")
    s.emit({ type: "permission.replied", properties: { sessionID, requestID: "per_cost", reply: "once" } })
    await wait(() => item.state === "active", 3000)
    expect(s.ctx.toast.currentToast?.message).toContain("再開しました")
  } finally {
    await s.teardown()
  }
})

test("/loop list opens the list (renders under the dialog layer) and resumes from the action menu", async () => {
  const s = await setup()
  try {
    await s.submit("/loop 1m 状況確認")
    const item = s.ctx.loop.list()[0]
    s.emit({
      type: "permission.asked",
      properties: { id: "per_cost2", sessionID, permission: "request_cost", patterns: [], metadata: {}, always: [] },
    })
    await wait(() => item.state === "paused", 3000)
    s.emit({ type: "permission.replied", properties: { sessionID, requestID: "per_cost2", reply: "reject" } })
    await wait(() => !s.ctx.sync.data.permission[sessionID]?.length, 3000)
    // `/loop` 単体は補完から app コマンドで開く(本体のみ)。ここでは同じダイアログを開く `/loop list` を使う
    await s.submit("/loop list")
    await Bun.sleep(20)
    await s.app.renderOnce()
    const frame = s.app.captureCharFrame()
    expect(frame).toContain("ループ(このセッション内の繰り返し)")
    expect(frame).toContain("状況確認")
    expect(frame).toContain("1mごと")
    expect(frame).toContain("費用確認")
    // 選ぶと操作メニュー(止める / 再開する / 戻る)
    s.app.mockInput.pressEnter()
    await Bun.sleep(50)
    await s.app.renderOnce()
    expect(s.app.captureCharFrame()).toContain("ループ 1 を止めますか?")
    s.app.mockInput.pressArrow("down")
    await Bun.sleep(20)
    s.app.mockInput.pressEnter()
    await wait(() => item.state === "active", 3000)
    expect(s.ctx.dialog.stack.length).toBe(0)
  } finally {
    await s.teardown()
  }
})

test("loop budget counts cost from message.updated events (not the trimmed screen list)", async () => {
  const s = await setup()
  try {
    await s.submit("/loop 1m --budget 0.05 状況確認")
    const item = s.ctx.loop.list()[0]
    await wait(() => s.prompts.length > 0, 8000)
    // ループの回の応答(費用 $0.08)が届く
    s.emit({
      type: "message.updated",
      properties: {
        sessionID,
        info: { id: "msg_loop_reply", sessionID, role: "assistant", cost: 0.08, time: { created: Date.now() }, parentID: "x", modelID: "auto", providerID: "teai", mode: "build", agent: "build", path: { cwd: "/", root: "/" }, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
      },
    })
    await wait(() => s.ctx.loop.list().length === 0, 4000)
    expect(item.spent).toBeCloseTo(0.08)
    expect(s.ctx.toast.currentToast?.message).toContain("上限に達したため")
  } finally {
    await s.teardown()
  }
}, 20_000)

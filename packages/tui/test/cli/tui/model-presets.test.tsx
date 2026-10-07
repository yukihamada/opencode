/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createSignal, onCleanup, Show } from "solid-js"
import type { Model } from "@sente-ai/sdk/v2"
import path from "node:path"
import { readdir } from "node:fs/promises"
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
import { Toast, ToastProvider } from "../../../src/ui/toast"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { DialogModel } from "../../../src/component/dialog-model"
import { Prompt, type PromptRef } from "../../../src/component/prompt"
import { DataProvider } from "../../../src/context/data"
import { EditorContextProvider } from "../../../src/context/editor"
import { LocationProvider } from "../../../src/context/location"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { modelPresets, presetName, presetLabels } from "../../../src/util/model-presets"
import { modelCostDetail } from "../../../src/util/model-cost"
import { modelBrowseText } from "../../../src/util/model-browse"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createFetch, createEventSource, directory, json } from "../../fixture/tui-sdk"
import { tmpdir } from "../../fixture/fixture"
import { wait } from "../cmd/tui/sync-fixture"

function model(id: string): Model {
  return {
    id, providerID: "teai", name: id,
    api: { id, url: "https://example.test", npm: "@ai-sdk/openai-compatible" },
    capabilities: {
      temperature: true, reasoning: true, attachment: true, toolcall: true, interleaved: false,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    cost: { input: 0.3, output: 1.2, cache: { read: 0, write: 0 } },
    limit: { context: 1048576, output: 32768 }, status: "active", release_date: "2026-09-10",
    options: {}, headers: {},
  }
}

async function mount(state: string, width: number, withPrompt = false) {
  const seed = model("deepseek/deepseek-v4.1-flash")
  const next = model("deepseek/deepseek-v5-flash")
  const models = withPrompt ? Object.fromEntries(modelPresets.map((preset) => [preset.seed, {
    ...model(preset.seed), cost: { input: preset.input, output: preset.output, cache: { read: 0, write: 0 } },
  }])) : {}
  const provider = { id: "teai", name: "teai", env: [], models: { ...models, [seed.id]: seed, [next.id]: next } }
  const requests: string[] = []
  const calls = createFetch((url) => {
    requests.push(url.pathname)
    if (url.pathname === "/config/providers") return json({ providers: [provider], default: { teai: seed.id } })
    if (url.pathname === "/provider") return json({ all: [provider], default: { teai: seed.id }, connected: ["teai"] })
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", native: true, options: {}, permission: [] }])
    return undefined
  })
  const events = createEventSource()
  let prompt: PromptRef | undefined
  const [disabled, setDisabled] = createSignal(false)
  let ctx!: { local: ReturnType<typeof useLocal>; sync: ReturnType<typeof useSync>; dialog: ReturnType<typeof useDialog> }
  function Probe() {
    ctx = { local: useLocal(), sync: useSync(), dialog: useDialog() }
    return (
      <Show when={withPrompt}>
        <DataProvider>
          <PromptStashProvider>
            <FrecencyProvider>
              <PromptHistoryProvider>
                <EditorContextProvider integration={{}}>
                  <LocationProvider>
                    <Prompt disabled={disabled()} ref={(value) => { prompt = value }} />
                    <Toast />
                  </LocationProvider>
                </EditorContextProvider>
              </PromptHistoryProvider>
            </FrecencyProvider>
          </PromptStashProvider>
        </DataProvider>
      </Show>
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
                                  <DialogProvider><Probe /></DialogProvider>
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
  const app = await testRender(() => <Harness />, { width, height: 40, kittyKeyboard: true })
  await wait(() => !!ctx && ctx.local.model.ready && ctx.sync.status === "complete")
  async function persisted() {
    // Keep the fixture alive until asynchronous saves and atomic renames finish.
    const expected = JSON.stringify({ recent: ctx.local.model.recent(), favorite: ctx.local.model.favorite() })
    const deadline = Date.now() + 2000
    while (true) {
      const saved = await Bun.file(path.join(state, "model.json")).json()
      const pending = (await readdir(state)).some((name) => name.startsWith("model.json.") && name.endsWith(".tmp"))
      if (!pending && JSON.stringify({ recent: saved.recent, favorite: saved.favorite }) === expected) return
      if (Date.now() > deadline) throw new Error("model selection was not persisted")
      await Bun.sleep(10)
    }
  }
  return { app, ctx, seed, next, prompt, setDisabled, requests, persisted }
}

test.each([80, 140])("migrates saved favorites, renders and selects the successor at %i columns", async (width) => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "model.json")
  const original = {
    favorite: [{ providerID: "teai", modelID: "deepseek/deepseek-v4.1-flash" }],
    recent: [{ providerID: "teai", modelID: "deepseek/deepseek-v4.1-flash" }],
    variant: { "teai/deepseek/deepseek-v4.1-flash": "default" },
  }
  await Bun.write(file, JSON.stringify(original))
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  const { app, ctx, seed, next, persisted } = await mount(tmp.path, width)
  try {
    await wait(() => ctx.local.model.favorite()[0]?.modelID === next.id)
    expect(ctx.local.model.current()).toEqual(original.recent[0])
    // Flush the asynchronous atomic save and inspect the actual persisted state.
    const deadline = Date.now() + 2000
    while ((await Bun.file(file).json()).favorite[0].modelID !== next.id) {
      if (Date.now() > deadline) throw new Error("favorite migration was not persisted")
      await Bun.sleep(10)
    }
    const saved = await Bun.file(file).json()
    expect(saved.favorite[0].presetID).toBe("coding")
    expect(saved.favorite[0].baseline.limit).toEqual(next.limit)
    expect(saved.recent).toEqual(original.recent)
    expect(saved.variant).toEqual(original.variant)
    ctx.dialog.replace(() => <DialogModel />)
    await wait(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain(presetName("coding")!)
    expect(frame).toContain(next.id)
    expect(frame).toContain(modelCostDetail(next.cost))
    if (process.env.LC_ALL === "ja_JP.UTF-8") {
      expect(frame).toContain("コツコツ開発")
      expect(frame).toContain("設定単価 · USD/100万token · 入力 0.3 / 出力 1.2")
    }
    if (process.env.LC_ALL === "en_US.UTF-8") {
      expect(frame).toContain("Code")
      expect(frame).toContain("Configured rate · USD/1M tokens · in 0.3 / out 1.2")
    }
    // The initial selection stays on the current (recent) model. Move to the preset.
    app.mockInput.pressArrow("up")
    await app.renderOnce()
    app.mockInput.pressEnter()
    await wait(() => ctx.local.model.current()?.modelID === next.id)
    expect(ctx.local.model.current()).toEqual({ providerID: "teai", modelID: next.id })

    // A later catalog price increase must be visible and the preset stays selectable.
    ctx.local.model.set({ providerID: "teai", modelID: seed.id })
    ctx.sync.set("provider", 0, "models", next.id, "cost", "output", 2)
    ctx.dialog.replace(() => <DialogModel />)
    await wait(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(modelCostDetail(ctx.sync.data.provider[0].models[next.id].cost))
    expect(app.captureCharFrame()).not.toContain(presetLabels().unavailable)
    app.mockInput.pressArrow("up")
    app.mockInput.pressEnter()
    await wait(() => ctx.local.model.current()?.modelID === next.id)
  } finally {
    app.renderer.destroy()
    await persisted()
  }
})

test.each([80, 140])("selects by click and slash in the real prompt at %i columns", async (width) => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "model.json"), JSON.stringify({
    favorite: [{ providerID: "teai", modelID: "deepseek/deepseek-v4.1-flash" }],
    recent: [{ providerID: "teai", modelID: "deepseek/deepseek-v4.1-flash" }],
  }))
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  const { app, ctx, seed, next, prompt, setDisabled, requests, persisted } = await mount(tmp.path, width, true)
  try {
    if (!prompt) throw new Error("prompt not mounted")
    prompt.focus()
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const draft = { input: "入力中の文章を保持する draft", parts: [] }
    prompt.set(draft)
    await app.renderOnce()
    for (const preset of modelPresets) {
      expect(app.captureCharFrame()).toContain(presetName(preset.id)!)
    }
    const button = app.renderer.root.findDescendantById("model-preset-coding")
    if (!button) throw new Error("coding button not rendered")
    await app.mockMouse.click(button.x + 1, button.y)
    await wait(() => ctx.local.model.current()?.modelID === next.id)
    expect(prompt.current).toEqual(draft)
    expect(prompt.focused).toBe(true)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(`● ${presetName("coding")}`)

    // Type through the real autocomplete path: no model prompt is submitted.
    for (const command of ["/2", "/coding", "/コツコツ開発"]) {
      prompt.reset()
      ctx.local.model.set({ providerID: "teai", modelID: seed.id })
      await app.mockInput.typeText(command)
      await app.renderOnce()
      app.mockInput.pressEnter()
      await wait(() => ctx.local.model.current()?.modelID === next.id)
      expect(prompt.current.input).toBe("")
      expect(prompt.focused).toBe(true)
    }

    for (const [index, preset] of modelPresets.entries()) {
      ctx.local.model.set({ providerID: "teai", modelID: seed.id })
      await app.mockInput.typeText(`/${index + 1}`)
      await app.renderOnce()
      app.mockInput.pressEnter()
      await wait(() => ctx.local.model.current()?.modelID === (preset.id === "coding" ? next.id : preset.seed))
      expect(prompt.current.input).toBe("")
    }
    expect(requests.some((pathname) => /(?:prompt|message|command)$/.test(pathname) && pathname.includes("session"))).toBe(false)

    // Empty prompt arrows wrap through presets; with a draft, right advances to the
    // next model while left keeps cursor navigation.
    ctx.local.model.selectPreset("expert")
    await app.renderOnce()
    app.mockInput.pressArrow("right")
    await app.renderOnce()
    expect(ctx.local.model.current()?.modelID).toBe(modelPresets[0].seed)
    await wait(() => ctx.local.model.current()?.modelID === modelPresets[0].seed)
    app.mockInput.pressArrow("left")
    await app.renderOnce()
    expect(ctx.local.model.current()?.modelID).toBe(modelPresets[4].seed)
    await wait(() => ctx.local.model.current()?.modelID === modelPresets[4].seed)
    prompt.set(draft)
    await app.renderOnce()
    app.mockInput.pressArrow("right")
    await app.renderOnce()
    expect(ctx.local.model.current()?.modelID).toBe(modelPresets[0].seed)
    await wait(() => ctx.local.model.current()?.modelID === modelPresets[0].seed)
    app.mockInput.pressArrow("left")
    await app.renderOnce()
    expect(ctx.local.model.current()?.modelID).toBe(modelPresets[0].seed)
    expect(prompt.current).toEqual(draft)
    prompt.reset()
    ctx.local.model.set({ providerID: "teai", modelID: modelPresets[4].seed })
    setDisabled(true)
    await app.renderOnce()
    app.mockInput.pressArrow("right")
    await app.renderOnce()
    expect(ctx.local.model.current()?.modelID).toBe(modelPresets[4].seed)
    setDisabled(false)

    await app.renderOnce()
    const more = app.renderer.root.findDescendantById("model-preset-more")!
    await app.mockMouse.click(more.x + 1, more.y)
    await app.renderOnce()
    expect(app.renderer.currentFocusedRenderable instanceof InputRenderable).toBe(true)
    await wait(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    app.mockInput.pressArrow("right")
    await app.renderOnce()
    expect(ctx.local.model.current()?.modelID).toBe(modelPresets[4].seed)
    expect(app.captureCharFrame()).toContain(modelBrowseText().recommended)
    app.mockInput.pressKey("s", { ctrl: true })
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(modelBrowseText().price)
    const sorted = app.captureCharFrame()
    expect(sorted.indexOf(modelPresets[0].seed)).toBeLessThan(sorted.indexOf(next.id))
    const sortToggle = app.renderer.root.findDescendantById("model-sort-toggle")!
    await app.mockMouse.click(sortToggle.x + 1, sortToggle.y)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(modelBrowseText().recommended)
    app.mockInput.pressKey("s", { ctrl: true })
    await app.renderOnce()
    // Reset to the first result through search. Price mode keeps the lowest cost first.
    await app.mockInput.typeText("glm")
    await Bun.sleep(10)
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(ctx.local.model.current()?.modelID).toBe(modelPresets[0].seed)
    await wait(() => ctx.local.model.current()?.modelID === modelPresets[0].seed)
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)

    ctx.local.model.set({ providerID: "teai", modelID: seed.id })
    prompt.set(draft)
    setDisabled(true)
    await app.renderOnce()
    const blocked = app.renderer.root.findDescendantById("model-preset-coding")!
    await app.mockMouse.click(blocked.x + 1, blocked.y)
    expect(ctx.local.model.current()?.modelID).toBe(seed.id)
    expect(prompt.current).toEqual(draft)
    setDisabled(false)

    ctx.sync.set("provider", 0, "models", next.id, "cost", "output", 2)
    prompt.reset()
    ctx.local.model.selectPreset("everyday")
    await app.renderOnce()
    // Repriced presets stay selectable by arrow, click and slash.
    app.mockInput.pressArrow("right")
    await wait(() => ctx.local.model.current()?.modelID === next.id)
    ctx.local.model.set({ providerID: "teai", modelID: seed.id })
    prompt.set(draft)
    await app.renderOnce()
    const repriced = app.renderer.root.findDescendantById("model-preset-coding")!
    await app.mockMouse.click(repriced.x + 1, repriced.y)
    expect(ctx.local.model.current()?.modelID).toBe(next.id)
    expect(prompt.current).toEqual(draft)
    ctx.local.model.set({ providerID: "teai", modelID: seed.id })
    prompt.reset()
    await app.mockInput.typeText("/2")
    await app.renderOnce()
    app.mockInput.pressEnter()
    await wait(() => ctx.local.model.current()?.modelID === next.id)
    expect(app.captureCharFrame()).not.toContain(presetLabels().unavailable)
  } finally {
    prompt?.reset()
    app.renderer.destroy()
    await persisted()
  }
})

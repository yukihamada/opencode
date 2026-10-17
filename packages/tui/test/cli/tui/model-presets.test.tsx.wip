/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { onCleanup } from "solid-js"
import type { Model, Provider } from "@sente-ai/sdk/v2"
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
import { localModel, modelPresets, presetName, presetDescription, modelPickerText, modelCostDetail, modelCapabilityDetail } from "../../../src/util/model-presets"
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
    cost: { input: 10, output: 50, cache: { read: 0, write: 0 } },
    limit: { context: 1048576, output: 32768 }, status: "active", release_date: "2026-09-10",
    options: {}, headers: {},
  }
}

async function mount(state: string, width: number, height: number, extra: Provider[] = [], cloud = true) {
  const models = Object.fromEntries([...modelPresets.map((preset) => preset.seed), "other-model"].map((id) => [id, model(id)]))
  const provider = { id: "teai", name: "teai", env: [], models }
  const providers = [...(cloud ? [provider] : []), ...extra]
  const requests: string[] = []
  const calls = createFetch((url) => {
    requests.push(url.pathname)
    if (url.pathname === "/config/providers") return json({ providers, default: { teai: "auto" } })
    if (url.pathname === "/provider") return json({ all: providers, default: { teai: "auto" }, connected: providers.map((item) => item.id) })
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", native: true, options: {}, permission: [] }])
    return undefined
  })
  const events = createEventSource()
  let prompt!: PromptRef
  let ctx!: { local: ReturnType<typeof useLocal>; sync: ReturnType<typeof useSync>; dialog: ReturnType<typeof useDialog> }
  function Probe() {
    ctx = { local: useLocal(), sync: useSync(), dialog: useDialog() }
    return (
      <DataProvider><PromptStashProvider><FrecencyProvider><PromptHistoryProvider>
        <EditorContextProvider integration={{}}><LocationProvider>
          <Prompt ref={(value) => { if (value) prompt = value }} />
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
  return { app, ctx, prompt, requests }
}

test.each([[80, 24], [140, 40]])("model picker restores click, slash, search and keyboard selection at %ix%i", async (width, height) => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "model.json"), JSON.stringify({ recent: [{ providerID: "teai", modelID: "auto" }] }))
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  const { app, ctx, prompt, requests } = await mount(tmp.path, width, height)
  try {
    prompt.focus()
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    await app.renderOnce()
    for (const preset of modelPresets) expect(app.captureCharFrame()).toContain(presetName(preset.id)!)
    const draft = { input: "keep my draft", parts: [] }
    prompt.set(draft)
    await app.renderOnce()
    const button = app.renderer.root.findDescendantById("model-preset-coding")!
    await app.mockMouse.click(button.x + 1, button.y)
    expect(ctx.local.model.current()?.modelID).toBe(modelPresets[1].seed)
    expect(prompt.current).toEqual(draft)
    expect(prompt.focused).toBe(true)
    // The catalog price exceeds the old preset ceiling. Manual choice must still work.
    for (const preset of modelPresets) {
      for (const command of [preset.number, preset.ja, preset.legacy]) {
        prompt.reset()
        await app.mockInput.typeText(`/${command}`)
        await app.renderOnce()
        app.mockInput.pressEnter()
        await wait(() => ctx.local.model.current()?.modelID === preset.seed)
        expect(prompt.current.input).toBe("")
      }
    }
    app.mockInput.pressArrow("right")
    await app.renderOnce()
    expect(ctx.local.model.current()?.modelID).toBe(modelPresets[0].seed)
    ctx.dialog.replace(() => <DialogModel />)
    await wait(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(modelPickerText().curated)
    expect(app.captureCharFrame()).toContain(`${modelPickerText().current}:`)
    expect(app.captureCharFrame()).toContain(presetDescription("everyday")!)
    app.mockInput.pressKey("o", { ctrl: true })
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(modelPickerText().all)
    // Searching includes the full catalog, even after switching back to curated.
    app.mockInput.pressKey("o", { ctrl: true })
    await app.mockInput.typeText("other-model")
    await Bun.sleep(10)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("other-model")
    expect(app.captureCharFrame()).toContain(modelCapabilityDetail(model("other-model")))
    expect(app.captureCharFrame()).toContain(modelCostDetail(model("other-model").cost))
    const lines = app.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes("other-model") && !line.includes("Search"))
    // Choose the rendered option rather than the search input containing the same text.
    const row = lines.findLastIndex((line) => line.includes("other-model"))
    expect(row).toBeGreaterThan(y)
    await app.mockMouse.click(lines[row].indexOf("other-model") + 1, row)
    expect(ctx.local.model.current()?.modelID, "mouse selection").toBe("other-model")
    await wait(() => ctx.local.model.current()?.modelID === "other-model")
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    ctx.dialog.replace(() => <DialogModel />)
    await wait(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await app.mockInput.typeText("glm")
    await Bun.sleep(10)
    await app.renderOnce()
    app.mockInput.pressEnter()
    expect(ctx.local.model.current()?.modelID, "keyboard search selection").toBe(modelPresets[0].seed)
    await wait(() => ctx.local.model.current()?.modelID === modelPresets[0].seed)
    // Search provider names even though search results have no provider category.
    ctx.dialog.replace(() => <DialogModel />)
    await wait(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await app.mockInput.typeText("teai")
    await Bun.sleep(10)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(`${modelPickerText().title} · 7`)
    app.mockInput.pressEscape()
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    // Task descriptions are searchable in either language, without changing the model or draft on cancel.
    prompt.set(draft)
    ctx.dialog.replace(() => <DialogModel />)
    await wait(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await app.mockInput.typeText("second opinions")
    await Bun.sleep(10)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(modelPresets[3].seed)
    // Fuzzy search may include weaker matches, but the task match must rank first.
    app.mockInput.pressEnter()
    await wait(() => ctx.local.model.current()?.modelID === modelPresets[3].seed)
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    // Natural phrasing like "難しい相談" must surface the design/advice preset first.
    ctx.dialog.replace(() => <DialogModel />)
    await wait(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await app.mockInput.typeText("難しい相談")
    await Bun.sleep(10)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(modelPresets[4].seed)
    app.mockInput.pressEnter()
    await wait(() => ctx.local.model.current()?.modelID === modelPresets[4].seed)
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    ctx.dialog.replace(() => <DialogModel />)
    await wait(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await app.mockInput.typeText("glm")
    await Bun.sleep(10)
    await app.renderOnce()
    app.mockInput.pressEscape()
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    expect(ctx.local.model.current()?.modelID).toBe(modelPresets[4].seed)
    expect(prompt.current).toEqual(draft)
    ctx.dialog.replace(() => <DialogModel />)
    await wait(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await app.mockInput.typeText("zzzz-no-model-zzzz")
    await Bun.sleep(10)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(modelPickerText().noMatch)
    app.mockInput.pressEscape()
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    expect(requests.some((pathname) => /(?:prompt|message|command)$/.test(pathname) && pathname.includes("session"))).toBe(false)
    const deadline = Date.now() + 2000
    while ((await Bun.file(path.join(tmp.path, "model.json")).json()).recent[0]?.modelID !== modelPresets[4].seed) {
      if (Date.now() > deadline) throw new Error("model choice was not persisted")
      await Bun.sleep(10)
    }
  } finally {
    prompt.reset()
    app.renderer.destroy()
  }
})

test("local model detection honors endpoint overrides, not provider names", () => {
  const item = model("local-test")
  for (const endpoint of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8080/v1"]) {
    expect(localModel(item, endpoint)).toBe(true)
    expect(localModel({ ...item, api: { ...item.api, url: endpoint } })).toBe(true)
  }
  for (const endpoint of ["", "broken", "file:///localhost/model", "https://localhost.evil.test/v1", "https://ollama.com/v1"]) {
    expect(localModel({ ...item, api: { ...item.api, url: "http://localhost:1234/v1" } }, endpoint)).toBe(false)
  }
})

test.each([true, false])("local picker selects and persists custom loopback providers (cloud=%s)", async (cloud) => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "model.json"), "{}")
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  const item = { ...model("local-qwen"), providerID: "studio-custom", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } }
  const providers: Provider[] = [{
    id: "studio-custom", name: "Studio", source: "config", env: [], options: { baseURL: "http://127.0.0.1:1234/v1" },
    models: { [item.id]: item },
  }, {
    id: "ollama", name: "Remote Ollama", source: "config", env: [], options: { baseURL: "https://example.test/v1" },
    models: { remote: { ...model("remote"), providerID: "ollama" } },
  }]
  const { app, ctx, prompt, requests } = await mount(tmp.path, 80, 24, providers, cloud)
  try {
    await app.renderOnce()
    const button = app.renderer.root.findDescendantById("model-preset-local")!
    expect(button).toBeTruthy()
    expect(app.captureCharFrame()).toContain(`${modelPickerText().local} (1)`)
    const draft = { input: "preserve local draft", parts: [] }
    prompt.set(draft)
    await app.mockMouse.click(button.x + 1, button.y)
    await wait(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(`${modelPickerText().localTitle} · 1`)
    expect(app.captureCharFrame()).toContain("local-qwen")
    expect(app.captureCharFrame()).toContain(modelPickerText().localRate)
    expect(app.captureCharFrame()).not.toContain("Remote Ollama")
    app.mockInput.pressEnter()
    await wait(() => ctx.local.model.current()?.providerID === "studio-custom")
    expect(ctx.local.model.current()?.modelID).toBe("local-qwen")
    expect(prompt.current).toEqual(draft)
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    ctx.dialog.replace(() => <DialogModel />)
    await wait(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    app.mockInput.pressKey("l", { ctrl: true })
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(`${modelPickerText().localTitle} · 1`)
    app.mockInput.pressEscape()
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    prompt.reset()
    await app.mockInput.typeText("/local-models")
    await app.renderOnce()
    app.mockInput.pressEnter()
    await wait(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(`${modelPickerText().localTitle} · 1`)
    const deadline = Date.now() + 2000
    while ((await Bun.file(path.join(tmp.path, "model.json")).json()).recent?.[0]?.modelID !== "local-qwen") {
      if (Date.now() > deadline) throw new Error("local choice was not persisted")
      await Bun.sleep(10)
    }
    expect(requests.some((pathname) => /(?:prompt|message|command)$/.test(pathname) && pathname.includes("session"))).toBe(false)
  } finally {
    prompt.reset()
    app.renderer.destroy()
  }
})

test("local picker explains setup when no local model is configured", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "model.json"), "{}")
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  const { app, ctx, prompt } = await mount(tmp.path, 80, 24)
  try {
    ctx.dialog.replace(() => <DialogModel localOnly />)
    await wait(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("te ollama")
    expect(app.captureCharFrame()).toContain("te lmstudio")
    expect(app.captureCharFrame()).toContain(`${modelPickerText().localTitle} · 0`)
  } finally {
    prompt.reset()
    app.renderer.destroy()
  }
})

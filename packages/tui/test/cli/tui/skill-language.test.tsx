/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { onCleanup } from "solid-js"
import path from "node:path"
import { KVProvider, useKV } from "../../../src/context/kv"
import { useLanguage } from "../../../src/context/language"
import { SDKProvider } from "../../../src/context/sdk"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { DialogSkill } from "../../../src/component/dialog-skill"
import { DialogLanguage } from "../../../src/component/dialog-language"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { localizedDescription, skillLabel } from "../../../src/util/skill-labels"
import { terminalLocale } from "../../../src/util/locale"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createFetch, eventSource, directory, json } from "../../fixture/tui-sdk"
import { tmpdir } from "../../fixture/fixture"
import { wait } from "../cmd/tui/sync-fixture"

async function mount(state: string, width: number, failure = false) {
  const selected: string[] = []
  const calls = createFetch((url) => {
    if (url.pathname !== "/skill") return undefined
    if (failure) return json({ message: "Fixture unavailable" }, { status: 500 })
    return json([
      { name: "apple-login", description: "日本語原文 / English original", location: "/test/apple/SKILL.md" },
      { name: "receipt-organizer", description: "領収書を整理 / Organize receipts", location: "/test/receipts/SKILL.md" },
      { name: "custom-check", description: "独自の確認を行う / Run a custom check", location: "/test/custom/SKILL.md" },
    ])
  })
  let ctx!: { kv: ReturnType<typeof useKV>; language: ReturnType<typeof useLanguage>; dialog: ReturnType<typeof useDialog> }
  function Probe() {
    ctx = { kv: useKV(), language: useLanguage(), dialog: useDialog() }
    return null
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({})
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts paths={{ state, home: state }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={eventSource()}>
                  <ToastProvider><DialogProvider><Probe /></DialogProvider></ToastProvider>
                </SDKProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width, height: 40, kittyKeyboard: true })
  await wait(() => !!ctx && ctx.kv.ready)
  function open() {
    ctx.dialog.replace(() => <DialogSkill onSelect={(id) => selected.push(id)} />)
  }
  return { app, ctx, selected, open }
}

test.each([80, 140])("switches skill copy live, preserves selection and persists language at %i columns", async (width) => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "kv.json")
  await Bun.write(file, JSON.stringify({ language: "ja", unrelated: "keep" }))
  const { app, ctx, selected, open } = await mount(tmp.path, width)
  try {
    open()
    await wait(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Apple ログイン")
    expect(app.captureCharFrame()).not.toContain("Apple sign-in")
    app.mockInput.pressArrow("down")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("/receipt-organizer")
    app.mockInput.pressKey("l", { ctrl: true })
    await wait(() => ctx.language.current() === "en")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Organize receipts")
    expect(app.captureCharFrame()).toContain("/receipt-organizer")
    expect(app.captureCharFrame()).not.toMatch(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u)
    app.mockInput.pressEnter()
    await wait(() => selected.length === 1)
    expect(selected).toEqual(["receipt-organizer"])
    const deadline = Date.now() + 2000
    while ((await Bun.file(file).json()).language !== "en") {
      if (Date.now() > deadline) throw new Error("language was not persisted")
      await Bun.sleep(10)
    }
    expect(await Bun.file(file).json()).toEqual({ language: "en", unrelated: "keep" })
  } finally {
    app.renderer.destroy()
  }
  const restored = await mount(tmp.path, width)
  try {
    expect(restored.ctx.language.current()).toBe("en")
    restored.open()
    await wait(() => restored.app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await restored.app.renderOnce()
    expect(restored.app.captureCharFrame()).toContain("Apple sign-in")
  } finally {
    restored.app.renderer.destroy()
  }
})

test("searches by purpose and original ID, and switches language even with no results", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), JSON.stringify({ language: "ja" }))
  const { app, ctx, selected, open } = await mount(tmp.path, 80)
  try {
    open()
    await wait(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await app.mockInput.typeText("重複")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("領収書を整理")
    expect(app.captureCharFrame()).not.toContain("Apple ログイン")
    app.mockInput.pressEnter()
    await wait(() => selected.length === 1)
    expect(selected[0]).toBe("receipt-organizer")
    open()
    await wait(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await app.mockInput.typeText("custom-check")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("独自の確認を行う")
    app.mockInput.pressEnter()
    await wait(() => selected.length === 2)
    expect(selected[1]).toBe("custom-check")
    open()
    await wait(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await app.mockInput.typeText("no-such-skill")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("該当するスキルがありません")
    app.mockInput.pressKey("l", { ctrl: true })
    await wait(() => ctx.language.current() === "en")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("No skills found")
    expect((app.renderer.currentFocusedRenderable as InputRenderable).value).toBe("no-such-skill")
    const toggle = app.renderer.root.findDescendantById("skill-language-toggle")!
    await app.mockMouse.click(toggle.x + 2, toggle.y)
    await wait(() => ctx.language.current() === "ja")
  } finally {
    app.renderer.destroy()
  }
})

test("language settings select Japanese and the next skills dialog uses it", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), JSON.stringify({ language: "en" }))
  const { app, ctx, open } = await mount(tmp.path, 80)
  try {
    ctx.dialog.replace(() => <DialogLanguage />)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Language settings")
    app.mockInput.pressArrow("up")
    app.mockInput.pressEnter()
    await wait(() => ctx.language.current() === "ja")
    open()
    await wait(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("スキル")
  } finally {
    app.renderer.destroy()
  }
})

test("load failure remains visible and can be localized without selecting a skill", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), JSON.stringify({ language: "ja" }))
  const { app, ctx, selected, open } = await mount(tmp.path, 80, true)
  try {
    open()
    await Bun.sleep(50)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("スキルを読み込めませんでした")
    app.mockInput.pressKey("l", { ctrl: true })
    await wait(() => ctx.language.current() === "en")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Could not load skills")
    app.mockInput.pressEnter()
    expect(selected).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("unknown skills retain identity and unavailable translations are explicit", () => {
  expect(skillLabel({ name: "custom-one", description: "English only" }, "ja")).toEqual({
    title: "custom-one", description: "日本語の説明は未登録です",
  })
  expect(skillLabel({ name: "custom-two" }, "ja").title).toBe("custom-two")
  expect(skillLabel({ name: "constructor" }, "en").title).toBe("constructor")
  expect(localizedDescription("日本語の説明 / English description", "en")).toBe("English description")
  expect(localizedDescription("日本語の説明 / English description", "ja")).toBe("日本語の説明")
  expect(localizedDescription("日本語のみ", "en")).toBe("English description is not available")
})

test("terminal language honors locale precedence and tolerates invalid configuration", () => {
  expect(terminalLocale({ LC_ALL: "ja_JP.UTF-8", LC_MESSAGES: "en_US.UTF-8" })).toBe("ja-JP")
  expect(terminalLocale({ LC_MESSAGES: "en_GB.UTF-8", LANG: "ja_JP.UTF-8" })).toBe("en-GB")
  expect(terminalLocale({ LANG: "ja_JP.UTF-8" })).toBe("ja-JP")
  expect(terminalLocale({ LANG: "C" })).toBe("en-US")
  expect(terminalLocale({ LANG: "POSIX" })).toBe("en-US")
  expect(terminalLocale({ LANG: "!invalid!" })).toBe("en-US")
})

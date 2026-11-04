/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { CliRenderEvents, type CliRenderer, type TerminalColors } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import { ThemeProvider, useTheme, type ThemeSource } from "../src/context/theme"
import { KVProvider } from "../src/context/kv"
import { TuiConfigProvider } from "../src/config"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { TestTuiContexts } from "./fixture/tui-environment"
import { tmpdir } from "./fixture/fixture"

const MARKER = "theme-children-visible"

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function terminalColors(background: string): TerminalColors {
  const palette = Array.from({ length: 16 }, (_, index) => {
    if (index === 0) return background
    if (index === 7) return background === "#000000" ? "#ffffff" : "#000000"
    return "#808080"
  })
  return {
    palette,
    defaultForeground: null,
    defaultBackground: background,
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: null,
    highlightForeground: null,
  }
}

type PaletteCall = Deferred<TerminalColors> & { options: unknown }

function controlPalette(renderer: CliRenderer) {
  const calls: PaletteCall[] = []
  renderer.getPalette = ((options?: unknown) => {
    const call = { ...deferred<TerminalColors>(), options }
    calls.push(call)
    return call.promise
  }) as typeof renderer.getPalette
  return calls
}

function Harness(props: { state: string; source?: ThemeSource; theme?: string }) {
  return (
    <TestTuiContexts paths={{ state: props.state }}>
      <TuiConfigProvider config={createTuiResolvedConfig({ theme: props.theme })}>
        <KVProvider>
          <ThemeProvider mode="dark" source={props.source}>
            <Probe />
            <text>{MARKER}</text>
          </ThemeProvider>
        </KVProvider>
      </TuiConfigProvider>
    </TestTuiContexts>
  )
}

function Probe() {
  const theme = useTheme()
  return <text>{`mode:${theme.mode()}`}</text>
}

async function mount(state: string, source: ThemeSource | undefined, theme?: string) {
  const app = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const calls = controlPalette(app.renderer)
  await render(() => <Harness state={state} source={source} theme={theme} />, app.renderer)
  return { app, calls }
}

async function frame(app: TestRendererSetup) {
  await app.renderOnce()
  await Bun.sleep(10)
  await app.renderOnce()
  return app.captureCharFrame()
}

async function frames(app: TestRendererSetup, count: number) {
  let captured = ""
  for (let index = 0; index < count; index++) captured = await frame(app)
  return captured
}

async function waitForText(app: TestRendererSetup, text: string, tries = 100) {
  for (let index = 0; index < tries; index++) {
    const captured = await frame(app)
    if (captured.includes(text)) return captured
  }
  return frame(app)
}

async function waitForPaletteCall(calls: PaletteCall[], count = 1, tries = 100) {
  for (let index = 0; index < tries; index++) {
    if (calls.length >= count) return
    await Bun.sleep(5)
  }
  throw new Error(`expected ${count} palette call(s), received ${calls.length}`)
}

const immediate: ThemeSource = {
  discover() {
    return Promise.resolve({})
  },
}

test("standard sente theme renders children while palette detection is pending", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const { app, calls } = await mount(tmp.path, immediate)
  try {
    await waitForPaletteCall(calls)
    const captured = await waitForText(app, MARKER)
    expect(captured).toContain(MARKER)
    expect(calls.length).toBeGreaterThan(0)
  } finally {
    app.renderer.destroy()
  }
})

test("system theme waits for palette before rendering children", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const { app, calls } = await mount(tmp.path, immediate, "system")
  try {
    await waitForPaletteCall(calls)
    const pending = await frames(app, 6)
    expect(pending).not.toContain(MARKER)

    calls[0].resolve(terminalColors("#000000"))
    const captured = await waitForText(app, MARKER)
    expect(captured).toContain(MARKER)
  } finally {
    app.renderer.destroy()
  }
})

test("custom theme discovery still blocks rendering until it settles", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const discover = deferred<Record<string, unknown>>()
  const source: ThemeSource = { discover: () => discover.promise }
  const { app, calls } = await mount(tmp.path, source)
  try {
    await waitForPaletteCall(calls)
    calls[0].resolve(terminalColors("#000000"))
    const pending = await frames(app, 6)
    expect(pending).not.toContain(MARKER)

    discover.resolve({})
    const captured = await waitForText(app, MARKER)
    expect(captured).toContain(MARKER)
  } finally {
    app.renderer.destroy()
  }
})

test("palette refresh after startup still updates the active mode", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const { app, calls } = await mount(tmp.path, immediate)
  try {
    await waitForPaletteCall(calls)
    calls[0].resolve(terminalColors("#000000"))
    await waitForText(app, MARKER)

    app.renderer.emit(CliRenderEvents.THEME_MODE, "light")
    await waitForPaletteCall(calls, 2)
    calls[1].resolve(terminalColors("#ffffff"))

    const captured = await waitForText(app, "mode:light")
    expect(captured).toContain("mode:light")
  } finally {
    app.renderer.destroy()
  }
})

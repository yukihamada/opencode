/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { onCleanup } from "solid-js"
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
import { DialogAgent } from "../../../src/component/dialog-agent"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { agentNavigationText } from "../../../src/util/agent-navigation"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createFetch, createEventSource, directory, json } from "../../fixture/tui-sdk"
import { tmpdir } from "../../fixture/fixture"
import { wait } from "../cmd/tui/sync-fixture"

async function mount(state: string, width: number) {
  const calls = createFetch((url) => {
    if (url.pathname !== "/agent") return undefined
    return json(["build", "full", "plan", "investigator", "travel", "hawaii", "director", "fb-messenger", "door-unlock"]
      .map((name) => ({ name, mode: "all", native: false, options: {}, permission: [] })))
  })
  const events = createEventSource()
  let ctx!: { local: ReturnType<typeof useLocal>; sync: ReturnType<typeof useSync>; dialog: ReturnType<typeof useDialog> }
  function Probe() {
    ctx = { local: useLocal(), sync: useSync(), dialog: useDialog() }
    return null
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ agent_navigation: { groups: {
      director: "excluded", "fb-messenger": "excluded", "door-unlock": "operation",
    } } })
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
  await wait(() => !!ctx && ctx.sync.status === "complete")
  async function frame() {
    await wait(() => {
      const input = app.renderer.currentFocusedRenderable
      return input instanceof InputRenderable && !input.isDestroyed && app.renderer.root.findDescendantById(input.id) === input
    })
    await app.renderOnce()
    return app.captureCharFrame()
  }
  async function choose(title: string) {
    const input = app.renderer.currentFocusedRenderable
    expect(input).toBeInstanceOf(InputRenderable)
    if (!(input instanceof InputRenderable)) throw new Error("agent search input is not focused")
    input.value = title
    await app.renderOnce()
    // DialogSelect resets filtered selection on the next timer turn.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const previous = ctx.dialog.stack.at(-1)?.element
    app.mockInput.pressEnter()
    await app.renderOnce()
    if (ctx.dialog.stack.length && ctx.dialog.stack.at(-1)?.element !== previous) {
      await wait(() => app.renderer.currentFocusedRenderable !== input)
    }
  }
  return { app, ctx, frame, choose }
}

test.each([80, 140])("agent navigation renders, selects and preserves direct IDs at %i columns", async (width) => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, ctx, frame, choose } = await mount(tmp.path, width)
  const text = agentNavigationText()
  try {
    ctx.local.agent.set("full")
    ctx.dialog.replace(() => <DialogAgent />)
    const home = await frame()
    for (const name of [text.delegate, text.plan, text.investigate, text.specialist, text.project]) expect(home).toContain(name)
    for (const name of ["hawaii", "director", "fb-messenger", "door-unlock"]) expect(home).not.toContain(name)

    await choose(text.specialist)
    expect(await frame()).toContain("travel")
    await choose("travel")
    await wait(() => ctx.local.agent.current()?.name === "travel")

    ctx.local.agent.move(1)
    expect(ctx.local.agent.current()?.name).toBe("full")
    ctx.local.agent.move(-1)
    expect(ctx.local.agent.current()?.name).toBe("investigator")

    ctx.dialog.replace(() => <DialogAgent />)
    await frame()
    await choose(text.project)
    expect(await frame()).toContain("hawaii")
    await choose(text.back)
    expect(await frame()).toContain(text.delegate)
    await choose(text.project)
    await frame()
    await choose("hawaii")
    expect(ctx.local.agent.current()?.name).toBe("hawaii")

    ctx.dialog.replace(() => <DialogAgent />)
    await frame()
    await choose(text.operation)
    const operation = await frame()
    expect(operation).toContain("door-unlock")
    expect(operation.replace(/\s/g, "")).toContain(text.approval.replace(/\s/g, ""))
    expect(ctx.local.agent.current()?.name).toBe("hawaii")
    await choose("door-unlock")
    expect(ctx.local.agent.current()?.name).toBe("door-unlock")

    // Display exclusion must not cause --agent / resume to fall back to another agent.
    ctx.local.agent.set("director")
    expect(ctx.local.agent.current()?.name).toBe("director")
    expect(ctx.local.agent.list().map((agent) => agent.name)).toContain("fb-messenger")
  } finally {
    app.renderer.destroy()
  }
})

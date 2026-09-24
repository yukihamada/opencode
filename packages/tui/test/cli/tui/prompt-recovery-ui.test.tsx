/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSenteClient } from "@sente-ai/sdk/v2"
import { deliverPrompt } from "../../../src/prompt/send"
import path from "node:path"
import { mkdir, rename } from "node:fs/promises"
import { createSignal, onCleanup } from "solid-js"
import { PromptRecovery } from "../../../src/component/prompt/recovery"
import { PromptStashProvider, usePromptStash, parsePromptStash } from "../../../src/prompt/stash"
import { TuiConfigProvider } from "../../../src/config"
import { ThemeProvider } from "../../../src/context/theme"
import { KVProvider } from "../../../src/context/kv"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import type { PromptInfo } from "../../../src/prompt/history"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

async function wait(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("recovery UI timed out")
    await Bun.sleep(10)
  }
}

async function mount(root: string, options: { width?: number; locale?: string; key?: string } = {}) {
  await Bun.write(path.join(root, "kv.json"), "{}")
  const [session, setSession] = createSignal("session-a")
  const [enabled, setEnabled] = createSignal(true)
  let stash!: ReturnType<typeof usePromptStash>
  let dialog!: ReturnType<typeof useDialog>
  let input!: TextareaRenderable
  let restored: PromptInfo | undefined
  function Content() {
    stash = usePromptStash()
    dialog = useDialog()
    return (
      <box width="100%">
        <PromptRecovery
          sessionID={session()}
          enabled={enabled()}
          locale={options.locale ?? "en-US"}
          current={() => ({ input: input.plainText, mode: "normal", parts: [] })}
          onRestore={(prompt) => {
            restored = prompt
            input.setText(prompt.input)
            input.focus()
          }}
        />
        <textarea
          ref={(value) => {
            input = value
            input.focus()
          }}
          minHeight={1}
        />
      </box>
    )
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ keybinds: options.key ? { "prompt.recover": options.key } : {} })
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts paths={{ home: root, state: root, worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <PromptStashProvider>
                      <Content />
                    </PromptStashProvider>
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width: options.width ?? 90, height: 16, kittyKeyboard: true })
  await wait(() => !!stash && !!input && stash.loaded())
  return {
    app,
    stash,
    dialog,
    input,
    setSession,
    setEnabled,
    restored: () => restored,
    async frame() {
      await app.renderOnce()
      return app.captureCharFrame()
    },
  }
}

const failed = (sessionID: string, id: string) => ({
  input: `original ${id}`,
  mode: "shell" as const,
  parts: [{ type: "file" as const, mime: "image/png", url: "data:image/png;base64,aA==" }],
  timestamp: 1,
  recovery: { id, sessionID },
})

test("persisted failures follow their conversation; Alt+R restores without erasing current input", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "prompt-stash.jsonl")
  await Bun.write(
    file,
    [failed("session-a", "a"), failed("session-b", "b")].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  )
  const ui = await mount(tmp.path)
  try {
    await wait(() => ui.stash.list().length === 2)
    expect(await ui.frame()).toContain("1 unconfirmed submission")
    expect(await ui.frame()).toContain("Restore input")
    ui.setSession("unrelated")
    expect(await ui.frame()).not.toContain("Restore input")
    ui.app.mockInput.pressKey("r", { meta: true })
    expect(ui.restored()).toBeUndefined()

    ui.setSession("session-b")
    ui.input.setText("my next draft")
    await ui.frame()
    ui.app.mockInput.pressKey("r", { meta: true })
    expect(ui.restored()).toEqual({ input: "original b", mode: "shell", parts: failed("session-b", "b").parts })
    expect(ui.input.plainText).toBe("original b")
    expect(ui.input.focused).toBe(true)
    expect(await ui.frame()).not.toContain("Restore input")
    expect(ui.stash.list().some((entry) => entry.input === "my next draft")).toBe(true)
    const expected = JSON.stringify(ui.stash.list())
    await wait(async () => JSON.stringify(parsePromptStash(await Bun.file(file).text())) === expected)
    expect(parsePromptStash(await Bun.file(file).text()).some((entry) => entry.recovery?.id === "a")).toBe(true)
  } finally {
    await ui.stash.flush()
    ui.app.renderer.destroy()
  }
})

test("mouse recovery handles consecutive failures without losing the restored draft", async () => {
  await using tmp = await tmpdir()
  const ui = await mount(tmp.path)
  try {
    ui.stash.push(failed("session-a", "first"))
    ui.stash.push(failed("session-a", "second"))
    const frame = await ui.frame()
    expect(frame).toContain("2 unconfirmed submissions")
    const lines = frame.split("\n")
    const y = lines.findIndex((line) => line.includes("Restore input"))
    await ui.app.mockMouse.click(lines[y].indexOf("Restore input") + 1, y)
    expect(ui.input.plainText).toBe("original second")
    expect(await ui.frame()).toContain("1 unconfirmed submission")
    ui.app.mockInput.pressKey("r", { meta: true })
    expect(ui.input.plainText).toBe("original first")
    expect(ui.stash.list().some((entry) => entry.input === "original second" && !entry.recovery)).toBe(true)
    expect(await ui.frame()).not.toContain("Restore input")
    await ui.stash.flush()
  } finally {
    await ui.stash.flush()
    ui.app.renderer.destroy()
  }
})

test("recovery respects dialogs, disabled input and user keybindings", async () => {
  await using tmp = await tmpdir()
  const ui = await mount(tmp.path, { key: "ctrl+y" })
  try {
    ui.stash.push(failed("session-a", "a"))
    ui.setEnabled(false)
    await ui.frame()
    ui.app.mockInput.pressKey("y", { ctrl: true })
    expect(ui.restored()).toBeUndefined()
    ui.setEnabled(true)
    ui.dialog.replace(() => <text>Other dialog</text>)
    await ui.frame()
    ui.app.mockInput.pressKey("y", { ctrl: true })
    expect(ui.restored()).toBeUndefined()
    ui.dialog.clear()
    await ui.frame()
    ui.app.mockInput.pressKey("y", { ctrl: true })
    expect(ui.input.plainText).toBe("original a")
    await ui.stash.flush()
  } finally {
    await ui.stash.flush()
    ui.app.renderer.destroy()
  }
})

test("Japanese recovery controls remain visible in a narrow terminal", async () => {
  await using tmp = await tmpdir()
  const ui = await mount(tmp.path, { width: 36, locale: "ja-JP" })
  try {
    ui.stash.push(failed("session-a", "a"))
    const frame = await ui.frame()
    expect(frame).toContain("入力を戻す")
    expect(frame).toContain("送信未確認の入力 1件")
    expect(frame).not.toContain("Restore input")
    await ui.stash.flush()
  } finally {
    await ui.stash.flush()
    ui.app.renderer.destroy()
  }
})

test("real HTTP failure survives restart and restores from the recovery UI without resending", async () => {
  await using tmp = await tmpdir()
  let requests = 0
  using server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      requests++
      return Response.json({ name: "UnknownError", data: { message: "Unavailable" } }, { status: 503 })
    },
  })
  const ui = await mount(tmp.path)
  try {
    const result = await deliverPrompt(
      createSenteClient({ baseUrl: server.url.toString() }),
      {
        sessionID: "session-a",
        prompt: { input: "Please review this", parts: failed("session-a", "a").parts, mode: "normal" },
        text: "Please review this",
        agent: "build",
        model: { providerID: "test", modelID: "test" },
        commands: [],
        editorParts: [],
      },
      ui.stash,
    )
    expect(result.sent).toBe(false)
    expect(requests).toBe(1)
    expect(await ui.frame()).toContain("1 unconfirmed submission")
  } finally {
    await ui.stash.flush()
    ui.app.renderer.destroy()
  }
  const restarted = await mount(tmp.path)
  try {
    expect(await restarted.frame()).toContain("Restore input")
    restarted.app.mockInput.pressKey("r", { meta: true })
    expect(restarted.input.plainText).toBe("Please review this")
    expect(restarted.restored()?.parts).toEqual(failed("session-a", "a").parts)
    expect(requests).toBe(1)
  } finally {
    await restarted.stash.flush()
    restarted.app.renderer.destroy()
  }
})

test("disk failure is visible and the in-memory draft remains recoverable", async () => {
  await using tmp = await tmpdir()
  const ui = await mount(tmp.path)
  const file = path.join(tmp.path, "prompt-stash.jsonl")
  try {
    // A directory at the destination forces the real atomic rename to fail.
    await mkdir(file)
    ui.stash.push(failed("session-a", "a"))
    await ui.stash.flush()
    expect(ui.stash.saveError).toBe(true)
    expect(await ui.frame()).toContain("Could not save to disk")
    ui.app.mockInput.pressKey("r", { meta: true })
    expect(ui.input.plainText).toBe("original a")
    await ui.stash.flush()
    await rename(file, path.join(tmp.path, "blocked-destination"))
    ui.stash.push(failed("session-a", "b"))
    await ui.stash.flush()
    expect(ui.stash.saveError).toBe(false)
    expect(await ui.frame()).not.toContain("Could not save to disk")
    expect(parsePromptStash(await Bun.file(file).text()).at(-1)?.input).toBe("original b")
  } finally {
    await ui.stash.flush()
    ui.app.renderer.destroy()
  }
})

test("malformed saved records do not hide valid recoverable input", async () => {
  const valid = failed("session-a", "a")
  const lines = [
    null,
    42,
    {},
    { ...valid, mode: "invalid" },
    { ...valid, parts: [null] },
    { ...valid, recovery: { id: 1 } },
    valid,
  ]
  expect(parsePromptStash(lines.map((line) => JSON.stringify(line)).join("\n"))).toEqual([valid])
})

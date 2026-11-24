/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}


async function mountHelp(root: string, language: "ja" | "en") {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), JSON.stringify({ language }))
  const [{ DialogProvider }, { DialogHelp }, { KVProvider }, { ThemeProvider }, { TuiConfigProvider }, { ToastProvider }, keymapModule] =
    await Promise.all([
      import("../../../src/ui/dialog"),
      import("../../../src/ui/dialog-help"),
      import("../../../src/context/kv"),
      import("../../../src/context/theme"),
      import("../../../src/config"),
      import("../../../src/ui/toast"),
      import("../../../src/keymap"),
    ])
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({ leader_timeout: 1000 })
    onCleanup(keymapModule.registerOpencodeKeymap(keymap, renderer, resolvedConfig))
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <keymapModule.OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <DialogHelp />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </keymapModule.OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  return testRender(() => <Harness />, { width: 140, height: 40 })
}

test("/help describes /btw in the UI language", async () => {
  await using tmp = await tmpdir()
  const en = await mountHelp(tmp.path, "en")
  try {
    await wait(() => en.captureCharFrame().includes("Ask a side question without stopping the task"))
  } finally {
    en.renderer.destroy()
  }
  await using tmp2 = await tmpdir()
  const ja = await mountHelp(tmp2.path, "ja")
  try {
    await wait(() => ja.captureCharFrame().includes("作業を止めずに横から質問"))
  } finally {
    ja.renderer.destroy()
  }
})

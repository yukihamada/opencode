/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { PromptStashProvider, usePromptStash, parsePromptStash } from "../../src/prompt/stash"

test("recovery stash retains attachments and shell mode across reloads", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "prompt-stash.jsonl")
  const old = { input: "older draft", parts: [], timestamp: 1 }
  await Bun.write(file, JSON.stringify(old) + "\n")
  let stash: ReturnType<typeof usePromptStash> | undefined
  function Capture() {
    stash = usePromptStash()
    return <text>Recovery</text>
  }
  const app = await testRender(() => (
    <TestTuiContexts paths={{ state: tmp.path }}>
      <PromptStashProvider>
        <Capture />
      </PromptStashProvider>
    </TestTuiContexts>
  ))
  async function wait(condition: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 2000
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error("stash persistence timed out")
      await Bun.sleep(10)
    }
  }
  try {
    await wait(() => stash?.list().length === 1)
    if (!stash) throw new Error("stash provider did not mount")
    const draft = {
      input: "pwd",
      mode: "shell" as const,
      parts: [{ type: "file" as const, mime: "text/plain", url: "file:///tmp/input.txt" }],
    }
    stash.push(draft)
    draft.input = "new typing"
    draft.parts[0].url = "file:///tmp/changed.txt"
    await wait(async () => parsePromptStash(await Bun.file(file).text()).length === 2)
    const saved = parsePromptStash(await Bun.file(file).text())
    expect(saved[0]).toEqual(old)
    expect(saved[1]).toMatchObject({
      input: "pwd",
      mode: "shell",
      parts: [{ type: "file", mime: "text/plain", url: "file:///tmp/input.txt" }],
    })
    expect(stash.pop()).toEqual(saved[1])
    expect(stash.list()).toEqual([old])
    stash.push({ input: "displaced draft", parts: [] })
    const expected = JSON.stringify(stash.list())
    await wait(async () => JSON.stringify(parsePromptStash(await Bun.file(file).text())) === expected)
    expect(parsePromptStash(await Bun.file(file).text()).map((entry) => entry.input)).toEqual([
      "older draft",
      "displaced draft",
    ])
  } finally {
    app.renderer.destroy()
  }
})

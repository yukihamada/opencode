import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { registerRemote } from "../../src/cli/tui/remote"
import { tmpdir } from "../fixture/fixture"

describe("remote TUI registration", () => {
  test("writes private loopback credentials and removes them on shutdown", async () => {
    await using tmp = await tmpdir()
    const cleanup = await registerRemote({ url: "http://127.0.0.1:4096/", directory: tmp.path, authorization: "Basic fixture" }, tmp.path)
    const files = await fs.readdir(tmp.path)
    const file = files.find((name) => name.endsWith(".json"))!
    const target = path.join(tmp.path, file)
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600)
    expect(await Bun.file(target).json()).toMatchObject({ directory: tmp.path, pid: process.pid })
    await cleanup()
    expect(await Bun.file(target).exists()).toBe(false)
  })

  test("never registers a public listener", async () => {
    await using tmp = await tmpdir()
    for (const url of ["http://0.0.0.0:4096", "http://example.com", "https://127.0.0.1"]) {
      const error = await registerRemote({ url, directory: tmp.path, authorization: "Basic fixture" }, tmp.path).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toContain("loopback")
    }
  })
})

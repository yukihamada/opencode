import { PermissionV1 } from "@sente-ai/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@sente-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Config } from "@/config/config"
import { ShellTool } from "../../src/tool/shell"
import { ShellSandbox } from "../../src/tool/shell/sandbox"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@sente-ai/core/cross-spawn-spawner"
import { FSUtil } from "@sente-ai/core/fs-util"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        CrossSpawnSpawner.node,
        FSUtil.node,
        Plugin.node,
        Truncate.node,
        Config.node,
        Agent.node,
        RuntimeFlags.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

type Ask = Omit<PermissionV1.Request, "id" | "sessionID" | "tool">

// Answers like a non-interactive `sente run`: grants confinement when offered, otherwise allows.
const runner = (requests: Ask[], grant = true) => ({
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: (req: Ask) =>
    Effect.sync(() => {
      requests.push(req)
      const token = req.metadata?.["sandbox"]
      if (grant && typeof token === "string") ShellSandbox.granted.add(token)
    }),
})

const execute = (directory: string, command: string, ctx: ReturnType<typeof runner>) =>
  Effect.gen(function* () {
    const info = yield* ShellTool
    const tool = yield* info.init()
    return yield* tool.execute({ command }, ctx)
  }).pipe(provideInstance(directory))

// Outside both the project and the temp directories, so a confined command may not write here.
const outside = () => {
  const dir = path.join(os.homedir(), ".cache", "sente-sandbox-test")
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${crypto.randomUUID()}.txt`)
}
const writer = (file: string) =>
  `${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync(${JSON.stringify(file)}, "x")'`

afterEach(() => ShellSandbox.disable())

describe.skipIf(!ShellSandbox.available())("tool.shell sandbox", () => {
  it.live("a command approved on condition of confinement cannot write outside the project", () =>
    Effect.gen(function* () {
      ShellSandbox.enable()
      const tmp = yield* tmpdirScoped()
      const target = outside()
      const requests: Ask[] = []
      const result = yield* execute(tmp, `echo inside > in.txt && ${writer(target)}`, runner(requests))
      expect(requests.find((req) => req.permission === "bash")?.metadata?.["sandbox"]).toBeString()
      expect(fs.readFileSync(path.join(tmp, "in.txt"), "utf8").trim()).toBe("inside")
      expect(fs.existsSync(target)).toBe(false)
      expect(result.metadata.exit).not.toBe(0)
      expect(result.output).toContain(ShellSandbox.NOTE)
      expect(ShellSandbox.granted.size).toBe(0)
    }),
  )

  it.live("a command allowed by its rules runs unconfined", () =>
    Effect.gen(function* () {
      ShellSandbox.enable()
      const tmp = yield* tmpdirScoped()
      const target = outside()
      const result = yield* execute(tmp, writer(target), runner([], false))
      expect(result.metadata.exit).toBe(0)
      expect(fs.existsSync(target)).toBe(true)
      expect(result.output).not.toContain(ShellSandbox.NOTE)
      fs.rmSync(target)
    }),
  )

  it.live("commands in a danger class are never offered for confinement", () =>
    Effect.gen(function* () {
      ShellSandbox.enable()
      const tmp = yield* tmpdirScoped()
      for (const command of [
        "rm -f in.txt",
        "git push origin main",
        "curl -X POST https://example.com",
        "osascript -e 'return 1'",
        "python3 -c 'print(1)' && git reset --hard",
      ]) {
        const requests: Ask[] = []
        yield* execute(tmp, command, runner(requests, false)).pipe(Effect.ignore)
        const bash = requests.find((req) => req.permission === "bash")
        expect(bash?.metadata?.["sandbox"]).toBeUndefined()
      }
    }),
  )

  it.live("nothing is offered while the sandbox is off", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const requests: Ask[] = []
      yield* execute(tmp, "echo hi", runner(requests))
      expect(requests.find((req) => req.permission === "bash")?.metadata?.["sandbox"]).toBeUndefined()
    }),
  )

  it.live("the profile blocks the network but allows loopback", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const server = Bun.serve({ port: 0, fetch: () => new Response("local") })
      const probe = (url: string) => {
        const confined = ShellSandbox.command(
          "/bin/sh",
          `${JSON.stringify(process.execPath)} -e 'fetch(${JSON.stringify(url)}, {signal: AbortSignal.timeout(3000)}).then(r => r.text()).then(t => console.log("ok:" + t), e => console.log("blocked"))'`,
          [tmp],
        )
        const child = Bun.spawn([confined.file, ...confined.args], { cwd: tmp, stdout: "pipe" })
        return new Response(child.stdout).text().then((text) => text.trim())
      }
      try {
        expect(yield* Effect.promise(() => probe(`http://127.0.0.1:${server.port}/`))).toBe("ok:local")
        expect(yield* Effect.promise(() => probe("http://1.1.1.1/"))).toBe("blocked")
        expect(yield* Effect.promise(() => probe("http://example.com/"))).toBe("blocked")
      } finally {
        server.stop(true)
      }
    }),
  )
})

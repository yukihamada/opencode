import { describe, expect } from "bun:test"
import { LayerNode } from "@sente-ai/core/effect/layer-node"
import { ConfigProvider, Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@sente-ai/core/cross-spawn-spawner"
import { FSUtil } from "@sente-ai/core/fs-util"
import { Shell } from "@sente-ai/core/shell"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { InstanceStore } from "@/project/instance-store"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { MessageID, SessionID } from "../../src/session/schema"
import { ShellTool } from "../../src/tool/shell"
import type { TaskPromptOps } from "../../src/tool/task"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

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
        BackgroundJob.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_shell_bg"),
  messageID: MessageID.make("msg_shell_bg"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

Shell.acceptable.reset()

const execute = Effect.fn("ShellBackgroundTest.execute")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* ShellTool
  const tool = yield* info.init()
  return yield* tool.execute(args, next)
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const gone = (pid: number, ms = 6_000) =>
  Effect.promise(async () => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (!alive(pid)) return true
      await Bun.sleep(50)
    }
    return !alive(pid)
  })

const flags = (overrides: Partial<RuntimeFlags.Info>) => Effect.provide(RuntimeFlags.layer(overrides))

// POSIX-only: these drive real `sleep` processes and process-group signals.
describe.skipIf(process.platform === "win32")("tool.shell timeout → background", () => {
  it.live("a command that finishes in time behaves as before", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const result = yield* execute({ command: "echo quick", timeout: 5_000 }).pipe(provideInstance(dir))
      expect(result.metadata.exit).toBe(0)
      expect(result.output).toContain("quick")
      expect(result.output).not.toContain("background")
      expect((result.metadata as { background?: boolean }).background).toBeUndefined()
      const jobs = yield* BackgroundJob.Service
      expect(yield* jobs.list().pipe(provideInstance(dir))).toHaveLength(0)
    }),
  )

  it.live(
    "a timed-out command keeps running as a job and its result is retrievable later",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const jobs = yield* BackgroundJob.Service
        yield* Effect.gen(function* () {
          const result = yield* execute({ command: "echo before; sleep 1.5; echo after", timeout: 300 })
          const meta = result.metadata as { background?: boolean; jobId?: string; pid?: number; outputPath?: string }
          expect(meta.background).toBe(true)
          expect(result.metadata.exit).toBeNull()
          expect(result.output).toContain("before")
          expect(result.output).toContain("NOT killed")
          expect(result.output).toContain(`job "${meta.jobId}"`)
          expect(result.output).not.toContain("terminated command")
          expect(alive(meta.pid!)).toBe(true)

          const job = yield* jobs.get(meta.jobId!)
          expect(job?.status).toBe("running")
          expect(job?.metadata?.sessionId).toBe(ctx.sessionID)

          const done = yield* jobs.wait({ id: meta.jobId!, timeout: 10_000 })
          expect(done.timedOut).toBe(false)
          expect(done.info?.status).toBe("completed")
          expect(done.info?.output).toContain("Exit code: 0")
          expect(done.info?.output).toContain("before")
          expect(done.info?.output).toContain("after")
          expect(yield* gone(meta.pid!)).toBe(true)
          // The full output was spilled to a file at handover and kept streaming there.
          expect(yield* Effect.promise(() => Bun.file(meta.outputPath!).text())).toContain("after")
        }).pipe(provideInstance(dir))
      }),
    20_000,
  )

  it.live(
    "with backgrounding disabled a timed-out command is killed as before",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const marker = `${dir}/pid`
        const result = yield* execute({ command: `echo $$ > ${marker}; exec sleep 30`, timeout: 300 }).pipe(
          provideInstance(dir),
          flags({ shellTimeoutBackground: false }),
        )
        expect(result.output).toContain("shell tool terminated command after exceeding timeout 300 ms")
        expect((result.metadata as { background?: boolean }).background).toBeUndefined()
        const pid = Number((yield* Effect.promise(() => Bun.file(marker).text())).trim())
        expect(yield* gone(pid)).toBe(true)
        const tool = yield* ShellTool.pipe(
          Effect.flatMap((info) => info.init()),
          provideInstance(dir),
          flags({ shellTimeoutBackground: false }),
        )
        expect(tool.description).not.toContain("moves to the background")
      }),
    20_000,
  )

  it.live("SENTE_SHELL_TIMEOUT_BACKGROUND=0 turns it off", () =>
    Effect.gen(function* () {
      const read = (env: Record<string, string>) =>
        RuntimeFlags.Service.pipe(
          Effect.provide(
            RuntimeFlags.Service.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))),
          ),
          Effect.orDie,
        )
      expect((yield* read({})).shellTimeoutBackground).toBe(true)
      expect((yield* read({ SENTE_SHELL_TIMEOUT_BACKGROUND: "0" })).shellTimeoutBackground).toBe(false)
      expect((yield* read({ SENTE_SHELL_TIMEOUT_BACKGROUND: "false" })).shellTimeoutBackground).toBe(false)
    }),
  )

  it.live(
    "cancelling the job (user interrupt) stops the process, even one ignoring SIGTERM",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const jobs = yield* BackgroundJob.Service
        yield* Effect.gen(function* () {
          const result = yield* execute({ command: "trap '' TERM; sleep 30", timeout: 300 })
          const meta = result.metadata as { jobId?: string; pid?: number }
          expect(alive(meta.pid!)).toBe(true)
          const started = Date.now()
          const cancelled = yield* jobs.cancel(meta.jobId!)
          expect(cancelled?.status).toBe("cancelled")
          expect(yield* gone(meta.pid!)).toBe(true)
          // SIGTERM is ignored, so the 3 second SIGKILL escalation must have stopped it.
          expect(Date.now() - started).toBeLessThan(6_000)
        }).pipe(provideInstance(dir))
      }),
    20_000,
  )

  it.live(
    "aborting before the timeout still kills the command",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const marker = `${dir}/pid`
        const controller = new AbortController()
        setTimeout(() => controller.abort(), 300)
        const result = yield* execute(
          { command: `echo $$ > ${marker}; exec sleep 30`, timeout: 10_000 },
          { ...ctx, abort: controller.signal },
        ).pipe(provideInstance(dir))
        expect(result.output).toContain("User aborted the command")
        const pid = Number((yield* Effect.promise(() => Bun.file(marker).text())).trim())
        expect(yield* gone(pid)).toBe(true)
        const jobs = yield* BackgroundJob.Service
        expect(yield* jobs.list().pipe(provideInstance(dir))).toHaveLength(0)
      }),
    20_000,
  )

  it.live(
    "disposing the instance (sente run exiting) stops a background command instead of orphaning it",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const result = yield* execute({ command: "trap '' TERM; sleep 60", timeout: 300 }).pipe(provideInstance(dir))
        const pid = (result.metadata as { pid?: number }).pid!
        expect(alive(pid)).toBe(true)
        const started = Date.now()
        const store = yield* InstanceStore.Service
        yield* store.dispose(yield* store.load({ directory: dir }))
        expect(yield* gone(pid)).toBe(true)
        expect(Date.now() - started).toBeLessThan(6_000)
      }),
    20_000,
  )

  it.live(
    "notifies the session when the background command finishes, with secrets redacted",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const jobs = yield* BackgroundJob.Service
        const prompts: string[] = []
        const ops = {
          cancel: () => Effect.void,
          resolvePromptParts: () => Effect.succeed([]),
          prompt: (input: { parts: { type: string; text?: string }[] }) =>
            Effect.sync(() => {
              prompts.push(input.parts.map((part) => part.text ?? "").join(""))
              return {} as never
            }),
        } as unknown as TaskPromptOps
        const secret = "te_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4"
        const previous = process.env.SENTE_NONINTERACTIVE
        delete process.env.SENTE_NONINTERACTIVE
        yield* Effect.gen(function* () {
          const result = yield* execute(
            { command: `sleep 0.8; echo ${secret}`, timeout: 200 },
            { ...ctx, extra: { promptOps: ops } },
          )
          const meta = result.metadata as { jobId?: string }
          expect(result.output).toContain("notified automatically")
          const done = yield* jobs.wait({ id: meta.jobId!, timeout: 10_000 })
          expect(done.info?.output).not.toContain(secret)
          expect(done.info?.output).toContain("[REDACTED]")
        }).pipe(provideInstance(dir))
        const until = Date.now() + 3_000
        while (prompts.length === 0 && Date.now() < until) yield* Effect.promise(() => Bun.sleep(20))
        if (previous !== undefined) process.env.SENTE_NONINTERACTIVE = previous
        expect(prompts).toHaveLength(1)
        expect(prompts[0]).toContain('<background_shell job="')
        expect(prompts[0]).toContain('state="completed"')
        expect(prompts[0]).not.toContain(secret)
      }),
    20_000,
  )

  it.live(
    "a one-shot run (SENTE_NONINTERACTIVE=1) does not inject a follow-up turn",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const jobs = yield* BackgroundJob.Service
        let prompted = 0
        const ops = {
          cancel: () => Effect.void,
          resolvePromptParts: () => Effect.succeed([]),
          prompt: () => Effect.sync(() => (prompted++, {} as never)),
        } as unknown as TaskPromptOps
        const previous = process.env.SENTE_NONINTERACTIVE
        process.env.SENTE_NONINTERACTIVE = "1"
        yield* Effect.gen(function* () {
          const result = yield* execute({ command: "sleep 0.5", timeout: 100 }, { ...ctx, extra: { promptOps: ops } })
          expect(result.output).not.toContain("notified automatically")
          expect(result.output).toContain("wait tool")
          yield* jobs.wait({ id: (result.metadata as { jobId?: string }).jobId!, timeout: 10_000 })
        }).pipe(provideInstance(dir))
        yield* Effect.promise(() => Bun.sleep(200))
        if (previous === undefined) delete process.env.SENTE_NONINTERACTIVE
        else process.env.SENTE_NONINTERACTIVE = previous
        expect(prompted).toBe(0)
      }),
    20_000,
  )
})

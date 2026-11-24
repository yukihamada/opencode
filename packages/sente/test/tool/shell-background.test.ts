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
import { WaitTool } from "../../src/tool/wait"
import { ShellBackground } from "../../src/tool/shell/background"
import { ShellPrompt } from "../../src/tool/shell/prompt"
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
          expect(result.output).toContain("call it again until the job has finished")
          expect(result.output).toContain("SENTE_SHELL_TIMEOUT_BACKGROUND=0")
          yield* jobs.wait({ id: (result.metadata as { jobId?: string }).jobId!, timeout: 10_000 })
        }).pipe(provideInstance(dir))
        yield* Effect.promise(() => Bun.sleep(200))
        if (previous === undefined) delete process.env.SENTE_NONINTERACTIVE
        else process.env.SENTE_NONINTERACTIVE = previous
        expect(prompted).toBe(0)
      }),
    20_000,
  )

  const recorder = () => {
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
    return { prompts, ops }
  }
  const interactive = <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env.SENTE_NONINTERACTIVE
        delete process.env.SENTE_NONINTERACTIVE
        return previous
      }),
      () => self,
      (previous) =>
        Effect.sync(() => {
          if (previous !== undefined) process.env.SENTE_NONINTERACTIVE = previous
        }),
    )
  const waitTool = (args: { job: string; timeout?: number; stop?: boolean }, next: Tool.Context = ctx) =>
    WaitTool.pipe(
      Effect.flatMap((info) => info.init()),
      Effect.flatMap((tool) => tool.execute(args, next)),
    )

  it.live(
    "stops grandchildren too when the job is cancelled",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const marker = `${dir}/grandchild`
        const jobs = yield* BackgroundJob.Service
        yield* Effect.gen(function* () {
          const result = yield* execute({ command: `sleep 41 & echo $! > ${marker}; sleep 40`, timeout: 300 })
          const grandchild = Number((yield* Effect.promise(() => Bun.file(marker).text())).trim())
          expect(alive(grandchild)).toBe(true)
          yield* jobs.cancel((result.metadata as { jobId?: string }).jobId!)
          expect(yield* gone(grandchild)).toBe(true)
        }).pipe(provideInstance(dir))
      }),
    20_000,
  )

  it.live(
    "output past the size limit after the handover is spilled to the file, not lost",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const jobs = yield* BackgroundJob.Service
        yield* Effect.gen(function* () {
          const result = yield* execute({
            command: "sleep 0.6; head -c 300000 /dev/zero | tr '\\0' a; echo; echo TAIL_MARK",
            timeout: 200,
          })
          const meta = result.metadata as { jobId?: string; outputPath?: string }
          const done = yield* jobs.wait({ id: meta.jobId!, timeout: 10_000 })
          expect(done.info?.output).toContain("Full output saved to")
          expect(done.info?.output).toContain("TAIL_MARK")
          const saved = yield* Effect.promise(() => Bun.file(meta.outputPath!).text())
          expect(saved.length).toBeGreaterThanOrEqual(300_000)
          expect(saved).toContain("TAIL_MARK")
        }).pipe(provideInstance(dir))
      }),
    20_000,
  )

  it.live(
    "the real wait tool returns the result, and the session is then not notified a second time",
    () =>
      interactive(
        Effect.gen(function* () {
          const dir = yield* tmpdirScoped()
          const rec = recorder()
          const next = { ...ctx, extra: { promptOps: rec.ops } }
          yield* Effect.gen(function* () {
            const result = yield* execute({ command: "sleep 0.8; echo WAITED", timeout: 200 }, next)
            const job = (result.metadata as { jobId?: string }).jobId!
            const waited = yield* waitTool({ job, timeout: 10 }, next)
            const body = JSON.parse(waited.output)
            expect(body.status).toBe("completed")
            expect(body.output).toContain("WAITED")
            expect(body.output).toContain("Exit code: 0")
          }).pipe(provideInstance(dir))
          yield* Effect.promise(() => Bun.sleep(300))
          expect(rec.prompts).toHaveLength(0)
        }),
      ),
    20_000,
  )

  it.live(
    "a wait that runs out (pending) still lets the finished job be announced",
    () =>
      interactive(
        Effect.gen(function* () {
          const dir = yield* tmpdirScoped()
          const rec = recorder()
          const next = { ...ctx, extra: { promptOps: rec.ops } }
          yield* Effect.gen(function* () {
            const result = yield* execute({ command: "sleep 1.6; echo LATE", timeout: 200 }, next)
            const job = (result.metadata as { jobId?: string }).jobId!
            const waited = JSON.parse((yield* waitTool({ job, timeout: 1 }, next)).output)
            expect(waited.status).toBe("pending")
            expect(waited.note).toContain("notified")
          }).pipe(provideInstance(dir))
          const until = Date.now() + 5_000
          while (rec.prompts.length === 0 && Date.now() < until) yield* Effect.promise(() => Bun.sleep(20))
          expect(rec.prompts).toHaveLength(1)
          expect(rec.prompts[0]).toContain("LATE")
        }),
      ),
    20_000,
  )

  it.live(
    "a failing background command is announced with its exit code",
    () =>
      interactive(
        Effect.gen(function* () {
          const dir = yield* tmpdirScoped()
          const rec = recorder()
          yield* execute(
            { command: "sleep 0.5; echo broken >&2; exit 3", timeout: 150 },
            { ...ctx, extra: { promptOps: rec.ops } },
          ).pipe(provideInstance(dir))
          const until = Date.now() + 5_000
          while (rec.prompts.length === 0 && Date.now() < until) yield* Effect.promise(() => Bun.sleep(20))
          expect(rec.prompts).toHaveLength(1)
          expect(rec.prompts[0]).toContain("Exit code: 3")
          expect(rec.prompts[0]).toContain("broken")
        }),
      ),
    20_000,
  )

  it.live(
    "a one-shot session (marker set by sente run, also over --attach) and a subagent must wait in-turn",
    () =>
      interactive(
        Effect.gen(function* () {
          const dir = yield* tmpdirScoped()
          const jobs = yield* BackgroundJob.Service
          for (const session of [
            { metadata: { [ShellBackground.ONE_SHOT]: ShellBackground.lease() } },
            { parentID: "ses_parent" },
          ]) {
            const rec = recorder()
            yield* Effect.gen(function* () {
              const result = yield* execute(
                { command: "sleep 0.4", timeout: 100 },
                { ...ctx, extra: { promptOps: rec.ops, session } },
              )
              expect(result.output).toContain("This session ends when you finish your reply")
              expect(result.output).not.toContain("notified automatically")
              const job = (result.metadata as { jobId?: string }).jobId!
              expect((yield* jobs.get(job))?.metadata?.mustWait).toBe(true)
              yield* jobs.wait({ id: job, timeout: 10_000 })
            }).pipe(provideInstance(dir))
            yield* Effect.promise(() => Bun.sleep(150))
            expect(rec.prompts).toHaveLength(0)
          }
        }),
      ),
    20_000,
  )

  it.live(
    "wait on a one-shot job that is still running says to call it again",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const result = yield* execute(
            { command: "sleep 1.8", timeout: 100 },
            { ...ctx, extra: { session: { metadata: { [ShellBackground.ONE_SHOT]: ShellBackground.lease() } } } },
          )
          const job = (result.metadata as { jobId?: string }).jobId!
          const first = JSON.parse((yield* waitTool({ job, timeout: 1 })).output)
          expect(first.status).toBe("pending")
          expect(first.note).toContain("Call wait again")
          expect(first.note).not.toContain("Do not automatically retry")
          const second = JSON.parse((yield* waitTool({ job, timeout: 10 })).output)
          expect(second.status).toBe("completed")
        }).pipe(provideInstance(dir))
      }),
    20_000,
  )

  it.live(
    "wait with stop: true stops the job by its ID",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const result = yield* execute({ command: "sleep 40", timeout: 100 })
          const meta = result.metadata as { jobId?: string; pid?: number }
          expect(result.output).toContain("stop: true")
          expect(result.output).not.toContain("kill -TERM")
          const stopped = JSON.parse((yield* waitTool({ job: meta.jobId!, stop: true })).output)
          expect(stopped.status).toBe("cancelled")
          expect(yield* gone(meta.pid!)).toBe(true)
        }).pipe(provideInstance(dir))
      }),
    20_000,
  )

  it.live(
    "the wait tool refuses another session's job",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const result = yield* execute({ command: "sleep 0.5", timeout: 100 })
          const job = (result.metadata as { jobId?: string }).jobId!
          const exit = yield* waitTool({ job }, { ...ctx, sessionID: SessionID.make("ses_someone_else") }).pipe(
            Effect.exit,
          )
          expect(exit._tag).toBe("Failure")
        }).pipe(provideInstance(dir))
      }),
    20_000,
  )

  it.live(
    "a background command is stopped at the lifetime limit",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const jobs = yield* BackgroundJob.Service
        yield* Effect.gen(function* () {
          const result = yield* execute({ command: "trap '' TERM; sleep 40", timeout: 100 })
          const meta = result.metadata as { jobId?: string; pid?: number }
          const done = yield* jobs.wait({ id: meta.jobId!, timeout: 10_000 })
          expect(done.info?.status).toBe("completed")
          expect(done.info?.output).toContain("limit set by SENTE_SHELL_BACKGROUND_MAX_MS")
          expect(yield* gone(meta.pid!)).toBe(true)
        }).pipe(provideInstance(dir), flags({ shellBackgroundMaxMs: 500 }))
      }),
    20_000,
  )

  it.live(
    "past the per-session limit a timed-out command is stopped instead of piling up",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const jobs = yield* BackgroundJob.Service
        yield* Effect.gen(function* () {
          const first = yield* execute({ command: "sleep 40", timeout: 100 })
          expect((first.metadata as { background?: boolean }).background).toBe(true)
          const second = yield* execute({ command: "sleep 40", timeout: 100 })
          expect((second.metadata as { background?: boolean }).background).toBeUndefined()
          expect(second.output).toContain("already running in the background in this session")
          expect(second.output).toContain("shell tool terminated command")
          yield* jobs.cancel((first.metadata as { jobId?: string }).jobId!)
        }).pipe(provideInstance(dir), flags({ shellBackgroundMaxJobs: 1 }))
      }),
    20_000,
  )

  it.live(
    "a command finishing right around the deadline never ends up reported as stopped",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const jobs = yield* BackgroundJob.Service
        yield* Effect.gen(function* () {
          for (const delay of ["0.36", "0.38", "0.40", "0.42"]) {
            const result = yield* execute({ command: `sleep ${delay}; echo DONE_${delay}`, timeout: 300 })
            const meta = result.metadata as { background?: boolean; jobId?: string }
            expect(result.output).not.toContain("terminated command")
            if (!meta.background) {
              expect(result.metadata.exit).toBe(0)
              expect(result.output).toContain(`DONE_${delay}`)
              continue
            }
            const done = yield* jobs.wait({ id: meta.jobId!, timeout: 10_000 })
            expect(done.info?.output).toContain(`DONE_${delay}`)
          }
        }).pipe(provideInstance(dir))
      }),
    30_000,
  )

  it.live(
    "commands timing out together still respect the per-session limit",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const jobs = yield* BackgroundJob.Service
        yield* Effect.gen(function* () {
          const results = yield* Effect.all(
            [1, 2, 3, 4].map(() => execute({ command: "sleep 40", timeout: 100 })),
            { concurrency: "unbounded" },
          )
          const moved = results.filter((result) => (result.metadata as { background?: boolean }).background)
          expect(moved).toHaveLength(2)
          expect(results.filter((result) => result.output.includes("already running in the background"))).toHaveLength(
            2,
          )
          for (const result of moved) yield* jobs.cancel((result.metadata as { jobId?: string }).jobId!)
        }).pipe(provideInstance(dir), flags({ shellBackgroundMaxJobs: 2 }))
      }),
    20_000,
  )
})

describe("shell background: one-shot lease", () => {
  it.effect("a live lease means wait in-turn; an expired or dead-run lease does not", () =>
    Effect.sync(() => {
      const now = Date.now()
      const fresh = ShellBackground.lease(now)
      expect(ShellBackground.mustWait({ metadata: { [ShellBackground.ONE_SHOT]: fresh } }, {}, now)).toBe(true)
      expect(
        ShellBackground.mustWait({ metadata: { [ShellBackground.ONE_SHOT]: { ...fresh, until: now - 1 } } }, {}, now),
      ).toBe(false)
      // Same machine, but the run that took the lease is gone (Ctrl-C, crash): ignored right away.
      expect(
        ShellBackground.mustWait(
          { metadata: { [ShellBackground.ONE_SHOT]: { ...fresh, pid: 2 ** 22 + 12345 } } },
          {},
          now,
        ),
      ).toBe(false)
      // Another machine's run cannot be probed; its lease counts until it expires.
      expect(
        ShellBackground.mustWait(
          { metadata: { [ShellBackground.ONE_SHOT]: { ...fresh, host: "elsewhere", pid: 2 ** 22 + 12345 } } },
          {},
          now,
        ),
      ).toBe(true)
      expect(ShellBackground.mustWait({ metadata: { [ShellBackground.ONE_SHOT]: true } }, {}, now)).toBe(false)
      expect(ShellBackground.mustWait({}, {}, now)).toBe(false)
      expect(ShellBackground.mustWait({}, { SENTE_NONINTERACTIVE: "1" }, now)).toBe(true)
    }),
  )
})

describe("shell tool description", () => {
  it.effect("every shell profile carries the exact timeout note for each mode", () =>
    Effect.sync(() => {
      const limits = { maxLines: 2000, maxBytes: 51200 } as never
      for (const name of ["bash", "zsh", "pwsh", "powershell", "cmd"]) {
        for (const background of [false, true]) {
          const description = ShellPrompt.render(name, "darwin", limits, 1234, background).description
          expect(description).toContain(ShellPrompt.timeoutNote(1234, background))
          expect(description).not.toContain(ShellPrompt.timeoutNote(1234, !background))
        }
      }
      const note = ShellPrompt.timeoutNote(1234, true)
      expect(note).not.toContain("kind")
      expect(note).toContain("notification")
      expect(note).toContain("offered once such a job exists")
    }),
  )
})

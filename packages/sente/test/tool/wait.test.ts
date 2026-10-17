import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Schema } from "effect"
import { LayerNode } from "@sente-ai/core/effect/layer-node"
import { BackgroundJob } from "@/background/job"
import { MessageID, SessionID } from "@/session/schema"
import { CrossSpawnSpawner } from "@sente-ai/core/cross-spawn-spawner"
import { FSUtil } from "@sente-ai/core/fs-util"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { WaitTool, Parameters, githubCommand } from "@/tool/wait"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Config.node,
      Agent.node,
      Truncate.node,
      RuntimeFlags.node,
      BackgroundJob.node,
    ]),
  ),
)
const ctx = {
  sessionID: SessionID.make("ses_wait"),
  messageID: MessageID.make("msg_wait"),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("tool.wait", () => {
  it.effect("validates GitHub identifiers and builds a bounded pinned wait", () =>
    Effect.sync(() => {
      const decode = Schema.decodeUnknownSync(Parameters)
      const params = decode({ kind: "github", repo: "owner/repo", run: "42", attempt: 2, timeout: 300 })
      expect(githubCommand(params)).toBe("te wait github --repo 'owner/repo' --run '42' --attempt 2 --timeout 300")
      for (const fields of [{ repo: "o/r; touch /tmp/x" }, { run: "$(id)" }, { timeout: 0 }, { timeout: 3601 }]) {
        expect(() => decode({ kind: "github", repo: "o/r", run: "1", ...fields })).toThrow()
      }
      expect(() => githubCommand({ kind: "github" })).toThrow("requires repo")
    }),
  )

  it.instance("returns completed job output without a prompt operation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "test",
        metadata: { parentSessionId: ctx.sessionID },
        run: Effect.succeed("verified output"),
      })
      const tool = yield* WaitTool
      const def = yield* tool.init()
      const result = yield* def.execute({ kind: "job", job: job.id }, ctx)
      expect(JSON.parse(result.output)).toMatchObject({ status: "completed", output: "verified output" })
    }),
  )

  it.instance("timeout is pending and does not cancel the job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const gate = yield* Deferred.make<string>()
      const job = yield* jobs.start({ type: "test", metadata: { parentSessionId: ctx.sessionID }, run: Deferred.await(gate) })
      const tool = yield* WaitTool
      const def = yield* tool.init()
      const result = yield* def.execute({ kind: "job", job: job.id, timeout: 1 }, ctx)
      expect(JSON.parse(result.output).status).toBe("pending")
      expect((yield* jobs.get(job.id))?.status).toBe("running")
      yield* Deferred.succeed(gate, "done")
      expect((yield* jobs.wait({ id: job.id })).info?.status).toBe("completed")
    }),
  )

  it.instance("rejects another session's job and abort leaves owned work running", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({ type: "test", metadata: { parentSessionId: "other" }, run: Effect.never })
      const tool = yield* WaitTool
      const def = yield* tool.init()
      const denied = yield* def.execute({ kind: "job", job: job.id }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
      if (Exit.isFailure(denied)) expect(Cause.pretty(denied.cause)).toContain("Job not found in this session")
      const owned = yield* jobs.start({ type: "test", metadata: { sessionId: ctx.sessionID }, run: Effect.never })
      const aborted = yield* def
        .execute({ kind: "job", job: owned.id }, { ...ctx, abort: AbortSignal.abort() })
        .pipe(Effect.exit)
      expect(Exit.isFailure(aborted)).toBe(true)
      expect((yield* jobs.get(owned.id))?.status).toBe("running")
    }),
  )

  it.instance("GitHub wait still enforces shell permission", () =>
    Effect.gen(function* () {
      const tool = yield* WaitTool
      const def = yield* tool.init()
      const asked: string[] = []
      const result = yield* def
        .execute(
          { kind: "github", repo: "owner/repo", run: "42" },
          {
            ...ctx,
            ask: (req) => {
              asked.push(req.permission)
              return req.permission === "bash" ? Effect.die(new Error("shell denied")) : Effect.void
            },
          },
        )
        .pipe(Effect.exit)
      expect(asked).toContain("wait")
      expect(asked).toContain("bash")
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("shell denied")
    }),
  )
})

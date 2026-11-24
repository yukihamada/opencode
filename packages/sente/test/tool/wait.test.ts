import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit } from "effect"
import { LayerNode } from "@sente-ai/core/effect/layer-node"
import { BackgroundJob } from "@/background/job"
import { MessageID, SessionID } from "@/session/schema"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Config } from "@/config/config"
import { WaitTool } from "@/tool/wait"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Config.node, Agent.node, Truncate.node, BackgroundJob.node])))
const ctx = {
  sessionID: SessionID.make("ses_wait"),
  messageID: MessageID.make("msg_wait"),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}
const tool = WaitTool.pipe(Effect.flatMap((info) => info.init()))

describe("tool.wait (background bash jobs)", () => {
  it.instance("returns a completed job's output", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "bash",
        metadata: { sessionId: ctx.sessionID },
        run: Effect.succeed("verified output"),
      })
      const result = yield* (yield* tool).execute({ job: job.id }, ctx)
      expect(JSON.parse(result.output)).toMatchObject({ status: "completed", output: "verified output" })
    }),
  )

  it.instance("timeout is pending and does not cancel the job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const gate = yield* Deferred.make<string>()
      const job = yield* jobs.start({ type: "bash", metadata: { sessionId: ctx.sessionID }, run: Deferred.await(gate) })
      const result = yield* (yield* tool).execute({ job: job.id, timeout: 1 }, ctx)
      expect(JSON.parse(result.output).status).toBe("pending")
      expect((yield* jobs.get(job.id))?.status).toBe("running")
      yield* Deferred.succeed(gate, "done")
      expect((yield* jobs.wait({ id: job.id })).info?.status).toBe("completed")
    }),
  )

  it.instance("refuses other sessions' jobs and subagent task jobs; abort leaves the job running", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const def = yield* tool
      const foreign = yield* jobs.start({ type: "bash", metadata: { sessionId: "other" }, run: Effect.never })
      const task = yield* jobs.start({ type: "task", metadata: { parentSessionId: ctx.sessionID }, run: Effect.never })
      for (const id of [foreign.id, task.id]) {
        for (const stop of [false, true]) {
          const denied = yield* def.execute({ job: id, stop }, ctx).pipe(Effect.exit)
          expect(Exit.isFailure(denied)).toBe(true)
          if (Exit.isFailure(denied)) expect(Cause.pretty(denied.cause)).toContain("No background bash command")
        }
      }
      expect((yield* jobs.get(task.id))?.status).toBe("running")
      const owned = yield* jobs.start({ type: "bash", metadata: { sessionId: ctx.sessionID }, run: Effect.never })
      const aborted = yield* def.execute({ job: owned.id }, { ...ctx, abort: AbortSignal.abort() }).pipe(Effect.exit)
      expect(Exit.isFailure(aborted)).toBe(true)
      expect((yield* jobs.get(owned.id))?.status).toBe("running")
    }),
  )

  it.instance("asks the wait permission with the job ID as pattern", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({ type: "bash", metadata: { sessionId: ctx.sessionID }, run: Effect.succeed("") })
      const asked: string[][] = []
      yield* (yield* tool).execute(
        { job: job.id },
        { ...ctx, ask: (req) => Effect.sync(() => void asked.push([req.permission, ...req.patterns])) },
      )
      expect(asked).toEqual([["wait", job.id]])
    }),
  )
})

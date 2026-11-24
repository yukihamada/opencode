import { Effect, Schema } from "effect"
import { BackgroundJob } from "@/background/job"
import { Tool } from "./tool"
import { ShellBackground } from "./shell/background"
import { ShellID } from "./shell/id"

export const Parameters = Schema.Struct({
  job: Schema.String.annotate({ description: "Job ID of a bash command that moved to the background" }),
  timeout: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3600 }))).annotate({
    description: "Seconds to wait (default 570, max 3600); returns pending if it is still running",
  }),
  stop: Schema.optional(Schema.Boolean).annotate({ description: "Stop the command instead of waiting" }),
})

/**
 * Collects (or stops) a bash command of this session that outlived its timeout. Only background shell
 * jobs are reachable: subagent task jobs and other sessions' jobs are refused. Stopping asks no shell
 * permission beyond `wait`, since it only ends a command this session was already allowed to start.
 */
export const WaitTool = Tool.define(
  "wait",
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    return {
      description:
        "Wait for a bash command of this session that moved to the background and get its exit code and output, or stop it.",
      parameters: Parameters,
      execute: (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<Record<string, unknown>>> =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "wait", patterns: [params.job], always: ["*"], metadata: params })
          const job = yield* jobs.get(params.job)
          if (!job || job.type !== ShellID.ToolID || job.metadata?.sessionId !== ctx.sessionID) {
            return yield* Effect.die(new Error("No background bash command with this job ID in this session"))
          }
          if (params.stop) {
            const stopped = yield* jobs.cancel(job.id)
            return {
              title: `Stop ${job.title ?? job.id}`,
              metadata: { jobId: job.id, status: stopped?.status ?? "unknown", timedOut: false },
              output: JSON.stringify({
                job: job.id,
                status: stopped?.status ?? "unknown",
                output: stopped?.output,
                ...(typeof job.metadata?.outputPath === "string" ? { outputPath: job.metadata.outputPath } : {}),
              }),
            }
          }
          const aborted = Effect.callback<never>((resume) => {
            const cancel = () => resume(Effect.die(new Error("Wait interrupted; the job was not cancelled")))
            if (ctx.abort.aborted) return cancel()
            ctx.abort.addEventListener("abort", cancel, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", cancel))
          })
          // While this call blocks, and once it has delivered the result, the job is not announced again.
          ShellBackground.beginWait(job.id)
          const result = yield* Effect.raceFirst(
            jobs.wait({ id: job.id, timeout: (params.timeout ?? 570) * 1000 }),
            aborted,
          ).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => ShellBackground.endWait(job.id, exit._tag === "Success" && !exit.value.timedOut)),
            ),
          )
          const status = result.timedOut ? "pending" : (result.info?.status ?? "unknown")
          // A one-shot run or subagent ends (and stops the job) with its reply, so it must keep waiting.
          const note =
            job.metadata?.mustWait === true
              ? "Job still running. Call wait again with the same job until it has finished; do not end your reply before that."
              : "Job still running. You will be notified when it finishes; do not poll."
          return {
            title: job.title ?? job.id,
            metadata: { jobId: job.id, status, timedOut: result.timedOut },
            output: JSON.stringify({
              job: job.id,
              status,
              output: result.info?.output,
              error: result.info?.error,
              ...(result.timedOut ? { note } : {}),
            }),
          }
        }),
    }
  }),
)

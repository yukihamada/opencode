import { Effect, Schema } from "effect"
import { BackgroundJob } from "@/background/job"
import { Tool } from "./tool"
import { ShellTool } from "./shell"

export const Parameters = Schema.Struct({
  kind: Schema.Literals(["github", "job"]),
  repo: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/))),
  run: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9]+$/))),
  attempt: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  job: Schema.optional(Schema.String),
  timeout: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3600 }))).annotate({
    description: "Wait budget in seconds (default 570, maximum 3600). Returns pending on timeout; do not automatically retry.",
  }),
})

export function githubCommand(params: Schema.Schema.Type<typeof Parameters>) {
  if (!params.repo || !params.run) throw new Error("github requires repo (OWNER/REPO) and run (numeric run ID)")
  return `te wait github --repo '${params.repo}' --run '${params.run}'${params.attempt ? ` --attempt ${params.attempt}` : ""} --timeout ${params.timeout ?? 570}`
}

export const WaitTool = Tool.define(
  "wait",
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    const shell = yield* ShellTool
    return {
      description:
        "Wait once for a known GitHub Actions run or an existing job owned by this session, without model polling. GitHub uses the installed te wait CLI and existing shell permissions; do not auto-retry on timeout/error. Exit 0 confirms the workflow attempt, not its deliverable. Jobs return completed/error/cancelled or pending. Does not start, retry, cancel or deploy work. For a new local command use bash with an adequate timeout instead. Background tasks already notify automatically; use this only when the result is now required.",
      parameters: Parameters,
      execute: (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<Record<string, unknown>>> =>
        Effect.gen(function* () {
          const timeout = params.timeout ?? 570
          yield* ctx.ask({
            permission: "wait",
            patterns: [params.kind === "github" ? `${params.repo}/${params.run}` : (params.job ?? "")],
            always: ["*"],
            metadata: params,
          })
          if (params.kind === "github") {
            if (params.job) throw new Error("job is only valid for kind=job")
            const bash = yield* shell.init()
            const result = yield* bash.execute({ command: githubCommand(params), timeout: (timeout + 10) * 1000 }, ctx)
            return {
              ...result,
              title: `Wait for ${params.repo} run ${params.run}`,
              output: `${result.output}\n\nWorkflow wait exit: ${result.metadata.exit ?? "interrupted/timeout"}. Verify the deliverable separately; do not automatically retry.`,
            }
          }
          if (!params.job || params.repo || params.run || params.attempt)
            throw new Error("kind=job requires only job and optional timeout")
          const job = yield* jobs.get(params.job)
          if (!job || (job.metadata?.parentSessionId !== ctx.sessionID && job.metadata?.sessionId !== ctx.sessionID)) {
            throw new Error("Job not found in this session")
          }
          const aborted = Effect.callback<never>((resume) => {
            const cancel = () => resume(Effect.die(new Error("Wait interrupted; the job was not cancelled")))
            if (ctx.abort.aborted) return cancel()
            ctx.abort.addEventListener("abort", cancel, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", cancel))
          })
          const result = yield* Effect.raceFirst(jobs.wait({ id: job.id, timeout: timeout * 1000 }), aborted)
          const status = result.timedOut ? "pending" : (result.info?.status ?? "unknown")
          return {
            title: job.title ?? job.id,
            metadata: { jobId: job.id, status, timedOut: result.timedOut },
            output: JSON.stringify({
              job: job.id,
              status,
              output: result.info?.output,
              error: result.info?.error,
              ...(result.timedOut ? { note: "Wait budget exhausted; job still running. Do not automatically retry." } : {}),
            }),
          }
        }),
    }
  }),
)

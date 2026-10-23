export * as SessionOrchestrator from "./orchestrator"

import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { and, asc, eq } from "drizzle-orm"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { AgentV2 } from "../agent"
import { Location } from "../location"
import { ModelV2 } from "../model"
import { SessionV2 } from "../session"
import { SessionExecution } from "./execution"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionOrchestrationEvaluationTable, SessionOrchestrationTable } from "./sql"

export const Status = Schema.Literals(["running", "completed", "incomplete"])
export type Status = typeof Status.Type

export interface Info {
  readonly id: string
  readonly sessionID: SessionSchema.ID
  readonly objective: string
  readonly status: Status
  readonly maxEvaluations: number
  readonly evaluations: number
}

export interface Evaluation {
  readonly seq: number
  readonly verdict: "complete" | "incomplete"
  readonly reason?: string
}

export interface Result {
  readonly info: Info
  readonly evaluations: ReadonlyArray<Evaluation>
  readonly lastAssistantText?: string
}

export class IncompleteError extends Schema.TaggedErrorClass<IncompleteError>()("SessionOrchestrator.IncompleteError", {
  sessionID: SessionSchema.ID,
  evaluations: Schema.Number,
}) {}

export class RunFailedError extends Schema.TaggedErrorClass<RunFailedError>()("SessionOrchestrator.RunFailedError", {
  sessionID: SessionSchema.ID,
  message: Schema.String,
}) {}

export interface Interface {
  /** Creates a child session, admits the objective, and returns once the run is admitted. */
  readonly spawn: (input: {
    readonly parentID: SessionSchema.ID
    readonly objective: string
    readonly agent?: AgentV2.ID
    readonly model?: ModelV2.Ref
    readonly maxEvaluations?: number
  }) => Effect.Effect<Info, SessionV2.NotFoundError | SessionV2.PromptConflictError>
  /** Runs the objective to completion: after each idle, evaluates and re-prompts while incomplete. */
  readonly run: (input: {
    readonly parentID: SessionSchema.ID
    readonly objective: string
    readonly agent?: AgentV2.ID
    readonly model?: ModelV2.Ref
    readonly maxEvaluations?: number
  }) => Effect.Effect<
    Result,
    SessionV2.NotFoundError | SessionV2.PromptConflictError | IncompleteError | RunFailedError
  >
  readonly status: (sessionID: SessionSchema.ID) => Effect.Effect<Info | undefined>
  readonly list: (parentID: SessionSchema.ID) => Effect.Effect<Info[], SessionV2.NotFoundError>
  readonly evaluations: (sessionID: SessionSchema.ID) => Effect.Effect<Evaluation[]>
}

export class Service extends Context.Service<Service, Interface>()("@sente/v2/SessionOrchestrator") {}

const DefaultMaxEvaluations = 3

const FollowupPrompt = (objective: string, reason: string | undefined) =>
  `The previous run ended before the objective was complete.

Objective:
${objective}

${reason === undefined ? "" : `Evaluator note:\n${reason}\n\n`}Continue the work and finish the objective. When the objective is fully complete, end your final message with the exact line:

OBJECTIVE COMPLETE`

const ObjectivePrompt = (objective: string) =>
  `${objective}

Work until this objective is fully complete. When it is fully complete, end your final message with the exact line:

OBJECTIVE COMPLETE`

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessions = yield* SessionV2.Service
    const execution = yield* SessionExecution.Service

    const toInfo = (
      row: typeof SessionOrchestrationTable.$inferSelect,
      evaluations: number,
    ): Info => ({
      id: row.id,
      sessionID: SessionSchema.ID.make(row.session_id),
      objective: row.objective,
      status: row.status as Status,
      maxEvaluations: row.max_evaluations,
      evaluations,
    })

    const evaluationCount = Effect.fn("SessionOrchestrator.evaluationCount")(function* (orchestrationID: string) {
      const rows = yield* db
        .select({ id: SessionOrchestrationEvaluationTable.id })
        .from(SessionOrchestrationEvaluationTable)
        .where(eq(SessionOrchestrationEvaluationTable.orchestration_id, orchestrationID))
        .all()
        .pipe(Effect.orDie)
      return rows.length
    })

    const recordEvaluation = Effect.fn("SessionOrchestrator.recordEvaluation")(function* (input: {
      orchestrationID: string
      verdict: "complete" | "incomplete"
      reason?: string
    }) {
      const now = Date.now()
      const seq = (yield* evaluationCount(input.orchestrationID)) + 1
      yield* db
        .insert(SessionOrchestrationEvaluationTable)
        .values({
          id: `soe_${crypto.randomUUID()}`,
          orchestration_id: input.orchestrationID,
          seq,
          verdict: input.verdict,
          reason: input.reason,
          time_created: now,
        })
        .run()
        .pipe(Effect.orDie)
      return seq
    })

    const lastAssistantText = Effect.fn("SessionOrchestrator.lastAssistantText")(function* (
      sessionID: SessionSchema.ID,
    ) {
      const messages = yield* sessions.messages({ sessionID, limit: 20, order: "desc" }).pipe(Effect.orElseSucceed(() => []))
      const assistant = messages.find((message) => message.type === "assistant")
      if (assistant === undefined || assistant.type !== "assistant") return undefined
      return assistant.content
        .filter((part): part is SessionMessage.AssistantText => part.type === "text")
        .map((part) => part.text)
        .join("\n")
    })

    const evaluate = Effect.fn("SessionOrchestrator.evaluate")(function* (input: {
      orchestrationID: string
      sessionID: SessionSchema.ID
    }) {
      const text = yield* lastAssistantText(input.sessionID)
      const complete = text !== undefined && text.includes("OBJECTIVE COMPLETE")
      yield* recordEvaluation({
        orchestrationID: input.orchestrationID,
        verdict: complete ? "complete" : "incomplete",
        reason: complete ? undefined : "Completion marker missing from the last assistant message",
      })
      return { complete, text }
    })

    const admit = Effect.fn("SessionOrchestrator.admit")(function* (input: {
      parentID: SessionSchema.ID
      objective: string
      agent?: AgentV2.ID
      model?: ModelV2.Ref
      maxEvaluations: number
    }) {
      const parent = yield* sessions.get(input.parentID)
      const child = yield* sessions.create({
        parentID: parent.id,
        agent: input.agent,
        model: input.model,
        location: Location.Ref.make({
          directory: parent.location.directory,
          ...(parent.location.workspaceID === undefined ? {} : { workspaceID: parent.location.workspaceID }),
        }),
      })
      const now = Date.now()
      const row = {
        id: `sor_${crypto.randomUUID()}`,
        session_id: child.id,
        objective: input.objective,
        status: "running",
        evaluator: "completion-marker",
        max_evaluations: input.maxEvaluations,
        time_created: now,
        time_updated: now,
        time_completed: null,
      }
      yield* db.insert(SessionOrchestrationTable).values(row).run().pipe(Effect.orDie)
      yield* sessions.prompt({ sessionID: child.id, prompt: { text: ObjectivePrompt(input.objective) } })
      return toInfo(row, 0)
    })

    return Service.of({
      spawn: Effect.fn("SessionOrchestrator.spawn")(function* (input) {
        return yield* admit({ ...input, maxEvaluations: input.maxEvaluations ?? DefaultMaxEvaluations })
      }),
      run: Effect.fn("SessionOrchestrator.run")(function* (input) {
        const maxEvaluations = input.maxEvaluations ?? DefaultMaxEvaluations
        const admitted = yield* admit({ ...input, maxEvaluations })
        const row = yield* db
          .select()
          .from(SessionOrchestrationTable)
          .where(eq(SessionOrchestrationTable.id, admitted.id))
          .get()
          .pipe(Effect.orDie)
        if (row === undefined) return yield* Effect.die(`Orchestration not found: ${admitted.id}`)

        const finish = Effect.fn("SessionOrchestrator.finish")(function* (status: Status) {
          const now = Date.now()
          yield* db
            .update(SessionOrchestrationTable)
            .set({ status, time_updated: now, time_completed: status === "running" ? null : now })
            .where(eq(SessionOrchestrationTable.id, admitted.id))
            .run()
            .pipe(Effect.orDie)
        })

        const evaluations: Evaluation[] = []
        let lastText: string | undefined
        let completed = false
        for (let attempt = 0; attempt < maxEvaluations; attempt++) {
          const resumed = yield* execution.resume(admitted.sessionID).pipe(
            Effect.catch((error) =>
              Effect.succeed(
                new RunFailedError({
                  sessionID: admitted.sessionID,
                  message: error instanceof Error ? error.message : String(error),
                }),
              ),
            ),
          )
          if (resumed instanceof RunFailedError) {
            yield* finish("incomplete")
            return yield* resumed
          }
          const outcome = yield* evaluate({ orchestrationID: admitted.id, sessionID: admitted.sessionID })
          lastText = outcome.text
          evaluations.push({
            seq: attempt + 1,
            verdict: outcome.complete ? "complete" : "incomplete",
            reason: outcome.complete ? undefined : "Completion marker missing from the last assistant message",
          })
          if (outcome.complete) {
            completed = true
            break
          }
          if (attempt + 1 < maxEvaluations) {
            yield* sessions.prompt({
              sessionID: admitted.sessionID,
              prompt: { text: FollowupPrompt(input.objective, evaluations.at(-1)?.reason) },
            })
          }
        }

        if (completed) {
          yield* finish("completed")
        } else {
          yield* finish("incomplete")
        }
        const info = toInfo({ ...row, status: completed ? "completed" : "incomplete" }, evaluations.length)
        if (!completed) {
          return yield* new IncompleteError({ sessionID: admitted.sessionID, evaluations: evaluations.length })
        }
        return { info, evaluations, lastAssistantText: lastText } satisfies Result
      }),
      status: Effect.fn("SessionOrchestrator.status")(function* (sessionID) {
        const row = yield* db
          .select()
          .from(SessionOrchestrationTable)
          .where(eq(SessionOrchestrationTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (row === undefined) return undefined
        return toInfo(row, yield* evaluationCount(row.id))
      }),
      list: Effect.fn("SessionOrchestrator.list")(function* (parentID) {
        const children = yield* sessions.children(parentID)
        if (children.length === 0) return []
        const childIDs = new Set(children.map((child) => child.id as string))
        const all = yield* db
          .select()
          .from(SessionOrchestrationTable)
          .all()
          .pipe(Effect.orDie)
        const matched = all.filter((row) => childIDs.has(row.session_id))
        return yield* Effect.forEach(matched, (row) =>
          Effect.map(evaluationCount(row.id), (count) => toInfo(row, count)),
        )
      }),
      evaluations: Effect.fn("SessionOrchestrator.evaluations")(function* (sessionID) {
        const row = yield* db
          .select()
          .from(SessionOrchestrationTable)
          .where(eq(SessionOrchestrationTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (row === undefined) return []
        const rows = yield* db
          .select()
          .from(SessionOrchestrationEvaluationTable)
          .where(eq(SessionOrchestrationEvaluationTable.orchestration_id, row.id))
          .orderBy(asc(SessionOrchestrationEvaluationTable.seq))
          .all()
          .pipe(Effect.orDie)
        return rows.map((entry) => ({
          seq: entry.seq,
          verdict: entry.verdict as "complete" | "incomplete",
          reason: entry.reason ?? undefined,
        }))
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, SessionV2.node, SessionExecution.node],
})

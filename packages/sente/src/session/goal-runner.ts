export * as SessionGoalRunner from "./goal-runner"

import type { Database } from "@sente-ai/core/database/database"
import type { BackgroundJob } from "@/background/job"
import type { SessionV1 } from "@sente-ai/core/v1/session"
import { ProviderV2 } from "@sente-ai/core/provider"
import { ModelV2 } from "@sente-ai/core/model"
import { MessageTable, SessionTable } from "@sente-ai/core/session/sql"
import { LLMEvent, Usage } from "@sente-ai/llm"
import { Cause, Effect, Exit, Option, Scope } from "effect"
import * as Stream from "effect/Stream"
import { eq, sql } from "drizzle-orm"
import type { Agent } from "../agent/agent"
import type { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ProviderQuota } from "@/provider/quota"
import { SessionGoal } from "./goal"
import { SessionEscalation } from "./escalation"
import type { LLM } from "./llm"
import { MessageID, PartID, SessionID } from "./schema"
import { Session } from "./session"
import type { Todo } from "./todo"
import type { Image } from "@/image/image"

/**
 * Drives `/goal` for the run loop in prompt.ts: reviews a finished turn, adds the next
 * one, holds the goal's budget between steps, and makes sure no goal is left "running"
 * with nothing behind it. prompt.ts only calls the hooks below; the goal's rules are in
 * goal.ts.
 */

type Lang = "ja" | "en"
type ModelRef = { providerID: ProviderV2.ID; modelID: ModelV2.ID }

export type CommandInput = {
  messageID?: MessageID
  sessionID: SessionID
  agent?: string
  model?: string
  arguments: string
  command: string
  variant?: string
  noReply?: boolean
  parts?: ReadonlyArray<{ type: "file"; mime: string; url: string; filename?: string; id?: PartID }>
}

export type PromptCall = {
  sessionID: SessionID
  messageID?: MessageID
  model: ModelRef
  agent?: string
  variant?: string
  noReply?: boolean
  parts: ReadonlyArray<Record<string, unknown> & { type: string }>
}

export type Deps = {
  sessions: Session.Interface
  llm: LLM.Interface
  agents: Agent.Interface
  provider: Provider.Interface
  config: Config.Interface
  todo: Todo.Interface
  background: BackgroundJob.Interface
  db: Database.Interface["db"]
  scope: Scope.Scope
  toast: (message: string, variant?: "info" | "success" | "warning" | "error") => Effect.Effect<void>
  /** Whether the session's loop is running right now. */
  isBusy: (sessionID: SessionID) => Effect.Effect<boolean>
  /** Stops the session's running loop (and its background jobs). */
  cancelRun: (sessionID: SessionID) => Effect.Effect<void>
  prompt: (input: PromptCall) => Effect.Effect<SessionV1.WithParts, Image.Error>
  currentModel: (sessionID: SessionID) => Effect.Effect<ModelRef>
  lastAssistant: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts>
  defaultAgent: () => Effect.Effect<string>
  executed: (input: CommandInput, messageID: MessageID) => Effect.Effect<void>
}

/** Spend shown under the prompt is written at most this often while a turn runs. */
const SPEND_WRITE_MS = 3_000

export const make = Effect.fn("SessionGoalRunner.make")(function* (deps: Deps) {
  const sessions = deps.sessions
  /*
   * In-memory state of this runner. All of it is per runner (no module state) and all of it
   * is empty again once a goal has ended and its runs have finished:
   *
   * - liveGoals: roots with an active goal. Added when a goal starts (command, or a run of a
   *   root that has one); removed when the goal settles, is cleared, or is found inactive.
   *   Sessions whose root is not here skip every goal check.
   * - rootOfRun: the root of each running subagent, so steps need not walk up the tree.
   *   Added at the subagent's run start (only while some goal exists); removed when that run
   *   ends.
   * - stoppedRoots: roots stopped at their budget -> the goal's start time. Subagents created
   *   since then stop at their next step (a backstop for runs stopTree could not interrupt).
   *   Kept while the root's run or any such subagent run or background job is still going,
   *   even after the root's own run ends; removed by the last of them to end (checked when
   *   the root's or a subagent's run ends), or when a new goal starts.
   * - budgetStopped: roots whose goal a subagent stopped while the root was running; the root
   *   writes the closing line at its next step or when its run ends. A root that is idle gets
   *   the line at once and never enters this set. Removed when the line is written, the goal
   *   settles, or a new goal starts.
   * - userCancelled: sessions the user is interrupting; lives only while the cancel runs, so
   *   the end-of-run hook can say "interrupted by the user".
   * - spendWritten: when the spend label was last written; removed when the goal settles.
   */
  let customNoticed = false
  const userCancelled = new Set<string>()
  const budgetStopped = new Set<string>()
  const stoppedRoots = new Map<string, number>()
  const liveGoals = new Set<string>()
  const rootOfRun = new Map<string, string>()
  const spendWritten = new Map<string, number>()

  /** Sizes of the in-memory state, for tests that check nothing is left behind. */
  const snapshot = () => ({
    userCancelled: userCancelled.size,
    budgetStopped: budgetStopped.size,
    stoppedRoots: stoppedRoots.size,
    liveGoals: liveGoals.size,
    rootOfRun: rootOfRun.size,
    spendWritten: spendWritten.size,
  })

  const lang = () => ProviderQuota.language()
  const readGoal = (sessionID: SessionID) =>
    sessions.get(sessionID).pipe(
      Effect.map((info) => SessionGoal.read(info.metadata)),
      Effect.orElseSucceed(() => undefined),
    )

  // Recorded cost of a session and every session below it (task subagents, background
  // subagents, theirs in turn), from the message rows alone: no parts are loaded.
  const tree = (sessionID: SessionID) =>
    sql`WITH RECURSIVE tree(id) AS (
          SELECT ${sessionID}
          UNION ALL SELECT ${SessionTable.id} FROM ${SessionTable} JOIN tree ON ${SessionTable.parent_id} = tree.id
        )`
  const treeCost = Effect.fn("SessionGoalRunner.treeCost")(function* (sessionID: SessionID) {
    const rows = yield* deps.db
      .all<{ cost: number | null }>(
        sql`${tree(sessionID)}
            SELECT COALESCE(SUM(json_extract(${MessageTable.data}, '$.cost')), 0) AS cost
            FROM ${MessageTable}
            WHERE ${MessageTable.session_id} IN (SELECT id FROM tree)
              AND json_extract(${MessageTable.data}, '$.role') = 'assistant'
              AND COALESCE(json_extract(${MessageTable.data}, '$.agent'), '') NOT IN (${sql.join(
                [...SessionEscalation.AUXILIARY_AGENTS].map((name) => sql`${name}`),
                sql`, `,
              )})`,
      )
      .pipe(Effect.orDie)
    return Number(rows[0]?.cost ?? 0)
  })

  // Every session below `sessionID` (not itself).
  // Sessions below `sessionID` created at or after `since` (the goal's start).
  const descendants = Effect.fn("SessionGoalRunner.descendants")(function* (sessionID: SessionID, since: number) {
    const rows = yield* deps.db
      .all<{ id: string }>(
        sql`${tree(sessionID)}
            SELECT tree.id AS id FROM tree JOIN ${SessionTable} ON ${SessionTable.id} = tree.id
            WHERE tree.id != ${sessionID} AND ${SessionTable.time_created} >= ${since}`,
      )
      .pipe(Effect.orDie)
    return rows.map((row) => SessionID.make(row.id))
  })

  // A goal stopped at its budget stops what it started: subagent sessions created since the
  // goal began (parallel and background) and background jobs started since then. Work that
  // was already running before the goal, or another session the user opened, is left alone.
  // `keep` is the session asking (and its ancestors), which stop on their own.
  const stopTree = Effect.fn("SessionGoalRunner.stopTree")(function* (
    root: SessionID,
    since: number,
    keep: ReadonlySet<string>,
  ) {
    stoppedRoots.set(root, since)
    const below = yield* descendants(root, since)
    const ids = new Set<string>([root, ...below])
    yield* Effect.forEach(
      below.filter((id) => !keep.has(id)),
      (id) => deps.cancelRun(id).pipe(Effect.ignore),
      { concurrency: "unbounded", discard: true },
    )
    const jobs = yield* deps.background.list()
    yield* Effect.forEach(
      jobs.filter(
        (job) =>
          job.status === "running" &&
          job.started_at >= since &&
          !keep.has(job.id) &&
          (ids.has(String(job.metadata?.parentSessionId)) || ids.has(String(job.metadata?.sessionId))),
      ),
      (job) => deps.background.cancel(job.id).pipe(Effect.ignore),
      { concurrency: "unbounded", discard: true },
    )
  })

  // Drop a root's budget backstop once nothing the goal started is still running: no
  // subagent run under it and no background job begun since the goal started.
  // While the root's own run goes on it may still launch a subagent (a parallel task call in
  // the step that hit the budget), so the backstop stays until that run ends too.
  const releaseStopped = Effect.fn("SessionGoalRunner.releaseStopped")(function* (root: string, rootEnded: boolean) {
    const since = stoppedRoots.get(root)
    if (since === undefined) return
    if ([...rootOfRun.values()].includes(root)) return
    if (!rootEnded && (yield* deps.isBusy(SessionID.make(root)))) return
    const below = new Set<string>([root, ...(yield* descendants(SessionID.make(root), since))])
    const jobs = yield* deps.background.list()
    const running = jobs.some(
      (job) =>
        job.status === "running" &&
        job.started_at >= since &&
        (below.has(String(job.metadata?.parentSessionId)) || below.has(String(job.metadata?.sessionId))),
    )
    if (!running) stoppedRoots.delete(root)
  })

  // USD the goal has used: turn cost of the session tree since the goal started, plus reviews.
  const spentOf = Effect.fn("SessionGoalRunner.spentOf")(function* (sessionID: SessionID, goal: SessionGoal.State) {
    return Math.max(0, (yield* treeCost(sessionID)) - goal.baseCost) + goal.judgeCost
  })

  // Write the goal only if it is still the one the caller decided on and still active. A
  // `/goal clear` or a new goal that landed meanwhile wins instead of being overwritten.
  const replace = Effect.fn("SessionGoalRunner.replace")(function* (
    sessionID: SessionID,
    expected: SessionGoal.State,
    next: SessionGoal.State,
  ) {
    const info = yield* sessions.get(sessionID).pipe(Effect.orDie)
    const current = SessionGoal.read(info.metadata)
    if (current?.id !== expected.id || current.status !== "active") return false
    yield* sessions.setMetadata({ sessionID, metadata: SessionGoal.withGoal(info.metadata, next) })
    return true
  })

  // The visible line a settled goal leaves on the last assistant message. The model never
  // sees it again (toModelMessages drops it).
  const note = Effect.fn("SessionGoalRunner.note")(function* (sessionID: SessionID, goal: SessionGoal.State) {
    const last = yield* sessions
      .findMessage(sessionID, (message) => message.info.role === "assistant")
      .pipe(Effect.orElseSucceed(() => Option.none<SessionV1.WithParts>()))
    if (Option.isNone(last)) return
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: last.value.info.id,
      sessionID,
      type: "text",
      text: SessionGoal.settledNote(goal),
      metadata: SessionGoal.settledMetadata(goal),
      time: { start: Date.now(), end: Date.now() },
    })
  })

  // End an active goal: record why and what it cost. `latest` carries review costs not
  // written yet and must be the same goal.
  const settle = Effect.fn("SessionGoalRunner.settle")(function* (
    sessionID: SessionID,
    end: { status: "paused" | "complete"; reason: string; note?: boolean },
    latest?: SessionGoal.State,
  ) {
    const goal = yield* readGoal(sessionID)
    if (goal?.status !== "active") return
    if (latest && latest.id !== goal.id) return
    const base = latest ?? goal
    const { waitingSince: _, ...rest } = base
    const next: SessionGoal.State = {
      ...rest,
      status: end.status,
      reason: end.reason,
      spent: yield* spentOf(sessionID, base),
      updatedAt: Date.now(),
    }
    if (!(yield* replace(sessionID, goal, next))) return
    spendWritten.delete(sessionID)
    liveGoals.delete(sessionID)
    // The pending-line marker belongs to the goal that just ended; never let it stop a later run.
    if (end.note !== false) {
      budgetStopped.delete(sessionID)
      yield* note(sessionID, next)
    }
    yield* Effect.logInfo("goal settled", { "session.id": sessionID, status: end.status, reason: end.reason })
  })

  // The reviewer: the hidden `goal` agent's own model when configured, else the small model.
  // Never the conversation's model by default.
  const judgeModel = Effect.fn("SessionGoalRunner.judgeModel")(function* (providerID: ProviderV2.ID) {
    const ag = yield* deps.agents.get("goal")
    if (!ag) return undefined
    if (ag.model)
      return yield* deps.provider
        .getModel(ag.model.providerID, ag.model.modelID)
        .pipe(Effect.orElseSucceed(() => undefined))
    return yield* deps.provider.getSmallModel(providerID)
  })

  const noJudgeModel = Effect.fn("SessionGoalRunner.noJudgeModel")(function* (language: Lang) {
    const configured = (yield* deps.config.get()).small_model
    const which = configured
      ? language === "ja"
        ? `設定の small_model「${configured}」が使えません。`
        : `The configured small_model "${configured}" is not available.`
      : language === "ja"
        ? "完了判定に使う小型モデルが設定されていません。"
        : "No small model is configured for the goal reviewer."
    return language === "ja"
      ? `${which}使えるモデルを small_model か agent.goal.model に指定してください（会話のモデルで黙って判定はしません）。`
      : `${which} Set an available model as small_model or agent.goal.model (the conversation's model is not used silently).`
  })

  // Ask the reviewer whether the goal is met. At most two requests: no transport retries,
  // and one more try only when the first gives no usable verdict.
  const judge = Effect.fn("SessionGoalRunner.judge")(function* (input: {
    goal: SessionGoal.State
    sessionID: SessionID
    user: SessionV1.User
    messages: SessionV1.WithParts[]
  }) {
    const ag = yield* deps.agents.get("goal")
    const mdl = yield* judgeModel(input.user.model.providerID)
    if (!ag || !mdl) return { verdict: undefined, cost: 0, missing: true }
    const work = SessionGoal.transcript(input.messages, input.goal, yield* deps.todo.get(input.sessionID))
    const ask = Effect.gen(function* () {
      const acc = { text: "", cost: 0, steps: 0, finish: 0 }
      const cost = (event: { usage?: Usage; providerMetadata?: unknown }) =>
        Session.getUsage({
          model: mdl,
          usage: event.usage ?? new Usage({}),
          metadata: event.providerMetadata as Parameters<typeof Session.getUsage>[0]["metadata"],
        }).cost
      yield* deps.llm
        .stream({
          agent: ag,
          user: input.user,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.sessionID,
          retries: 0,
          messages: [{ role: "user", content: SessionGoal.judgePrompt(input.goal, work) }],
        })
        .pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (LLMEvent.is.textDelta(event)) acc.text += event.text
              if (LLMEvent.is.stepFinish(event)) {
                acc.steps++
                acc.cost += cost(event)
              }
              if (LLMEvent.is.finish(event)) acc.finish = cost(event)
            }),
          ),
        )
      return { verdict: SessionGoal.parseVerdict(acc.text), cost: acc.steps > 0 ? acc.cost : acc.finish }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("goal review failed", { "session.id": input.sessionID, cause: Cause.pretty(cause) }).pipe(
              Effect.as({ verdict: undefined, cost: 0 }),
            ),
      ),
    )
    const first = yield* ask
    if (first.verdict) return { ...first, missing: false }
    const second = yield* ask
    return { verdict: second.verdict, cost: first.cost + second.cost, missing: false }
  })

  // Background jobs (background subagents, shells) started from this session that still run.
  const backgroundRunning = Effect.fn("SessionGoalRunner.backgroundRunning")(function* (sessionID: SessionID) {
    const jobs = yield* deps.background.list()
    return jobs.some(
      (job) =>
        job.status === "running" &&
        (job.metadata?.parentSessionId === sessionID || job.metadata?.sessionId === sessionID),
    )
  })

  const restartReason = () =>
    lang() === "ja"
      ? "Sente の終了・再起動で停止しました。/goal resume で再開できます。"
      : "Stopped when Sente exited or restarted. /goal resume continues it."

  /**
   * At the start of a run. A goal an exited or restarted process left active is stopped,
   * never resumed silently. Records which goal, if any, the run works under.
   */
  const onStart = Effect.fn("SessionGoalRunner.onStart")(function* (session: Session.Info) {
    if (session.parentID) {
      // No goal anywhere in this runner: skip walking up to the root.
      if (liveGoals.size === 0 && stoppedRoots.size === 0) return
      const root = yield* rootOf(session)
      rootOfRun.set(session.id, root.id)
      if (SessionGoal.read(root.metadata)?.status === "active") liveGoals.add(root.id)
      return
    }
    if (budgetStopped.delete(session.id)) {
      const stopped = SessionGoal.read(session.metadata)
      if (stopped) yield* note(session.id, stopped)
    }
    const goal = SessionGoal.read(session.metadata)
    if (goal && SessionGoal.orphaned(goal)) yield* settle(session.id, { status: "paused", reason: restartReason() })
    else if (goal?.status === "active") liveGoals.add(session.id)
  })

  const rootOf = Effect.fn("SessionGoalRunner.rootOf")(function* (session: Session.Info) {
    let current = session
    for (let depth = 0; current.parentID && depth < 16; depth++) {
      const parent = yield* sessions.get(current.parentID).pipe(Effect.option)
      if (Option.isNone(parent)) break
      current = parent.value
    }
    return current
  })

  /**
   * Before each step. The goal's budget holds between steps too, whatever the permission
   * rules allow (request_cost: allow, --auto), and in subagent sessions below the goal, so a
   * long turn or a delegated task cannot run past it. Returns true to stop the loop.
   */
  const beforeStep = Effect.fn("SessionGoalRunner.beforeStep")(function* (session: Session.Info) {
    if (budgetStopped.delete(session.id)) {
      // A subagent below stopped this goal at its budget; the line goes here, between steps.
      const goal = yield* readGoal(session.id)
      if (goal) yield* note(session.id, goal)
      return true
    }
    const rootID = session.parentID ? rootOfRun.get(session.id) : session.id
    if (!rootID) return false
    // A subagent below a goal that stopped at its budget stops too.
    const stoppedSince = stoppedRoots.get(rootID)
    if (session.parentID && stoppedSince !== undefined && session.time.created >= stoppedSince) return true
    if (!liveGoals.has(rootID)) return false
    const root = SessionID.make(rootID)
    const goal = yield* readGoal(root)
    if (goal?.status !== "active") {
      liveGoals.delete(rootID)
      return false
    }
    // A step means the root is awake again: it is no longer waiting on background work.
    const awake =
      goal.waitingSince !== undefined && !session.parentID
        ? (() => {
            const { waitingSince: _, ...rest } = goal
            return rest as SessionGoal.State
          })()
        : goal
    const spent = yield* spentOf(root, awake)
    const current = { ...awake, spent }
    if (SessionGoal.overBudget(current)) {
      const reason = SessionGoal.budgetReason(current)
      if (session.parentID) {
        // The root writes its closing line between its own steps; an idle root gets it now.
        const busy = yield* deps.isBusy(root)
        yield* settle(root, { status: "paused", reason, note: !busy }, current)
        if (busy) budgetStopped.add(rootID)
        const keep = new Set<string>([session.id])
        for (let at: Session.Info | undefined = session; at?.parentID; ) {
          keep.add(at.parentID)
          at = yield* sessions.get(at.parentID).pipe(Effect.orElseSucceed(() => undefined))
        }
        yield* stopTree(root, SessionGoal.startedAt(current), keep)
      } else {
        yield* settle(root, { status: "paused", reason }, current)
        yield* stopTree(root, SessionGoal.startedAt(current), new Set([rootID]))
      }
      return true
    }
    // Keep the label under the prompt current, without a write on every step.
    const last = spendWritten.get(rootID) ?? 0
    if (awake !== goal || (Math.abs(spent - goal.spent) >= 0.0001 && Date.now() - last >= SPEND_WRITE_MS)) {
      if (yield* replace(root, goal, current)) spendWritten.set(rootID, Date.now())
    }
    return false
  })

  /**
   * After a finished turn. "none": no active goal, the caller goes on (todo follow-up).
   * "continue": run the loop again (a continuation, or new input to answer). "break": stop.
   */
  const afterTurn = Effect.fn("SessionGoalRunner.afterTurn")(function* (input: {
    session: Session.Info
    lastUser: SessionV1.User
    messages: SessionV1.WithParts[]
    orphan: boolean
  }) {
    if (input.session.parentID) return "none" as const
    const sessionID = input.session.id
    if (budgetStopped.delete(sessionID)) {
      const stopped = yield* readGoal(sessionID)
      if (stopped) yield* note(sessionID, stopped)
      return "break" as const
    }
    if (!liveGoals.has(sessionID)) return "none" as const
    const goal = yield* readGoal(sessionID)
    if (goal?.status !== "active") return "none" as const
    // A turn left with an interrupted tool ends the goal (the loop exits and afterLoop stops
    // it); it never falls through to the todo follow-up.
    if (input.orphan) return "break" as const
    const language = lang()
    const interjection =
      language === "ja" ? "利用者の入力があったため一時停止しました。" : "Paused because the user sent a message."
    // The user typed while the goal ran and this turn answered them: they took over.
    if (SessionGoal.interjected(input.messages.find((message) => message.info.id === input.lastUser.id)?.parts ?? [])) {
      yield* settle(sessionID, { status: "paused", reason: interjection })
      return "break" as const
    }
    // A turn that only started background work does not count as a round. The job's result
    // wakes the session; if it never comes, the goal stops after the wait limit.
    if (yield* backgroundRunning(sessionID)) {
      const since = goal.waitingSince ?? Date.now()
      const limit = SessionGoal.waitLimit()
      const waitReason =
        language === "ja"
          ? `バックグラウンド作業の結果を${Math.round(limit / 60_000)}分待っても届かなかったため停止しました。`
          : `Stopped: background work did not report within ${Math.round(limit / 60_000)} minutes.`
      if (Date.now() - since >= limit) {
        yield* settle(sessionID, { status: "paused", reason: waitReason })
        return "break" as const
      }
      if (goal.waitingSince === undefined) {
        const waiting = { ...goal, waitingSince: since }
        if (yield* replace(sessionID, goal, waiting))
          yield* Effect.sleep(`${limit} millis`).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const now = yield* readGoal(sessionID)
                if (now?.id === waiting.id && now.status === "active" && now.waitingSince === since)
                  yield* settle(sessionID, { status: "paused", reason: waitReason })
              }),
            ),
            Effect.ignore,
            Effect.forkIn(deps.scope),
          )
      }
      return "break" as const
    }
    const { waitingSince: _, ...rest } = goal
    const current = { ...rest, spent: yield* spentOf(sessionID, goal) }
    if (SessionGoal.overBudget(current)) {
      yield* settle(sessionID, { status: "paused", reason: SessionGoal.budgetReason(current, language) }, current)
      yield* stopTree(sessionID, SessionGoal.startedAt(current), new Set([String(sessionID)]))
      return "break" as const
    }
    const judged = yield* judge({ goal: current, sessionID, user: input.lastUser, messages: input.messages })
    if (judged.missing) {
      yield* settle(sessionID, { status: "paused", reason: yield* noJudgeModel(language) }, current)
      return "break" as const
    }
    const reviewed = { ...current, judgeCost: current.judgeCost + judged.cost, spent: current.spent + judged.cost }
    // The reviewer took a while: the user may have typed, cleared the goal or set a new one.
    const latest = yield* readGoal(sessionID)
    const newest = yield* sessions
      .findMessage(sessionID, (message) => message.info.role === "user")
      .pipe(Effect.orElseSucceed(() => Option.none<SessionV1.WithParts>()))
    const newer = Option.isSome(newest) && newest.value.info.id !== input.lastUser.id ? newest.value : undefined
    if (latest?.id !== goal.id || latest.status !== "active") return newer ? ("continue" as const) : ("break" as const)
    if (newer) {
      if (SessionGoal.interjected(newer.parts))
        yield* settle(sessionID, { status: "paused", reason: interjection }, reviewed)
      else yield* replace(sessionID, goal, reviewed)
      return "continue" as const
    }
    const decision = SessionGoal.decide(reviewed, judged.verdict, Date.now(), language)
    yield* Effect.logInfo("goal review", {
      "session.id": sessionID,
      decision: decision.type,
      round: reviewed.rounds,
      reason: decision.reason,
    })
    if (decision.type !== "continue") {
      // Met, but the review that said so pushed spend past the budget: say so in the line.
      const reason =
        decision.type === "complete" && SessionGoal.overBudget(reviewed)
          ? `${decision.reason} ${SessionGoal.judgeOverrunNote(reviewed, language)}`
          : decision.reason
      yield* settle(sessionID, { status: decision.type === "complete" ? "complete" : "paused", reason }, reviewed)
      return "break" as const
    }
    if (!(yield* replace(sessionID, goal, decision.goal))) return "break" as const
    const goalMsg: SessionV1.User = {
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      time: { created: Date.now() },
      agent: input.lastUser.agent,
      model: input.lastUser.model,
    }
    yield* sessions.updateMessage(goalMsg)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: goalMsg.id,
      sessionID,
      type: "text",
      synthetic: true,
      text: SessionGoal.continuation(decision.goal, decision.reason, decision.next, language),
      metadata: { source: SessionGoal.METADATA_KEY, goalID: goal.id },
      time: { start: Date.now(), end: Date.now() },
    })
    return "continue" as const
  })

  /** Re-states an active goal after compaction dropped its kickoff (see SessionGoal.withReminder). */
  const modelMessages = Effect.fn("SessionGoalRunner.modelMessages")(function* <T extends { role: string }>(
    session: Session.Info,
    modelMsgs: T[],
    history: SessionV1.WithParts[],
    make: (text: string) => T,
  ) {
    if (session.parentID) return modelMsgs
    return SessionGoal.withReminder(modelMsgs, yield* readGoal(session.id), history, make)
  })

  /**
   * However the loop ends (error, refused approval, interrupt, a defect), an active goal
   * must not stay "running" with nothing driving it. A goal waiting on background work stays
   * active: the job's result wakes the session.
   */
  const afterLoop = (sessionID: SessionID, exit: Exit.Exit<unknown, unknown>) =>
    Effect.gen(function* () {
      const cancelled = userCancelled.delete(sessionID)
      const root = rootOfRun.get(sessionID)
      rootOfRun.delete(sessionID)
      yield* releaseStopped(root ?? sessionID, root === undefined)
      if (budgetStopped.delete(sessionID)) {
        const stopped = yield* readGoal(sessionID)
        if (stopped) yield* note(sessionID, stopped)
      }
      const goal = yield* readGoal(sessionID)
      if (goal?.status !== "active" || goal.waitingSince !== undefined) return
      const ja = lang() === "ja"
      const reason = cancelled
        ? ja
          ? "利用者が中断しました。"
          : "Interrupted by the user."
        : Exit.isSuccess(exit)
          ? ja
            ? "ターンがエラー・承認拒否などで途中終了したため停止しました。"
            : "Stopped because the turn ended early (an error or a refused approval)."
          : Cause.hasInterruptsOnly(exit.cause)
            ? ja
              ? "実行が中断されたため停止しました。"
              : "Stopped because the run was interrupted."
            : ja
              ? "エラーで停止しました。"
              : "Stopped after an error."
      yield* settle(sessionID, { status: "paused", reason })
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("failed to stop goal", { cause: Cause.pretty(cause) })))

  /**
   * The user interrupts: stop the run first, then end the goal, so its closing line lands
   * after the interrupted message instead of inside it.
   */
  const cancel = Effect.fn("SessionGoalRunner.cancel")(function* (sessionID: SessionID) {
    userCancelled.add(sessionID)
    yield* deps.cancelRun(sessionID)
    userCancelled.delete(sessionID)
    yield* settle(sessionID, {
      status: "paused",
      reason: lang() === "ja" ? "利用者が中断しました。" : "Interrupted by the user.",
    })
  })

  // What a command returns when it starts no turn: the latest message, or an empty
  // placeholder for a session with no messages yet.
  const currentMessage = Effect.fn("SessionGoalRunner.currentMessage")(function* (input: CommandInput) {
    const msgs = yield* sessions.messages({ sessionID: input.sessionID, limit: 1 }).pipe(Effect.orDie)
    if (msgs.length > 0) return yield* deps.lastAssistant(input.sessionID)
    const model = input.model ? Provider.parseModel(input.model) : yield* deps.currentModel(input.sessionID)
    const placeholder: SessionV1.WithParts = {
      info: {
        id: MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        agent: input.agent ?? (yield* deps.defaultAgent()),
        model: { providerID: model.providerID, modelID: model.modelID },
      },
      parts: [],
    }
    return placeholder
  })

  /**
   * `/goal …` from any client. Returns undefined when a user's own `goal` command should run
   * as a normal template instead (the default when one exists: its text may forbid automatic
   * continuation). `--loop` (sent by `sente run --goal`) or SENTE_GOAL_LOOP=1 picks the
   * built-in loop, without the custom text.
   */
  const command = Effect.fn("SessionGoalRunner.command")(function* (input: CommandInput) {
    const language = lang()
    const parsed = SessionGoal.parse(input.arguments, language)
    const custom = Boolean((yield* deps.config.get()).command?.goal)
    const info = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    const current = SessionGoal.read(info.metadata)
    const forced = (parsed.type === "set" || parsed.type === "resume") && parsed.loop === true
    // A built-in goal already on the session (started by `sente run --goal` or `/goal --loop`)
    // is always shown, cleared and resumed here, whatever the user's own command does.
    const ownsGoal = current !== undefined && parsed.type !== "set"
    if (!forced && !ownsGoal && !SessionGoal.useLoop(custom)) {
      if (custom && !customNoticed) {
        customNoticed = true
        yield* deps.toast(SessionGoal.customNotice(language))
      }
      return undefined
    }
    // Show, clear and invalid input answer with a notice, not an error event.
    if (parsed.type === "invalid") {
      yield* deps.toast(parsed.reason, "warning")
      return yield* currentMessage(input)
    }
    if (parsed.type === "show") {
      yield* deps.toast(SessionGoal.describe(current, language))
      return yield* currentMessage(input)
    }
    if (parsed.type === "clear") {
      if (current) {
        const fresh = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
        yield* sessions.setMetadata({
          sessionID: input.sessionID,
          metadata: SessionGoal.withGoal(fresh.metadata, undefined),
        })
        liveGoals.delete(input.sessionID)
        // Clearing a running goal also stops the turn it is in.
        yield* deps.cancelRun(input.sessionID)
      }
      yield* deps.toast(
        current
          ? language === "ja"
            ? "ゴールを解除しました"
            : "Goal cleared"
          : SessionGoal.describe(undefined, language),
      )
      return yield* currentMessage(input)
    }
    // The run loop never drives a subagent's goal, so one set there would stay "running".
    if (info.parentID) {
      yield* deps.toast(
        language === "ja"
          ? "サブエージェントの会話ではゴールを設定できません。"
          : "A goal cannot be set in a subagent session.",
        "warning",
      )
      return yield* currentMessage(input)
    }
    if (parsed.type === "resume" && current?.status !== "paused") {
      yield* deps.toast(
        language === "ja" ? "再開できる停止中のゴールはありません。" : "No paused goal to resume.",
        "warning",
      )
      return yield* currentMessage(input)
    }

    const model = input.model ? Provider.parseModel(input.model) : yield* deps.currentModel(input.sessionID)
    const baseCost = yield* treeCost(input.sessionID)
    // A $0 model never adds spend: say that only the round limit will stop the goal.
    const priced = yield* deps.provider.getModel(model.providerID, model.modelID).pipe(Effect.option)
    const free =
      Option.isSome(priced) && priced.value.cost.input === 0 && priced.value.cost.output === 0
        ? SessionGoal.freeModelNote(language)
        : undefined
    const fresh: SessionGoal.State =
      parsed.type === "resume" && current
        ? (() => {
            const { waitingSince: _, reason: __, note: ___, ...rest } = current
            return {
              ...rest,
              status: "active" as const,
              rounds: 0,
              repeats: 0,
              startedAt: Date.now(),
              baseCost,
              judgeCost: 0,
              spent: 0,
              owner: { pid: process.pid, boot: SessionGoal.boot() },
              updatedAt: Date.now(),
              ...(free ? { note: free } : {}),
            }
          })()
        : {
            ...SessionGoal.create({
              objective: parsed.type === "set" ? parsed.objective : "",
              budget: parsed.type === "set" ? parsed.budget : undefined,
              maxRounds: parsed.type === "set" ? parsed.maxRounds : undefined,
              baseCost,
            }),
            ...(free ? { note: free } : {}),
          }
    // No small model for the reviewer: keep the goal (so /goal shows why) but do not start.
    const blocked = (yield* judgeModel(model.providerID)) ? undefined : yield* noJudgeModel(language)
    // A noReply prompt starts no loop; an active goal would sit there "running".
    const waiting =
      input.noReply === true
        ? language === "ja"
          ? "まだ開始していません。/goal resume で開始します。"
          : "Not started yet. /goal resume starts it."
        : undefined
    const stopped = blocked ?? waiting
    const goal: SessionGoal.State = stopped ? { ...fresh, status: "paused", reason: stopped } : fresh
    yield* sessions.setMetadata({ sessionID: input.sessionID, metadata: SessionGoal.withGoal(info.metadata, goal) })
    // A new goal starts clean: no budget stop or pending line from an earlier one applies.
    budgetStopped.delete(input.sessionID)
    stoppedRoots.delete(input.sessionID)
    if (goal.status === "active") liveGoals.add(input.sessionID)
    if (blocked) {
      yield* deps.toast(blocked, "warning")
      return yield* currentMessage(input)
    }
    if (free) yield* deps.toast(free, "warning")
    const parts =
      parsed.type === "resume"
        ? [
            {
              type: "text" as const,
              text: language === "ja" ? `ゴールを再開: ${goal.objective}` : `Goal resumed: ${goal.objective}`,
              metadata: { source: SessionGoal.METADATA_KEY, goalID: goal.id },
            },
            ...SessionGoal.kickoff(goal, language).slice(1),
          ]
        : SessionGoal.kickoff(goal, language)
    const result = yield* deps.prompt({
      sessionID: input.sessionID,
      messageID: input.messageID,
      model,
      agent: input.agent,
      variant: input.variant,
      noReply: input.noReply,
      parts: [...parts, ...(input.parts ?? [])],
    })
    yield* deps.executed(input, result.info.id)
    return result
  })

  // Goals a process left active when it exited or restarted are shown as stopped, not
  // running. Goals of another live process (a TUI next to a `sente run`) are left alone.
  yield* Effect.gen(function* () {
    const rows = yield* deps.db
      .select({ id: SessionTable.id, metadata: SessionTable.metadata })
      .from(SessionTable)
      .where(sql`json_extract(${SessionTable.metadata}, '$.goal.status') = 'active'`)
      .all()
      .pipe(Effect.orDie)
    for (const row of rows) {
      const goal = SessionGoal.read(row.metadata ?? undefined)
      if (!goal || !SessionGoal.orphaned(goal)) continue
      const { waitingSince: _, ...rest } = goal
      const metadata = SessionGoal.withGoal(row.metadata ?? undefined, {
        ...rest,
        status: "paused",
        reason: restartReason(),
        updatedAt: Date.now(),
      })
      yield* sessions
        .setMetadata({ sessionID: SessionID.make(row.id), metadata })
        .pipe(
          Effect.catchCause(() =>
            deps.db.update(SessionTable).set({ metadata }).where(eq(SessionTable.id, row.id)).run().pipe(Effect.ignore),
          ),
        )
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("failed to stop goals left by an earlier process", { cause: Cause.pretty(cause) }),
    ),
    Effect.forkIn(deps.scope),
  )

  return { onStart, beforeStep, afterTurn, modelMessages, afterLoop, cancel, command, snapshotForTest: snapshot }
})

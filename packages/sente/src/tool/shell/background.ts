import os from "node:os"

// Shared state for shell commands that outlived their timeout and now run as background jobs.
// Kept dependency-free so `sente run` can import the session marker cheaply.

/**
 * Session metadata key under which each `sente run --attach` driving the session holds a lease,
 * keyed by its run ID: `{ [runID]: Lease }` (a local run is recognised by SENTE_NONINTERACTIVE
 * instead). A lease names the user message the run sent, so only that run's turn counts as one-shot
 * (a TUI turn in the same session stays interactive). It is renewed while the run lives, so a run that
 * died without removing it stops counting soon after.
 */
export const ONE_SHOT = "sente.oneShot"
export const LEASE_MS = 3 * 60 * 1000
export const RENEW_MS = 60 * 1000

export const DEFAULT_MAX_MS = 60 * 60 * 1000
export const DEFAULT_MAX_JOBS = 4

type SessionLike = { parentID?: string; metadata?: Record<string, unknown> }

export type Lease = { message: string; pid: number; host: string; until: number }

export function lease(message: string, now = Date.now()): Lease {
  return { message, pid: process.pid, host: os.hostname(), until: now + LEASE_MS }
}

/** The leases of a session, by run ID (anything malformed is ignored). */
export function leases(session: SessionLike | undefined): Record<string, unknown> {
  const value = session?.metadata?.[ONE_SHOT]
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/** The run whose live lease names this turn's user message, if any. */
export function turnRun(session: SessionLike | undefined, message: string | undefined, now = Date.now()) {
  if (!message) return undefined
  return Object.entries(leases(session)).find(
    ([, entry]) => (entry as Partial<Lease> | undefined)?.message === message && live(entry, now),
  )?.[0]
}

type MessageLike = { info: { id: string; role: string }; parts: { type: string; synthetic?: boolean }[] }

/**
 * A user message the server added on its own: a continuation after the output limit, a todo
 * follow-up, a compaction marker or its "continue" prompt, a background notification. Its turn still
 * belongs to the message a person (or `sente run`) sent before it.
 */
export function automatic(message: MessageLike) {
  return (
    message.parts.length > 0 &&
    message.parts.every((part) => part.type === "compaction" || (part.type === "text" && part.synthetic === true))
  )
}

/** The user message the current turn answers: the latest one that was not added by the server. */
export function turnOrigin(messages: readonly MessageLike[]) {
  return messages.findLast((message) => message.info.role === "user" && !automatic(message))?.info.id
}

/**
 * Nobody will read a follow-up turn: a one-shot `sente run` turn (it ends, and stops the command, when
 * the reply ends) or a subagent (its parent only sees its final reply). The model has to wait in-turn.
 */
export function mustWait(
  session: SessionLike | undefined,
  message: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
) {
  if (env.SENTE_NONINTERACTIVE === "1") return true
  if (!session) return false
  if (session.parentID) return true
  return turnRun(session, message, now) !== undefined
}

/** A lease counts until it expires, or until its run is seen to be gone on this same machine. */
export function live(value: unknown, now = Date.now()) {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<Lease>
  if (typeof item.until !== "number" || item.until <= now) return false
  if (item.host !== os.hostname() || typeof item.pid !== "number") return true
  try {
    process.kill(item.pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const waiting = new Map<string, number>()
const announcing = new Set<string>()
const collected = new Set<string>()

/** A completion announcement is pending for this job (interactive sessions only). */
export function expectAnnouncement(id: string) {
  announcing.add(id)
}

/** The wait tool is blocking on this job; its result reaches the model through that call. */
export function beginWait(id: string) {
  waiting.set(id, (waiting.get(id) ?? 0) + 1)
}

/** Called in one step with the outcome, so a finishing job is always seen as waited-on or collected. */
export function endWait(id: string, finished: boolean) {
  // Only remembered while an announcement is still undecided; afterwards nothing reads it.
  if (finished && announcing.has(id)) collected.add(id)
  const count = (waiting.get(id) ?? 1) - 1
  if (count > 0) waiting.set(id, count)
  else waiting.delete(id)
}

/**
 * Decides, once, whether the finished job is announced: not if a wait call delivered (or is
 * delivering) its result. Clears what was kept for the decision.
 */
export function takeAnnouncement(id: string) {
  const announce = announcing.has(id) && !collected.has(id) && !waiting.has(id)
  announcing.delete(id)
  collected.delete(id)
  return announce
}

export * as ShellBackground from "./background"

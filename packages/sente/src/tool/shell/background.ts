// Shared state for shell commands that outlived their timeout and now run as background jobs.
// Kept dependency-free so `sente run` can import the session marker cheaply.

/** Session metadata key set by `sente run` (also over --attach) while a one-shot run drives the session. */
export const ONE_SHOT = "sente.oneShot"

export const DEFAULT_MAX_MS = 60 * 60 * 1000
export const DEFAULT_MAX_JOBS = 4

type SessionLike = { parentID?: string; metadata?: Record<string, unknown> }

/**
 * Nobody will read a follow-up turn: a one-shot `sente run` (it ends, and stops the command, when the
 * reply ends) or a subagent (its parent only sees its final reply). The model has to wait in-turn.
 */
export function mustWait(session: SessionLike | undefined, env: NodeJS.ProcessEnv = process.env) {
  if (env.SENTE_NONINTERACTIVE === "1") return true
  if (!session) return false
  return Boolean(session.parentID) || session.metadata?.[ONE_SHOT] === true
}

const waiting = new Map<string, number>()
const collected = new Set<string>()

/** The wait tool is blocking on this job; its result reaches the model through that call. */
export function beginWait(id: string) {
  waiting.set(id, (waiting.get(id) ?? 0) + 1)
}

/** Called in one step with the outcome, so a finishing job is always seen as waited-on or collected. */
export function endWait(id: string, finished: boolean) {
  if (finished) collected.add(id)
  const count = (waiting.get(id) ?? 1) - 1
  if (count > 0) waiting.set(id, count)
  else waiting.delete(id)
}

/** A finished job is announced only if no wait call delivered (or is delivering) its result. */
export function shouldNotify(id: string) {
  return !collected.has(id) && !waiting.has(id)
}

export * as ShellBackground from "./background"

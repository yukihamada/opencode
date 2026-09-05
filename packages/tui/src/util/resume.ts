import type { Message, Part, Session } from "@sente-ai/sdk/v2"
import type { useSDK } from "../context/sdk"

/**
 * "Pick up where we left off" helpers shared by the home screen (startup
 * dialog), `--resume`, and the /resume-work command.
 */
export namespace Resume {
  /** Only offer to resume sessions touched within this window. */
  export const WINDOW_MS = 48 * 60 * 60 * 1000

  /** Matches `SessionDegrade.REF_PREFIX` on the server (UnknownError.data.ref). */
  export const DEGRADED_REF_PREFIX = "sente.degraded"

  export type Kind = "unanswered" | "unfinished" | "errored" | "aborted"

  export type State = {
    kind: Kind
    /** Timestamp (ms) of the message that was cut off. */
    at: number
  }

  /** Sent as a user turn so the model resumes from the actual file state, not from memory. */
  export const PROMPT = [
    "The previous turn was interrupted before it finished (the process stopped, timed out, or hit an error).",
    "Resume the work from where it stopped:",
    "1. Re-check the current state of the files and tools involved before acting; do not assume earlier edits landed.",
    "2. Do not redo steps that are already complete.",
    "3. Continue until the original request is done, then summarize what was already done, what you did now, and anything left.",
    "If the original request is unclear or already complete, say so briefly instead of guessing.",
  ].join("\n")

  type WithParts = { info: Message; parts: Part[] }

  /** Newest root session in the loaded list, if it was updated recently enough. */
  export function latestRoot(sessions: Session[], now = Date.now()): Session | undefined {
    const latest = sessions
      .filter((s) => s.parentID === undefined)
      .toSorted((a, b) => b.time.updated - a.time.updated)[0]
    if (!latest) return undefined
    if (now - latest.time.updated > WINDOW_MS) return undefined
    return latest
  }

  /**
   * Decide whether the last turn of a session was cut off. `messages` may be in
   * any order; the newest message by creation time is inspected.
   */
  export function interrupted(messages: WithParts[]): State | undefined {
    const last = messages.toSorted((a, b) => a.info.time.created - b.info.time.created).at(-1)
    if (!last) return undefined
    const info = last.info
    if (info.role === "user") {
      // A prompt that never got a reply (process died before the loop ran).
      return { kind: "unanswered", at: info.time.created }
    }
    if (info.role !== "assistant") return undefined
    const error = info.error
    if (error && typeof error === "object" && "name" in error) {
      if (error.name === "MessageAbortedError") return { kind: "aborted", at: info.time.created }
      return { kind: "errored", at: info.time.created }
    }
    if (info.time.completed === undefined) return { kind: "unfinished", at: info.time.created }
    // Finished normally but the model still owed tool results (stream cut mid tool-call).
    const pendingTool = last.parts.some(
      (part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
    )
    if (pendingTool) return { kind: "unfinished", at: info.time.created }
    return undefined
  }

  export function describe(kind: Kind) {
    switch (kind) {
      case "unanswered":
        return "Your last prompt never got a reply."
      case "unfinished":
        return "The last reply was cut off before it finished."
      case "errored":
        return "The last reply ended with an error."
      case "aborted":
        return "The last reply was stopped before it finished."
    }
  }

  export function ago(at: number, now = Date.now()) {
    const minutes = Math.max(1, Math.round((now - at) / 60_000))
    if (minutes < 60) return `${minutes} min ago`
    const hours = Math.round(minutes / 60)
    if (hours < 48) return `${hours} h ago`
    return `${Math.round(hours / 24)} d ago`
  }

  export type SendInput = {
    sessionID: string
    model: { providerID: string; modelID: string }
    agent?: string
    variant?: string
  }

  /** Queue the resume prompt as a normal user turn in the session. */
  export function send(sdk: ReturnType<typeof useSDK>, input: SendInput) {
    return sdk.client.session.prompt(
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        variant: input.variant,
        parts: [{ type: "text", text: PROMPT }],
      },
      { throwOnError: true },
    )
  }

  /** Fetch the tail of a session and report whether it was cut off. */
  export async function inspect(sdk: ReturnType<typeof useSDK>, sessionID: string) {
    const result = await sdk.client.session.messages({ sessionID, limit: 8 })
    return interrupted(result.data ?? [])
  }
}

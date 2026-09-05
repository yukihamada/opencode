import type { SessionV1 } from "@sente-ai/core/v1/session"
import type { MessageID, SessionID } from "./schema"

/**
 * Detects a conversation that has gone off the rails inside the current turn
 * (garbage control tokens, the model repeating itself, or the same tool call
 * looping) so the loop can compact the history and replay the user's request
 * on a clean context instead of letting the session spin or stop mid-work.
 *
 * Pure functions only — the loop decides what to do with the verdict.
 */
export namespace SessionDegrade {
  export type Reason = "garbage" | "repeat" | "tool_loop"

  export type Verdict = {
    reason: Reason
    detail: string
  }

  /** Control-token leakage that means the provider stream is corrupt. */
  export const GARBAGE_PATTERNS: RegExp[] = [
    /<ctrl\d+>/,
    /<\|(?:im_end|im_start|endoftext|eot_id|end_of_text|assistant|user|system|tool_call|tool_calls_begin|tool_calls_end)\|>/i,
    /�{3,}/,
  ]

  /** Minimum length for two consecutive replies to count as a repeat loop. */
  export const REPEAT_MIN_CHARS = 40

  /** Identical tool+input calls in a row before it is a loop. */
  export const TOOL_LOOP_COUNT = 3

  /** How many compaction rescues one session gets before we stop intervening. */
  export const MAX_RESCUES = 2

  /** Window for counting rescues (older ones are forgotten). */
  export const RESCUE_WINDOW_MS = 30 * 60 * 1000

  export type Decision = "compact" | "restart" | "ignore"

  function text(msg: SessionV1.WithParts) {
    return msg.parts
      .filter((part): part is SessionV1.TextPart => part.type === "text" && !part.synthetic)
      .map((part) => part.text)
      .join("\n")
  }

  function normalize(value: string) {
    return value.replace(/\s+/g, " ").trim()
  }

  function toolKey(part: SessionV1.ToolPart) {
    if (part.state.status === "pending") return undefined
    let input: string
    try {
      input = JSON.stringify(part.state.input)
    } catch {
      return undefined
    }
    return `${part.tool}:${input}`
  }

  /**
   * Inspect the assistant messages that belong to the turn opened by
   * `turnUserID`. Summary (compaction) messages are never inspected.
   */
  export function detect(msgs: SessionV1.WithParts[], turnUserID: MessageID): Verdict | undefined {
    const turn = msgs.filter(
      (m): m is SessionV1.WithParts & { info: SessionV1.Assistant } =>
        m.info.role === "assistant" && m.info.parentID === turnUserID && m.info.summary !== true,
    )
    if (turn.length === 0) return undefined

    const last = turn[turn.length - 1]
    const lastText = text(last)
    for (const pattern of GARBAGE_PATTERNS) {
      const hit = lastText.match(pattern)
      if (hit) return { reason: "garbage", detail: hit[0] }
    }

    if (turn.length >= 2) {
      const prev = normalize(text(turn[turn.length - 2]))
      const cur = normalize(lastText)
      if (cur.length >= REPEAT_MIN_CHARS && cur === prev) {
        return { reason: "repeat", detail: cur.slice(0, 60) }
      }
    }

    const calls = turn
      .flatMap((m) => m.parts)
      .filter((part): part is SessionV1.ToolPart => part.type === "tool")
      .map(toolKey)
    if (calls.length >= TOOL_LOOP_COUNT) {
      const tail = calls.slice(-TOOL_LOOP_COUNT)
      const head = tail[0]
      if (head !== undefined && tail.every((key) => key === head)) {
        return { reason: "tool_loop", detail: head.slice(0, 80) }
      }
    }

    return undefined
  }

  /**
   * Per-session rescue budget. First and second detections compact; the second
   * also asks the client to restart the process; after that we stop
   * intervening so a genuinely stuck session cannot loop forever.
   */
  export class Budget {
    private readonly seen = new Map<SessionID, number[]>()

    constructor(private readonly now: () => number = Date.now) {}

    record(sessionID: SessionID): Decision {
      const at = this.now()
      const recent = (this.seen.get(sessionID) ?? []).filter((t) => at - t < RESCUE_WINDOW_MS)
      if (recent.length >= MAX_RESCUES) {
        this.seen.set(sessionID, recent)
        return "ignore"
      }
      recent.push(at)
      this.seen.set(sessionID, recent)
      return recent.length === MAX_RESCUES ? "restart" : "compact"
    }
  }

  export const REF_PREFIX = "sente.degraded"

  export function ref(decision: Exclude<Decision, "ignore">, reason: Reason) {
    return `${REF_PREFIX}:${decision}:${reason}`
  }

  export function describe(verdict: Verdict, decision: Exclude<Decision, "ignore">) {
    const why = {
      garbage: "the reply contained corrupted control tokens",
      repeat: "the model kept repeating the same reply",
      tool_loop: "the same tool call was repeated without progress",
    }[verdict.reason]
    const next =
      decision === "restart"
        ? "compacting the conversation and restarting Sente to pick up where it left off"
        : "compacting the conversation and retrying the request on a clean context"
    return `Conversation went off track (${why}); ${next}.`
  }
}

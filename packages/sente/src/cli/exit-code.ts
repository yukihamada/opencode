/**
 * Exit code contract for the sente CLI.
 *
 * Modeled on the agent-first CLI convention: a caller (CI script, another
 * agent, a shell pipeline) can branch on the exit code alone without parsing
 * human-readable output. Keep this list append-only — a code that once meant
 * "auth failed" must never be reused for something else.
 *
 * The `default` (human) format prints the same information to stderr; the
 * numeric contract is what makes `--format json` usable unattended.
 */
export const ExitCode = {
  /** The prompt completed and the session went idle without error. */
  Success: 0,
  /** Usage error: bad flags, missing message, unknown agent, unreadable file. */
  User: 1,
  /** Could not reach the server or provider. Retrying later may succeed. */
  Network: 2,
  /** Credentials are missing, expired, or rejected. Retrying will not help. */
  Auth: 3,
  /** Anything else: internal defect, unexpected provider failure. */
  Other: 4,
  /** The request was well-formed but the target state changed (write conflict). */
  Conflict: 5,
} as const

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode]

/**
 * Map a thrown/returned error onto the exit code contract.
 *
 * Ordering matters: auth errors are frequently subclasses of provider errors,
 * so the auth check runs first. Anything unrecognised stays `Other` — we never
 * guess `Success`.
 */
export function exitCodeForError(error: unknown): ExitCode {
  const name = errorName(error)
  if (!name) return ExitCode.Other

  if (name === "ProviderAuthError" || name === "AccountTransportError" || name === "ConfigRemoteAuthError") {
    return ExitCode.Auth
  }
  if (name === "AccountServiceError") return ExitCode.Network
  if (name === "MCPFailed") return ExitCode.Network
  if (name === "MessageAbortedError") return ExitCode.User
  if (name === "ContextOverflowError" || name === "MessageOutputLengthError" || name === "ContentFilterError") {
    return ExitCode.User
  }
  if (name === "APIError") return ExitCode.Network
  if (name === "ProviderModelNotFoundError" || name === "ProviderInitError") return ExitCode.User
  if (name === "ConfigJsonError" || name === "ConfigInvalidError" || name === "ConfigDirectoryTypoError") {
    return ExitCode.User
  }
  return ExitCode.Other
}

/**
 * A diagnostic record emitted on stderr under `--format json`.
 *
 * stdout stays a pure event stream; stderr stays a pure diagnostic stream, so a
 * consumer never has to scrape ANSI-styled prose to find out that an agent name
 * was ignored or a permission was auto-rejected.
 */
export type Diagnostic = {
  type: "diagnostic"
  level: "warn" | "info"
  timestamp: number
  sessionID?: string
  message: string
} & Record<string, unknown>

/**
 * Build the diagnostic record. Kept pure (timestamp injected) so the shape is
 * testable without capturing stderr.
 */
export function diagnostic(
  level: "warn" | "info",
  message: string,
  input: { sessionID?: string; timestamp?: number; data?: Record<string, unknown> } = {},
): Diagnostic {
  const { sessionID, timestamp = Date.now(), data } = input
  return {
    type: "diagnostic",
    level,
    timestamp,
    ...(sessionID === undefined ? {} : { sessionID }),
    message,
    ...data,
  }
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const record = error as Record<string, unknown>
  if (typeof record.name === "string") return record.name
  if (typeof record._tag === "string") return record._tag
  return undefined
}

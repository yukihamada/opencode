/**
 * An interactive session that nobody has touched for hours still holds its full memory. When the launcher
 * asks for it, the screen exits with a dedicated code after a long quiet spell and leaves the session id
 * behind; the launcher shows a one-line notice and reopens that session on the next key press.
 * All three variables must be set, so running the binary directly never hibernates.
 */
export function settings(env: Record<string, string | undefined>) {
  const after = Number(env.SENTE_HIBERNATE_AFTER_MS)
  const code = Number(env.SENTE_HIBERNATE_EXIT_CODE)
  if (!env.SENTE_HIBERNATE_FILE) return undefined
  if (!Number.isFinite(after) || after <= 0) return undefined
  if (!Number.isInteger(code) || code <= 0 || code > 255) return undefined
  return { after, code, file: env.SENTE_HIBERNATE_FILE }
}

/** Only a session that can be reopened exactly as it is may hibernate: nothing running, asked, typed or open. */
export function ready(input: {
  now: number
  last: number
  after: number
  sessionID: string | undefined
  busy: boolean
  pending: boolean
  draft: string
  dialog: boolean
}) {
  if (!input.sessionID) return false
  if (input.busy || input.pending || input.dialog) return false
  if (input.draft.trim()) return false
  return input.now - input.last >= input.after
}

export * as Hibernate from "./hibernate"

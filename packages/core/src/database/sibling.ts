export * as DatabaseSibling from "./sibling"

import fs from "fs"
import { basename, dirname, join } from "path"
import { Effect } from "effect"
import { Flag } from "../flag/flag"

// Every build channel has its own session database (sente-<channel>.db) in the same
// directory. Opening a nearly empty one while another holds thousands of sessions looks
// exactly like "my conversations are gone". This module only detects that and explains
// how to get back; it never merges, migrates or deletes anything.

export interface Notice {
  /** File name of the database this process opened. */
  current: string
  currentSessions: number
  /** File name of the sibling database with clearly more sessions. */
  other: string
  otherSessions: number
  directory: string
}

export interface Skipped {
  file: string
  reason: string
}

export interface Result {
  notice?: Notice
  /** Siblings that could not be counted. Callers log these; they never raise a notice. */
  skipped: Skipped[]
}

export interface ScanInput {
  /** Absolute path of the database this process opened. */
  current: string
  /** Largest siblings to inspect. */
  limit?: number
  /** Stop opening further databases once this much wall time has passed. */
  budgetMs?: number
  count?: (file: string) => Promise<number>
  now?: () => number
}

const SIBLING = /^sente(-.*)?\.db$/

/** Sibling session databases, largest first (a database with far more sessions is far larger). */
export function candidates(current: string, limit = 6) {
  const directory = dirname(current)
  const self = basename(current)
  return fs
    .readdirSync(directory)
    .filter((name) => SIBLING.test(name) && name !== self)
    .flatMap((name) => {
      const stat = fs.statSync(join(directory, name), { throwIfNoEntry: false })
      return stat?.isFile() && stat.size > 0 ? [{ name, size: stat.size }] : []
    })
    .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((item) => item.name)
}

/**
 * Count sessions through a separate read-only connection. `count(*)` on `session` walks one
 * small index, so it stays in the millisecond range even on a multi-gigabyte database
 * (measured: ~70ms cold on a 14GB file with 2600 sessions).
 */
export async function countSessions(file: string): Promise<number> {
  const query = "SELECT count(*) AS n FROM session"
  if (typeof Bun !== "undefined") {
    const { Database } = await import("bun:sqlite")
    const db = new Database(file, { readonly: true })
    try {
      db.run("PRAGMA busy_timeout = 200")
      // prepare + finalize, not the cached db.query(): an unfinalized statement keeps the
      // file handle open after close(), which on Windows locks the user's database file.
      const statement = db.prepare(query)
      try {
        return Number((statement.get() as { n: number }).n)
      } finally {
        statement.finalize()
      }
    } finally {
      db.close()
    }
  }
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    db.exec("PRAGMA busy_timeout = 200")
    return Number((db.prepare(query).get() as { n: number }).n)
  } finally {
    db.close()
  }
}

/** "Clearly more": at least 20 sessions more and at least double. */
export function clearlyMore(current: number, other: number) {
  return other - current >= 20 && other >= current * 2
}

export async function scan(input: ScanInput): Promise<Result> {
  const count = input.count ?? countSessions
  const now = input.now ?? Date.now
  const deadline = now() + (input.budgetMs ?? 400)
  const skipped: Skipped[] = []
  const directory = dirname(input.current)
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

  const names = candidates(input.current, input.limit)
  if (names.length === 0) return { skipped }

  // A database that does not exist yet has no sessions; anything else that fails here means
  // we cannot compare, so stay silent rather than guess.
  const currentSessions = fs.existsSync(input.current)
    ? await count(input.current).catch((error) => {
        skipped.push({ file: basename(input.current), reason: reason(error) })
        return undefined
      })
    : 0
  if (currentSessions === undefined) return { skipped }

  let best: { name: string; sessions: number } | undefined
  for (const name of names) {
    if (now() > deadline) {
      skipped.push({ file: name, reason: "time budget exceeded" })
      continue
    }
    const sessions = await count(join(directory, name)).catch((error) => {
      skipped.push({ file: name, reason: reason(error) })
      return undefined
    })
    if (sessions === undefined) continue
    if (!best || sessions > best.sessions) best = { name, sessions }
  }

  if (!best || !clearlyMore(currentSessions, best.sessions)) return { skipped }
  return {
    skipped,
    notice: {
      current: basename(input.current),
      currentSessions,
      other: best.name,
      otherSessions: best.sessions,
      directory,
    },
  }
}

export function japanese(env: Record<string, string | undefined> = process.env) {
  return (env.TE_LANG || env.SENTE_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || "").startsWith("ja")
}

export function message(notice: Notice, ja = japanese()) {
  if (ja)
    return [
      `いま開いている会話DBより、会話がずっと多いDBが同じ場所にあります(会話は消えていません)。`,
      `  いま開いているDB: ${notice.current}(${notice.currentSessions}件)`,
      `  会話が多いDB: ${notice.other}(${notice.otherSessions}件)`,
      `  場所: ${notice.directory}`,
      `  そちらを開く: SENTE_DB=${notice.other} sente`,
      `  1件ずつ取り込む: SENTE_DB=${notice.other} sente export <sessionID> > s.json のあと sente import s.json`,
      `  自動では統合も削除もしません。この案内を止める: SENTE_DISABLE_DB_NOTICE=1`,
    ].join("\n")
  return [
    `Another session database in the same folder has far more sessions than the one that is open (nothing was deleted).`,
    `  Open now: ${notice.current} (${notice.currentSessions} sessions)`,
    `  Larger: ${notice.other} (${notice.otherSessions} sessions)`,
    `  Folder: ${notice.directory}`,
    `  Open it: SENTE_DB=${notice.other} sente`,
    `  Import one session: SENTE_DB=${notice.other} sente export <sessionID> > s.json, then sente import s.json`,
    `  Nothing is merged or removed automatically. Silence this: SENTE_DISABLE_DB_NOTICE=1`,
  ].join("\n")
}

export function disabled(env: Record<string, string | undefined> = process.env) {
  return env.SENTE_DISABLE_DB_NOTICE === "1" || env.SENTE_DISABLE_DB_NOTICE === "true"
}

/**
 * Text to show once at startup, or undefined. Skipped when the database was chosen on
 * purpose (SENTE_DB) or the notice is disabled. Problems are logged, never thrown: a
 * broken sibling must not stop Sente from starting.
 */
export const startupNotice = Effect.fn("DatabaseSibling.startupNotice")(function* (current: string) {
  if (Flag.SENTE_DB || disabled() || current === ":memory:") return undefined
  const result = yield* Effect.tryPromise({ try: () => scan({ current }), catch: (cause) => cause }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("session database sibling check failed", { current, cause: String(cause) }).pipe(
        Effect.as(undefined),
      ),
    ),
  )
  if (!result) return undefined
  for (const item of result.skipped)
    yield* Effect.logWarning("session database sibling not counted", { current, ...item })
  if (!result.notice) return undefined
  yield* Effect.logWarning("session database with more sessions exists", { ...result.notice })
  return message(result.notice)
})

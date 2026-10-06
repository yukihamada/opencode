export * as DatabaseGuard from "./guard"

import fs from "fs"
import { Flag } from "../flag/flag"
import { InstallationChannel, InstallationDefaultChannel, InstallationDev } from "../installation/version"
import { DatabaseReadonly } from "./readonly"

// A developer build opens the same session database as the shipped build. If it carries a
// migration the database has not seen, opening would change that database's schema for
// every other build too. This module only looks (read-only) and decides whether to stop
// before the database is opened; it never applies, skips or rewrites a migration.

/** Set to 1 to let a developer build apply its new migrations to the shared database. */
export const ALLOW = "SENTE_ALLOW_DEV_MIGRATION"

export interface Inspection {
  sessions: number
  /** Migration ids this build has that the database has not recorded, in apply order. */
  pending: string[]
}

export interface Blocked {
  database: string
  sessions: number
  migrations: string[]
}

/**
 * What `DatabaseMigration.apply` would run on this file, without running it. Mirrors how
 * `applyOnly` builds its completed set (the `migration` table, else the legacy Drizzle
 * journal). Returns undefined for a missing file or one without a `session` table: those
 * are created from scratch, there is nothing to protect.
 */
export async function inspect(file: string, ids: readonly string[]): Promise<Inspection | undefined> {
  if (file === ":memory:" || !fs.existsSync(file)) return undefined
  return DatabaseReadonly.open(file, (query) => {
    const tables = new Set(
      query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name),
    )
    if (!tables.has("session")) return undefined
    const sessions = Number(query<{ n: number }>("SELECT count(*) AS n FROM session")[0].n)
    let completed = new Set(
      tables.has("migration") ? query<{ id: string }>("SELECT id FROM migration").map((row) => row.id) : [],
    )
    if (completed.size === 0 && tables.has("__drizzle_migrations")) {
      const named = query<{ name: string }>("SELECT name FROM pragma_table_info('__drizzle_migrations')").some(
        (column) => column.name === "name",
      )
      if (named)
        completed = new Set(
          query<{ name: string }>("SELECT name FROM __drizzle_migrations WHERE name IS NOT NULL").map(
            (row) => row.name,
          ),
        )
      if (!named) {
        const prefixes = query<{ prefix: string | null }>(
          "SELECT strftime('%Y%m%d%H%M%S', created_at / 1000, 'unixepoch') AS prefix FROM __drizzle_migrations WHERE created_at IS NOT NULL",
        ).map((row) => row.prefix)
        completed = new Set(ids.filter((id) => prefixes.some((prefix) => prefix && id.startsWith(`${prefix}_`))))
      }
    }
    return { sessions, pending: ids.filter((id) => !completed.has(id)) }
  })
}

/**
 * Stop only when every one of these holds: an explicitly stamped developer build, on the
 * stable channel, with no database chosen via SENTE_DB, no explicit consent, and an
 * existing database that has sessions and lacks at least one of this build's migrations.
 */
export function decide(input: {
  dev: boolean
  channel: string
  explicit: boolean
  allow: boolean
  database: string
  inspection: Inspection | undefined
}): Blocked | undefined {
  if (!input.dev || input.allow || input.explicit) return undefined
  if (input.channel !== InstallationDefaultChannel) return undefined
  if (!input.inspection || input.inspection.sessions === 0 || input.inspection.pending.length === 0) return undefined
  return { database: input.database, sessions: input.inspection.sessions, migrations: input.inspection.pending }
}

export function allowed(env: Record<string, string | undefined> = process.env) {
  return env[ALLOW] === "1" || env[ALLOW] === "true"
}

export function message(blocked: Blocked, ja: boolean) {
  const list = blocked.migrations.map((id) => `    - ${id}`)
  if (ja)
    return [
      `この開発ビルドは、会話のある既存DBにまだ無いマイグレーションを含むため、起動を止めました(DBは変更していません)。`,
      `  対象DB: ${blocked.database}(会話 ${blocked.sessions}件)`,
      `  適用されるマイグレーション(${blocked.migrations.length}件):`,
      ...list,
      `  隔離して試す: SENTE_DB=<別名>.db sente で起動する、または SENTE_CHANNEL=<name> を付けてビルドし直す`,
      `  承知のうえこのDBに適用する: ${ALLOW}=1 sente(元に戻す手段はありません。正式版もこのDBを使います)`,
    ].join("\n")
  return [
    `This developer build has migrations the existing session database has not seen, so startup stopped (the database was not changed).`,
    `  Database: ${blocked.database} (${blocked.sessions} sessions)`,
    `  Migrations that would be applied (${blocked.migrations.length}):`,
    ...list,
    `  Try it in isolation: start with SENTE_DB=<other>.db sente, or rebuild with SENTE_CHANNEL=<name>`,
    `  Apply to this database anyway: ${ALLOW}=1 sente (there is no undo; the shipped build uses this database too)`,
  ].join("\n")
}

/**
 * Startup check. Release builds return before touching anything. Only call sites that are
 * about to open the database need this; `path` is the file they would open.
 */
export async function startup(path: string): Promise<Blocked | undefined> {
  if (!InstallationDev) return undefined
  const explicit = Boolean(Flag.SENTE_DB)
  if (explicit || allowed() || InstallationChannel !== InstallationDefaultChannel) return undefined
  // Imported here so only developer builds pay for loading the migration list twice.
  const { migrations } = await import("./migration.gen")
  return decide({
    dev: InstallationDev,
    channel: InstallationChannel,
    explicit,
    allow: false,
    database: path,
    inspection: await inspect(
      path,
      migrations.map((migration) => migration.id),
    ),
  })
}

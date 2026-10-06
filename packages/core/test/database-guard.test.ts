import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database as Sqlite } from "bun:sqlite"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Database } from "@sente-ai/core/database/database"
import { DatabaseGuard } from "@sente-ai/core/database/guard"
import { migrations } from "@sente-ai/core/database/migration.gen"
import { InstallationDefaultChannel, InstallationDev } from "@sente-ai/core/installation/version"
import { devBuild } from "../../script/src/channel"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "sente-guard-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function make(name: string, statements: string[]) {
  const file = path.join(dir, name)
  const db = new Sqlite(file)
  for (const statement of statements) db.run(statement)
  db.close(true)
  return file
}

function rows(file: string, query: string) {
  const db = new Sqlite(file, { readonly: true })
  const statement = db.prepare(query)
  const result = statement.all() as Record<string, unknown>[]
  statement.finalize()
  db.close(true)
  return result
}

const SESSION = "CREATE TABLE session (id TEXT PRIMARY KEY)"
const JOURNAL = "CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)"
const ids = ["20260101000000_a", "20260102000000_b", "20260103000000_c"]

describe("developer build stamp", () => {
  test("only a local 0.0.0- build without release markers is a developer build", () => {
    expect(devBuild({ version: "0.0.0-local-provider-idle-20261006", env: {} })).toBe(true)
    expect(devBuild({ version: "0.0.0-headless-model-fallback-202610061114", env: {} })).toBe(true)
  })

  test("everything that can be shipped is not", () => {
    expect(devBuild({ version: "2026.10.6-51", env: {} })).toBe(false)
    expect(devBuild({ version: "1.2.3", env: {} })).toBe(false)
    expect(devBuild({ version: "0.0.0-headless-model-fallback-202610061114", env: { GITHUB_ACTIONS: "true" } })).toBe(
      false,
    )
    expect(devBuild({ version: "0.0.0-x-202610061114", env: { CI: "true" } })).toBe(false)
    expect(devBuild({ version: "0.0.0-x-202610061114", env: { SENTE_OFFICIAL_BUILD: "1" } })).toBe(false)
    expect(devBuild({ version: "0.0.0-x-202610061114", env: { SENTE_RELEASE: "1" } })).toBe(false)
  })

  test("an unstamped runtime (source run, older build script) is never a developer build", () => {
    expect(InstallationDev).toBe(false)
  })
})

describe("migration guard decision", () => {
  const base = {
    dev: true,
    channel: InstallationDefaultChannel,
    explicit: false,
    allow: false,
    database: "/data/sente/sente-headless-model-fallback.db",
    inspection: { sessions: 2604, pending: ["20260103000000_c"] },
  }

  test("stops a developer build with a new migration on a database that has sessions", () => {
    expect(DatabaseGuard.decide(base)).toEqual({
      database: base.database,
      sessions: 2604,
      migrations: ["20260103000000_c"],
    })
  })

  test("never stops a release build", () => {
    expect(DatabaseGuard.decide({ ...base, dev: false })).toBeUndefined()
  })

  test("does not stop for a new, empty, up-to-date or deliberately isolated database", () => {
    expect(DatabaseGuard.decide({ ...base, inspection: undefined })).toBeUndefined()
    expect(DatabaseGuard.decide({ ...base, inspection: { sessions: 0, pending: ids } })).toBeUndefined()
    expect(DatabaseGuard.decide({ ...base, inspection: { sessions: 2604, pending: [] } })).toBeUndefined()
    expect(DatabaseGuard.decide({ ...base, explicit: true })).toBeUndefined()
    expect(DatabaseGuard.decide({ ...base, channel: "scratch" })).toBeUndefined()
  })

  test("does not stop once the developer consents", () => {
    expect(DatabaseGuard.decide({ ...base, allow: true })).toBeUndefined()
    expect(DatabaseGuard.allowed({ SENTE_ALLOW_DEV_MIGRATION: "1" })).toBe(true)
    expect(DatabaseGuard.allowed({ SENTE_ALLOW_DEV_MIGRATION: "0" })).toBe(false)
    expect(DatabaseGuard.allowed({})).toBe(false)
  })

  test("message lists the migrations, the database, the count and both ways out", () => {
    const blocked = DatabaseGuard.decide({ ...base, inspection: { sessions: 2604, pending: ids.slice(1) } })!
    for (const text of [DatabaseGuard.message(blocked, true), DatabaseGuard.message(blocked, false)]) {
      expect(text).toContain("20260102000000_b")
      expect(text).toContain("20260103000000_c")
      expect(text).toContain(base.database)
      expect(text).toContain("2604")
      expect(text).toContain("SENTE_DB=")
      expect(text).toContain("SENTE_CHANNEL=")
      expect(text).toContain("SENTE_ALLOW_DEV_MIGRATION=1")
    }
  })

  test("startup is a no-op unless the binary is stamped as a developer build", async () => {
    const file = make("sente-headless-model-fallback.db", [SESSION, JOURNAL, "INSERT INTO session VALUES ('s1')"])
    expect(await DatabaseGuard.startup(file)).toBeUndefined()
  })
})

describe("pending migration inspection", () => {
  test("a missing file or one without sessions table has nothing to protect", async () => {
    expect(await DatabaseGuard.inspect(path.join(dir, "nope.db"), ids)).toBeUndefined()
    expect(await DatabaseGuard.inspect(":memory:", ids)).toBeUndefined()
    expect(await DatabaseGuard.inspect(make("empty.db", ["CREATE TABLE other (id TEXT)"]), ids)).toBeUndefined()
  })

  test("reports migrations missing from the journal, in apply order, with the session count", async () => {
    const file = make("a.db", [
      SESSION,
      JOURNAL,
      "INSERT INTO session VALUES ('s1'), ('s2')",
      "INSERT INTO migration VALUES ('20260103000000_c', 1), ('20260101000000_a', 1)",
    ])
    expect(await DatabaseGuard.inspect(file, ids)).toEqual({ sessions: 2, pending: ["20260102000000_b"] })
  })

  test("an up-to-date database has nothing pending, and unknown newer entries are ignored", async () => {
    const file = make("b.db", [
      SESSION,
      JOURNAL,
      "INSERT INTO migration VALUES ('20260101000000_a', 1), ('20260102000000_b', 1), ('20260103000000_c', 1), ('20270101000000_future', 1)",
    ])
    expect(await DatabaseGuard.inspect(file, ids)).toEqual({ sessions: 0, pending: [] })
  })

  test("a database with sessions and no journal at all would get every migration", async () => {
    const file = make("c.db", [SESSION, "INSERT INTO session VALUES ('s1')"])
    expect(await DatabaseGuard.inspect(file, ids)).toEqual({ sessions: 1, pending: ids })
  })

  test("reads the legacy Drizzle journal by name", async () => {
    const file = make("d.db", [
      SESSION,
      "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at INTEGER, name TEXT)",
      "INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES ('h', 1, '20260101000000_a'), ('h', 2, '20260102000000_b')",
    ])
    expect((await DatabaseGuard.inspect(file, ids))?.pending).toEqual(["20260103000000_c"])
  })

  test("reads the legacy Drizzle journal by timestamp", async () => {
    const file = make("e.db", [
      SESSION,
      "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at INTEGER)",
      `INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('h', ${Date.UTC(2026, 0, 1)}), ('h', ${Date.UTC(2026, 0, 3)})`,
    ])
    expect((await DatabaseGuard.inspect(file, ids))?.pending).toEqual(["20260102000000_b"])
  })

  test("inspecting changes nothing and releases the file", async () => {
    const file = make("f.db", [SESSION, JOURNAL, "INSERT INTO session VALUES ('s1')"])
    const before = await fs.readFile(file)
    expect((await DatabaseGuard.inspect(file, ids))?.pending).toEqual(ids)
    expect((await fs.readFile(file)).equals(before)).toBe(true)
    expect(rows(file, "SELECT id FROM migration")).toEqual([])
    await fs.rm(file)
  })

  test("agrees with the real migration runner", async () => {
    const file = path.join(dir, "real.db")
    const all = migrations.map((migration) => migration.id)
    const open = Effect.gen(function* () {
      yield* Database.Service
    }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped)

    await Effect.runPromise(open)
    expect(await DatabaseGuard.inspect(file, all)).toEqual({ sessions: 0, pending: [] })

    // Forget the newest migration: the guard must name exactly what the runner then applies.
    const last = all[all.length - 1]
    const db = new Sqlite(file)
    db.run(`DELETE FROM migration WHERE id = '${last}'`)
    db.close(true)
    expect((await DatabaseGuard.inspect(file, all))?.pending).toEqual([last])
    await Effect.runPromise(open)
    expect((await DatabaseGuard.inspect(file, all))?.pending).toEqual([])
  })
})

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database as Sqlite } from "bun:sqlite"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Database } from "@sente-ai/core/database/database"
import { DatabaseSibling } from "@sente-ai/core/database/sibling"
import { Flag } from "@sente-ai/core/flag/flag"
import { InstallationDefaultChannel, normalizeChannel } from "@sente-ai/core/installation/version"
import { DEFAULT_CHANNEL, previewLabel, resolveChannel } from "../../script/src/channel"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "sente-sibling-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function seed(name: string, sessions: number) {
  const file = path.join(dir, name)
  const db = new Sqlite(file)
  db.run("PRAGMA journal_mode = WAL")
  db.run("CREATE TABLE session (id TEXT PRIMARY KEY)")
  const insert = db.prepare("INSERT INTO session (id) VALUES (?)")
  db.transaction(() => {
    for (let index = 0; index < sessions; index++) insert.run(`ses_${index}`)
  })()
  // Finalize before closing: a pending statement keeps the handle open and Windows then
  // refuses to delete the file (EBUSY). close(true) throws if anything is still pending.
  insert.finalize()
  db.close(true)
  return file
}

describe("build channel", () => {
  test("an unset channel is the stable one, never the branch or empty", () => {
    expect(resolveChannel({})).toBe("headless-model-fallback")
    expect(resolveChannel({ SENTE_CHANNEL: "" })).toBe(DEFAULT_CHANNEL)
    expect(resolveChannel({ SENTE_CHANNEL: "   " })).toBe(DEFAULT_CHANNEL)
    expect(resolveChannel({ SENTE_VERSION: "0.0.0-local-20261006" })).toBe(DEFAULT_CHANNEL)
  })

  test("an explicit channel and release versions keep their meaning", () => {
    expect(resolveChannel({ SENTE_CHANNEL: "scratch" })).toBe("scratch")
    expect(resolveChannel({ SENTE_BUMP: "patch" })).toBe("latest")
    expect(resolveChannel({ SENTE_VERSION: "1.2.3" })).toBe("latest")
    expect(resolveChannel({ SENTE_CHANNEL: "scratch", SENTE_VERSION: "1.2.3" })).toBe("scratch")
  })

  test("the branch only labels the preview version", () => {
    expect(previewLabel(DEFAULT_CHANNEL, "feat/cost-limit-50\n")).toBe("feat-cost-limit-50")
    expect(previewLabel(DEFAULT_CHANNEL, "")).toBe(DEFAULT_CHANNEL)
  })

  test("build script and runtime agree on the stable channel", () => {
    expect(InstallationDefaultChannel).toBe(DEFAULT_CHANNEL)
  })

  test("a build stamped with an empty channel falls back to the stable one", () => {
    expect(normalizeChannel("")).toBe(InstallationDefaultChannel)
    expect(normalizeChannel(" ")).toBe(InstallationDefaultChannel)
    expect(normalizeChannel(undefined)).toBe("local")
    expect(normalizeChannel("scratch")).toBe("scratch")
  })

  test("database file name never becomes sente-.db", () => {
    expect(Database.channelFile("")).toBe("sente-headless-model-fallback.db")
    expect(Database.channelFile("headless-model-fallback")).toBe("sente-headless-model-fallback.db")
    expect(Database.channelFile("feat/cost-limit-50")).toBe("sente-feat-cost-limit-50.db")
    expect(Database.channelFile("latest")).toBe("sente.db")
    expect(Database.channelFile("scratch", { shared: true })).toBe("sente.db")
  })
})

describe("sibling session databases", () => {
  test("reports the sibling that clearly has more sessions", async () => {
    const current = seed("sente-feat-x.db", 3)
    seed("sente-headless-model-fallback.db", 120)
    seed("sente-.db", 18)
    const result = await DatabaseSibling.scan({ current })
    expect(result.skipped).toEqual([])
    expect(result.notice).toEqual({
      current: "sente-feat-x.db",
      currentSessions: 3,
      other: "sente-headless-model-fallback.db",
      otherSessions: 120,
      directory: dir,
    })
  })

  test("a database that does not exist yet counts as empty", async () => {
    seed("sente-headless-model-fallback.db", 40)
    const result = await DatabaseSibling.scan({ current: path.join(dir, "sente-new.db") })
    expect(result.notice?.currentSessions).toBe(0)
    expect(result.notice?.otherSessions).toBe(40)
  })

  test("stays quiet when the open database is the big one or the gap is small", async () => {
    const main = seed("sente-headless-model-fallback.db", 120)
    const side = seed("sente-side.db", 110)
    seed("sente-tiny.db", 2)
    expect((await DatabaseSibling.scan({ current: main })).notice).toBeUndefined()
    expect((await DatabaseSibling.scan({ current: side })).notice).toBeUndefined()
    expect(DatabaseSibling.clearlyMore(0, 19)).toBe(false)
    expect(DatabaseSibling.clearlyMore(0, 20)).toBe(true)
    expect(DatabaseSibling.clearlyMore(300, 500)).toBe(false)
    expect(DatabaseSibling.clearlyMore(300, 2602)).toBe(true)
  })

  test("ignores unrelated files and only looks at session databases", async () => {
    const current = seed("sente-feat-x.db", 1)
    seed("sessions.db", 500)
    seed("other.db", 500)
    seed("sente.db", 60)
    await fs.writeFile(path.join(dir, "sente-empty.db"), "")
    expect(DatabaseSibling.candidates(current)).toEqual(["sente.db"])
    expect((await DatabaseSibling.scan({ current })).notice?.other).toBe("sente.db")
  })

  test("an unreadable sibling is reported as skipped and never raises a notice", async () => {
    const current = seed("sente-feat-x.db", 1)
    await fs.writeFile(path.join(dir, "sente-broken.db"), "this is not a sqlite database, just text ".repeat(200))
    const schema = new Sqlite(path.join(dir, "sente-noschema.db"))
    schema.run("CREATE TABLE unrelated (id TEXT)")
    schema.close(true)
    const result = await DatabaseSibling.scan({ current })
    expect(result.notice).toBeUndefined()
    expect(result.skipped.map((item) => item.file).sort()).toEqual(["sente-broken.db", "sente-noschema.db"])
    expect(result.skipped.every((item) => item.reason.length > 0)).toBe(true)
  })

  test("stops opening databases once the time budget is spent", async () => {
    const current = seed("sente-feat-x.db", 1)
    seed("sente-a.db", 300)
    seed("sente-b.db", 30)
    const opened: string[] = []
    let clock = 0
    const result = await DatabaseSibling.scan({
      current,
      budgetMs: 100,
      now: () => clock,
      count: async (file) => {
        opened.push(path.basename(file))
        clock += 150
        return DatabaseSibling.countSessions(file)
      },
    })
    expect(opened).toEqual(["sente-feat-x.db"])
    expect(result.notice).toBeUndefined()
    expect(result.skipped).toEqual([
      { file: "sente-a.db", reason: "time budget exceeded" },
      { file: "sente-b.db", reason: "time budget exceeded" },
    ])
  })

  test("checks only the largest siblings", async () => {
    const current = seed("sente-feat-x.db", 1)
    seed("sente-big.db", 400)
    seed("sente-small.db", 5)
    expect(DatabaseSibling.candidates(current, 1)).toEqual(["sente-big.db"])
  })

  test("counting does not modify the database", async () => {
    const file = seed("sente-headless-model-fallback.db", 25)
    const before = await fs.readFile(file)
    expect(await DatabaseSibling.countSessions(file)).toBe(25)
    expect((await fs.readFile(file)).equals(before)).toBe(true)
  })

  test("counting releases the file, readable or not, so it can be removed right away", async () => {
    // On Windows an open handle makes rm fail with EBUSY; elsewhere this always holds.
    const good = seed("sente-headless-model-fallback.db", 25)
    const broken = path.join(dir, "sente-broken.db")
    await fs.writeFile(broken, "this is not a sqlite database, just text ".repeat(200))
    expect(await DatabaseSibling.countSessions(good)).toBe(25)
    await expect(DatabaseSibling.countSessions(broken)).rejects.toThrow()
    await fs.rm(good)
    await fs.rm(broken)
    expect(await fs.readdir(dir).then((names) => names.filter((name) => name.endsWith(".db")))).toEqual([])
  })

  test("message names both databases, counts and how to switch, in ja and en", async () => {
    const notice = {
      current: "sente-feat-x.db",
      currentSessions: 3,
      other: "sente-headless-model-fallback.db",
      otherSessions: 2602,
      directory: "/data/sente",
    }
    for (const text of [DatabaseSibling.message(notice, true), DatabaseSibling.message(notice, false)]) {
      expect(text).toContain("sente-feat-x.db")
      expect(text).toContain("3")
      expect(text).toContain("2602")
      expect(text).toContain("SENTE_DB=sente-headless-model-fallback.db sente")
      expect(text).toContain("sente import")
      expect(text).toContain("SENTE_DISABLE_DB_NOTICE=1")
    }
    expect(DatabaseSibling.japanese({ TE_LANG: "ja" })).toBe(true)
    expect(DatabaseSibling.japanese({ LANG: "en_US.UTF-8" })).toBe(false)
  })

  describe("startup notice", () => {
    const flag = Flag.SENTE_DB
    const env = process.env.SENTE_DISABLE_DB_NOTICE

    afterEach(() => {
      Flag.SENTE_DB = flag
      if (env === undefined) delete process.env.SENTE_DISABLE_DB_NOTICE
      else process.env.SENTE_DISABLE_DB_NOTICE = env
    })

    test("returns the message for a build that opened a small database", async () => {
      Flag.SENTE_DB = undefined
      delete process.env.SENTE_DISABLE_DB_NOTICE
      const current = seed("sente-feat-x.db", 3)
      seed("sente-headless-model-fallback.db", 120)
      const text = await Effect.runPromise(DatabaseSibling.startupNotice(current))
      expect(text).toContain("sente-headless-model-fallback.db")
      expect(text).toContain("120")
    })

    test("is silent when the database was chosen explicitly or the notice is disabled", async () => {
      const current = seed("sente-feat-x.db", 3)
      seed("sente-headless-model-fallback.db", 120)
      Flag.SENTE_DB = current
      delete process.env.SENTE_DISABLE_DB_NOTICE
      expect(await Effect.runPromise(DatabaseSibling.startupNotice(current))).toBeUndefined()
      Flag.SENTE_DB = undefined
      process.env.SENTE_DISABLE_DB_NOTICE = "1"
      expect(await Effect.runPromise(DatabaseSibling.startupNotice(current))).toBeUndefined()
    })

    test("a missing data directory is logged, not thrown", async () => {
      Flag.SENTE_DB = undefined
      delete process.env.SENTE_DISABLE_DB_NOTICE
      const missing = path.join(dir, "nope", "sente-feat-x.db")
      expect(await Effect.runPromise(DatabaseSibling.startupNotice(missing))).toBeUndefined()
    })
  })
})

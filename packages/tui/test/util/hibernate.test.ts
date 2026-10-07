import { describe, expect, test } from "bun:test"
import { Hibernate } from "../../src/util/hibernate"

const quiet = {
  now: 10_000,
  last: 0,
  after: 10_000,
  sessionID: "ses_1",
  busy: false,
  pending: false,
  draft: "",
  dialog: false,
}

describe("Hibernate.settings", () => {
  test("is off unless the launcher provides all three values", () => {
    expect(Hibernate.settings({})).toBeUndefined()
    expect(Hibernate.settings({ SENTE_HIBERNATE_AFTER_MS: "1000", SENTE_HIBERNATE_EXIT_CODE: "76" })).toBeUndefined()
    expect(Hibernate.settings({ SENTE_HIBERNATE_AFTER_MS: "1000", SENTE_HIBERNATE_FILE: "/tmp/x" })).toBeUndefined()
    expect(
      Hibernate.settings({
        SENTE_HIBERNATE_AFTER_MS: "0",
        SENTE_HIBERNATE_EXIT_CODE: "76",
        SENTE_HIBERNATE_FILE: "/tmp/x",
      }),
    ).toBeUndefined()
    expect(
      Hibernate.settings({
        SENTE_HIBERNATE_AFTER_MS: "1000",
        SENTE_HIBERNATE_EXIT_CODE: "76",
        SENTE_HIBERNATE_FILE: "/tmp/x",
      }),
    ).toEqual({ after: 1000, code: 76, file: "/tmp/x" })
  })
})

describe("Hibernate.ready", () => {
  test("a quiet open session hibernates once the wait has passed", () => {
    expect(Hibernate.ready(quiet)).toBe(true)
    expect(Hibernate.ready({ ...quiet, now: 9_999 })).toBe(false)
  })

  test("anything that would be lost keeps the session open", () => {
    expect(Hibernate.ready({ ...quiet, sessionID: undefined })).toBe(false)
    expect(Hibernate.ready({ ...quiet, busy: true })).toBe(false)
    expect(Hibernate.ready({ ...quiet, pending: true })).toBe(false)
    expect(Hibernate.ready({ ...quiet, dialog: true })).toBe(false)
    expect(Hibernate.ready({ ...quiet, draft: "half a thought" })).toBe(false)
    expect(Hibernate.ready({ ...quiet, draft: "  \n" })).toBe(true)
  })
})

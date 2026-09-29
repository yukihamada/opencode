import { describe, expect, test } from "bun:test"
import { ExitCode, diagnostic, exitCodeForError, shouldRestart } from "../../src/cli/exit-code"

describe("cli.exit-code", () => {
  test("exposes the agent-first exit code contract", () => {
    expect(ExitCode).toEqual({
      Success: 0,
      User: 1,
      Network: 2,
      Auth: 3,
      Other: 4,
      Conflict: 5,
      Quota: 6,
      PermissionDenied: 7,
      Restart: 75,
    })
  })

  test("never restarts an unattended run that its policy refused", () => {
    expect(shouldRestart(ExitCode.PermissionDenied)).toBe(false)
  })

  test("classifies auth failures as 3 so callers do not retry", () => {
    for (const name of ["ProviderAuthError", "AccountTransportError", "ConfigRemoteAuthError"]) {
      expect(exitCodeForError({ name, data: {} })).toBe(ExitCode.Auth)
    }
  })

  test("classifies transport failures as 2 so callers may retry", () => {
    for (const name of ["AccountServiceError", "MCPFailed", "APIError"]) {
      expect(exitCodeForError({ name, data: {} })).toBe(ExitCode.Network)
    }
  })

  // teai が分/時/日/月の上限で 402 を返した時に 2(Network=再試行してよい)を返すと、
  // te loop / launchd が上限切れの鍵で再起動を繰り返す。
  test("classifies a 402 usage cap as 6 so supervisors stop instead of retrying", () => {
    expect(exitCodeForError({ name: "APIError", data: { statusCode: 402 } })).toBe(ExitCode.Quota)
    expect(exitCodeForError({ name: "APIError", data: { statusCode: 503 } })).toBe(ExitCode.Network)
    expect(shouldRestart(ExitCode.Quota)).toBe(false)
  })

  test("classifies caller mistakes as 1", () => {
    for (const name of [
      "MessageAbortedError",
      "ContextOverflowError",
      "MessageOutputLengthError",
      "ContentFilterError",
      "ProviderModelNotFoundError",
      "ProviderInitError",
      "ConfigJsonError",
      "ConfigInvalidError",
      "ConfigDirectoryTypoError",
    ]) {
      expect(exitCodeForError({ name, data: {} })).toBe(ExitCode.User)
    }
  })

  test("reads tagged errors the same way as named errors", () => {
    expect(exitCodeForError({ _tag: "ProviderAuthError" })).toBe(ExitCode.Auth)
    expect(exitCodeForError({ _tag: "APIError" })).toBe(ExitCode.Network)
  })

  test("falls back to 4 for anything unrecognised, never 0", () => {
    for (const input of [undefined, null, "boom", 42, {}, { name: 123 }, new Error("plain")]) {
      expect(exitCodeForError(input)).toBe(ExitCode.Other)
    }
  })
})

describe("cli.diagnostic", () => {
  test("builds a structured stderr record with the session attached", () => {
    const record = diagnostic("warn", "agent not found", {
      sessionID: "ses_1",
      timestamp: 1000,
      data: { agent: "nope" },
    })
    expect(record).toEqual({
      type: "diagnostic",
      level: "warn",
      timestamp: 1000,
      sessionID: "ses_1",
      message: "agent not found",
      agent: "nope",
    })
  })

  test("omits sessionID before a session is resolved", () => {
    const record = diagnostic("info", "https://example.com/share", { timestamp: 5 })
    expect(record).toEqual({
      type: "diagnostic",
      level: "info",
      timestamp: 5,
      message: "https://example.com/share",
    })
    expect("sessionID" in record).toBe(false)
  })

  test("stays serializable so stderr remains one JSON object per line", () => {
    const line = JSON.stringify(diagnostic("warn", "boom", { sessionID: "ses_2", data: { n: 1 } }))
    expect(line).not.toContain("\n")
    expect(JSON.parse(line)).toMatchObject({ type: "diagnostic", level: "warn", sessionID: "ses_2", n: 1 })
  })
})

describe("cli.shouldRestart", () => {
  test("never restarts on a permanent failure", () => {
    for (const code of [ExitCode.User, ExitCode.Auth, ExitCode.Conflict, ExitCode.Quota]) {
      expect(shouldRestart(code)).toBe(false)
    }
  })

  test("allows a restart for transient failures and the resume request", () => {
    for (const code of [ExitCode.Network, ExitCode.Other, ExitCode.Restart]) {
      expect(shouldRestart(code)).toBe(true)
    }
  })

  test("does not restart on success", () => {
    expect(shouldRestart(ExitCode.Success)).toBe(false)
  })

  // launchd KeepAlive restarts on any exit. A bad flag must not become an
  // infinite loop — that burned ~4.3M credits over 3 days in 2026-09.
  test("classifies the codes a KeepAlive supervisor sees most often", () => {
    expect(shouldRestart(1)).toBe(false)
    expect(shouldRestart(3)).toBe(false)
    expect(shouldRestart(2)).toBe(true)
  })

  test("75 stays outside the 0-5 range so it cannot collide", () => {
    const range = [ExitCode.Success, ExitCode.User, ExitCode.Network, ExitCode.Auth, ExitCode.Other, ExitCode.Conflict]
    expect(range).not.toContain(ExitCode.Restart)
    expect(ExitCode.Restart).toBe(75)
  })
})

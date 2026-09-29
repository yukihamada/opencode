import { describe, expect, test } from "bun:test"
import { SecretRedact } from "../../src/tool/secret-redact"

const TE = "te_" + "c32a".repeat(8)

describe("SecretRedact.redact", () => {
  test("masks the credentials line that leaked on 2026-09-25", () => {
    const out = SecretRedact.redact(`TEAI_API_KEY=${TE}\n`, {})
    expect(out).not.toContain(TE)
    expect(out).toBe("TEAI_API_KEY=te_c32ac…[REDACTED]\n")
  })

  test("masks common provider key formats", () => {
    const keys = [
      "sk-ant-api03-" + "a".repeat(40),
      "sk-or-v1-" + "b".repeat(64),
      "sk-proj-" + "c".repeat(48),
      "ghp_" + "d".repeat(36),
      "github_pat_" + "e".repeat(60),
      "AKIA" + "F".repeat(16),
      "xoxb-1234567890-abcdefghij",
      "AIza" + "g".repeat(35),
      "cw_" + "h".repeat(32),
    ]
    const out = SecretRedact.redact(keys.join("\n"), {})
    for (const key of keys) expect(out).not.toContain(key)
    expect(out.split("\n").every((line) => line.endsWith("…[REDACTED]"))).toBe(true)
  })

  test("masks exact values of secret-looking env vars in any format", () => {
    const env = { MY_SERVICE_TOKEN: "Zq9-custom.secret-value42", PATH: "/usr/bin:/bin:/usr/local/bin" }
    const out = SecretRedact.redact(`token is Zq9-custom.secret-value42; path /usr/bin:/bin:/usr/local/bin`, env)
    expect(out).not.toContain("Zq9-custom.secret-value42")
    expect(out).toContain("/usr/bin:/bin:/usr/local/bin")
  })

  test("does not treat path-like env values as secrets", () => {
    const env = { GPG_KEY_PATH: "/Users/someone/.gnupg/key1234", API_TOKEN: "abcDEF1234567890xyz" }
    const out = SecretRedact.redact("key at /Users/someone/.gnupg/key1234 token abcDEF1234567890xyz", env)
    expect(out).toContain("/Users/someone/.gnupg/key1234")
    expect(out).not.toContain("abcDEF1234567890xyz")
  })

  test("redactMetadata walks nested display fields and keeps non-strings", () => {
    const secret = "te_" + "c32a".repeat(8)
    const meta = { preview: secret, display: { text: `id ${secret}` }, exit: 0, list: [secret], truncated: false }
    const out = SecretRedact.redactMetadata(meta, {})
    expect(JSON.stringify(out)).not.toContain(secret)
    expect(out.exit).toBe(0)
    expect(out.truncated).toBe(false)
  })

  test("leaves ordinary text alone", () => {
    const text = "te_script_version ok; sk-short; commit c858040acd778299fd7b14ed7d4fe54e1b9b1442; te_c32a…"
    expect(SecretRedact.redact(text, {})).toBe(text)
  })

  test("SENTE_NO_SECRET_REDACT=1 disables it", () => {
    expect(SecretRedact.redact(TE, { SENTE_NO_SECRET_REDACT: "1" })).toBe(TE)
  })
})

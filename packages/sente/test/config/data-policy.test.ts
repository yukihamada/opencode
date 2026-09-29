import { describe, expect, test } from "bun:test"
import { DataPolicy } from "@/config/data-policy"
import type { ConfigV1 } from "@sente-ai/core/v1/config/config"
import type { ModelMessage } from "ai"

const config = (input: NonNullable<ConfigV1.Info["dataPolicy"]>): ConfigV1.Info["dataPolicy"] => input

describe("DataPolicy.apply", () => {
  test("mode off leaves text untouched and reports nothing", () => {
    const result = DataPolicy.apply(
      "key=AKIAIOSFODNN7EXAMPLE",
      config({
        mode: "off",
        denyPatterns: ["AKIA[0-9A-Z]{16}"],
        maskPatterns: [{ pattern: "AKIA[0-9A-Z]{16}", replacement: "[REDACTED]" }],
      }),
    )
    expect(result).toEqual({ text: "key=AKIAIOSFODNN7EXAMPLE", blocked: false, warnings: [] })
  })

  test("undefined config behaves like off", () => {
    const result = DataPolicy.apply("secret", undefined)
    expect(result).toEqual({ text: "secret", blocked: false, warnings: [] })
  })

  test("maskPatterns replace every match in order", () => {
    const result = DataPolicy.apply(
      "keys: AKIAIOSFODNN7EXAMPLE and AKIAIOSFODNN7EXAMPLE, token=abc123",
      config({
        mode: "warn",
        maskPatterns: [
          { pattern: "AKIA[0-9A-Z]{16}", replacement: "[REDACTED]" },
          { pattern: "token=\\w+", replacement: "token=[MASKED]" },
        ],
      }),
    )
    expect(result.text).toBe("keys: [REDACTED] and [REDACTED], token=[MASKED]")
    expect(result.blocked).toBe(false)
    expect(result.warnings).toEqual([])
  })

  test("denyPatterns produce warnings in warn mode without blocking", () => {
    const result = DataPolicy.apply(
      "BEGIN PRIVATE KEY",
      config({ mode: "warn", denyPatterns: ["PRIVATE KEY", "password\\s*="] }),
    )
    expect(result.text).toBe("BEGIN PRIVATE KEY")
    expect(result.blocked).toBe(false)
    expect(result.warnings).toEqual(["data policy deny pattern matched: PRIVATE KEY"])
  })

  test("denyPatterns block in block mode", () => {
    const result = DataPolicy.apply(
      "password=hunter2",
      config({ mode: "block", denyPatterns: ["password\\s*="] }),
    )
    expect(result.blocked).toBe(true)
    expect(result.warnings).toEqual(["data policy deny pattern matched: password\\s*="])
  })

  test("denyPatterns match against masked text, so masked secrets no longer trip deny rules", () => {
    const result = DataPolicy.apply(
      "AKIAIOSFODNN7EXAMPLE",
      config({
        mode: "block",
        maskPatterns: [{ pattern: "AKIA[0-9A-Z]{16}", replacement: "[REDACTED]" }],
        denyPatterns: ["AKIA[0-9A-Z]{16}"],
      }),
    )
    expect(result.text).toBe("[REDACTED]")
    expect(result.blocked).toBe(false)
    expect(result.warnings).toEqual([])
  })
})

describe("DataPolicy.messages", () => {
  test("masks string and text-part content across all messages", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "key AKIAIOSFODNN7EXAMPLE" },
      {
        role: "user",
        content: [
          { type: "text", text: "token=abc123" },
          { type: "file", data: new Uint8Array(), mediaType: "application/octet-stream" },
        ],
      },
    ]
    const result = DataPolicy.messages(
      messages,
      config({
        mode: "warn",
        maskPatterns: [
          { pattern: "AKIA[0-9A-Z]{16}", replacement: "[REDACTED]" },
          { pattern: "token=\\w+", replacement: "token=[MASKED]" },
        ],
      }),
    )
    expect(result.messages[0]).toEqual({ role: "system", content: "key [REDACTED]" })
    const parts = (result.messages[1] as { content: unknown[] }).content
    expect(parts[0]).toEqual({ type: "text", text: "token=[MASKED]" })
    expect(parts[1]).toEqual(messages[1] && (messages[1] as any).content[1])
    expect(result.blocked).toBe(false)
  })

  test("blocks when any message matches a deny pattern in block mode", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "user", content: "password=hunter2" },
    ]
    const result = DataPolicy.messages(messages, config({ mode: "block", denyPatterns: ["password\\s*="] }))
    expect(result.blocked).toBe(true)
    expect(result.warnings).toEqual(["data policy deny pattern matched: password\\s*="])
  })
})

describe("DataPolicy.blockedPath", () => {
  test("matches denyPaths globs", () => {
    const cfg = config({ mode: "warn", denyPaths: ["**/*.env", "secrets/**"] })
    expect(DataPolicy.blockedPath("app/.env", cfg)).toBe(true)
    expect(DataPolicy.blockedPath("secrets/key.pem", cfg)).toBe(true)
    expect(DataPolicy.blockedPath("src/index.ts", cfg)).toBe(false)
  })

  test("never blocks when mode is off", () => {
    const cfg = config({ mode: "off", denyPaths: ["**/*.env"] })
    expect(DataPolicy.blockedPath("app/.env", cfg)).toBe(false)
  })
})

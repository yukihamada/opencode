import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { redactConfig } from "@/cli/cmd/debug/redact"

const config = {
  provider: {
    example: {
      options: {
        apiKey: "sk-example",
        timeout: 1200,
        headers: { Authorization: "Bearer example", "X-API-Key": "key" },
      },
      models: { demo: { variants: { fast: { api_key: "variant-secret" } } } },
    },
  },
  mcp: {
    remote: { oauth: { clientSecret: "oauth-secret", clientId: "public" }, headers: { "x-custom": "opaque" } },
    local: { environment: { SERVICE_TOKEN: "env-secret", PATH: "/usr/bin" } },
  },
  url: "https://user:pass@example.com/path",
  normal: { context_tokens: 200000, name: "example" },
}

describe("debug config redaction", () => {
  cliIt.live("always masks resolved credentials", ({ sente }) =>
    Effect.gen(function* () {
      const content = JSON.stringify({ provider: config.provider })
      const env = { SENTE_CONFIG_CONTENT: content }
      const result = yield* sente.spawn(["debug", "config"], { env })
      sente.expectExit(result, 0, "debug config")
      expect(JSON.parse(result.stdout).provider.example.options).toMatchObject({
        apiKey: "***",
        timeout: 1200,
        headers: { Authorization: "***", "X-API-Key": "***" },
      })
      expect(result.stdout).not.toContain("sk-example")
      expect(result.stdout).not.toContain("Bearer example")
    }),
  )

  test("does not mutate the input and preserves unrelated settings", () => {
    const before = structuredClone(config)
    expect(redactConfig(config)).toEqual({
      provider: {
        example: {
          options: { apiKey: "***", timeout: 1200, headers: { Authorization: "***", "X-API-Key": "***" } },
          models: { demo: { variants: { fast: { api_key: "***" } } } },
        },
      },
      mcp: {
        remote: { oauth: { clientSecret: "***", clientId: "public" }, headers: { "x-custom": "***" } },
        local: { environment: { SERVICE_TOKEN: "***", PATH: "/usr/bin" } },
      },
      url: "***",
      normal: config.normal,
    })
    expect(config).toEqual(before)
  })

  test("masks credential URLs inside nested arrays without hiding public URLs", () => {
    expect(
      redactConfig({
        urls: [
          { url: "https://example.com/?api_key=example" },
          { url: "https://example.com/?access_token=example" },
          { url: "https://[invalid" },
          { url: "https://example.com/?region=global" },
        ],
        optional: null,
      }),
    ).toMatchObject({
      urls: [{ url: "***" }, { url: "***" }, { url: "***" }, { url: "https://example.com/?region=global" }],
      optional: null,
    })
  })

  test("masks secrets in arrays and nested credential objects", () => {
    expect(
      redactConfig({
        headers: { custom: ["opaque"] },
        apiKey: ["first-key", "second-key"],
        credentials: { value: "nested-secret" },
        urls: ["https://user:pass@example.com", "https://example.com/?token=secret", "https://example.com"],
      }),
    ).toEqual({
      headers: { custom: ["***"] },
      apiKey: ["***", "***"],
      credentials: { value: "***" },
      urls: ["***", "***", "https://example.com"],
    })
  })
})

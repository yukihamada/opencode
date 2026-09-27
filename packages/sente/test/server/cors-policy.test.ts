import { describe, expect, test } from "bun:test"
import { isAllowedCorsOrigin, isAllowedRequestOrigin } from "@sente-ai/server/cors"

describe("CORS origin boundary", () => {
  test.each([
    "https://teai.io",
    "https://app.teai.io",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "oc://renderer",
    "tauri://localhost",
    "https://tauri.localhost",
  ])("allows supported origin %s", (origin) => {
    expect(isAllowedCorsOrigin(origin)).toBe(true)
  })

  test.each([
    "https://teaixio",
    "https://app.teaixio",
    "https://teai.io.evil.example",
    "https://teai.io\n",
    "https://teai.io/sente/app",
    "http://localhost:3000@evil.example",
    "http://127.0.0.1:3000@evil.example",
    "oc://renderer.evil.example",
    "oc://renderer@evil.example",
  ])("rejects lookalike or malformed origin %s", (origin) => {
    expect(isAllowedCorsOrigin(origin)).toBe(false)
    expect(isAllowedRequestOrigin(origin, "localhost:4096")).toBe(false)
  })

  test("allows same-origin requests and explicit custom origins", () => {
    expect(isAllowedRequestOrigin("https://private.example:4096", "private.example:4096")).toBe(true)
    expect(isAllowedCorsOrigin("https://custom.example", { cors: ["https://custom.example"] })).toBe(true)
    expect(isAllowedCorsOrigin(undefined)).toBe(true)
  })

  test.each(["https://user@private.example", "https://private.example/path", "ftp://private.example"])(
    "does not treat malformed origins as same-origin: %s",
    (origin) => expect(isAllowedRequestOrigin(origin, "private.example")).toBe(false),
  )
})

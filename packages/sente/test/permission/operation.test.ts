import { expect, test } from "bun:test"
import { McpApproval } from "../../src/mcp/approval"

test("operation preview binds a detached payload and redacts credential fields", () => {
  const args = { url: "https://example.invalid/send?access_token=dummy", body: { text: "hello", token: "dummy" } }
  const operation = McpApproval.prepare("playwright_browser_evaluate", args)
  args.body.text = "changed"
  expect(operation.args.body).toEqual({ text: "hello", token: "dummy" })
  expect(operation.request.metadata.operation).toContain("hello")
  expect(operation.request.metadata.operation).not.toContain("dummy")
  expect(operation.request.always).toEqual([])
  expect(operation.request.metadata.fingerprint).not.toBe(McpApproval.prepare("playwright_browser_evaluate", args).request.metadata.fingerprint)
})

test("large operation previews fail closed instead of truncating", () => {
  expect(() => McpApproval.prepare("travel_book", { body: "x".repeat(16001) })).toThrow("exceeds")
  expect(() => McpApproval.prepare("travel_book", { token: "x".repeat(16001) })).toThrow("exceeds")
})

test("terminal controls and bidi formatting are escaped in the approval preview", () => {
  const preview = McpApproval.prepare("playwright_send", { text: "a\u009b\u202eb\u001b[2J" }).request.metadata.operation
  expect(preview).not.toContain("\u009b")
  expect(preview).not.toContain("\u202e")
  expect(preview).not.toContain("\u001b")
  expect(preview).toContain("\\u202e")
})

test("unrelated MCP permissions retain their existing behavior", () => {
  const input = { city: "Tokyo" }
  expect(McpApproval.prepare("weather_current", input).args).toBe(input)
  expect(McpApproval.prepare("weather_current", { city: "Tokyo" }).request).toEqual({
    permission: "weather_current", metadata: {}, patterns: ["*"], always: ["*"],
  })
})

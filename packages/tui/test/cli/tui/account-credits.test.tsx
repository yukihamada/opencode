import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import type { Provider } from "@sente-ai/sdk/v2"
import type { TuiPluginApi, TuiSlotPlugin } from "@sente-ai/plugin/tui"
import plugin from "../../../src/feature-plugins/sidebar/credits"
import { creditAccount, fetchAccountCredits, formatCreditAmount } from "../../../src/util/account-credits"
import { createTuiPluginApi } from "../../fixture/tui-plugin"

test("credit amounts show USD equivalents at the top-up rate in both languages", () => {
  for (const language of ["ja", "en"]) {
    expect(formatCreditAmount(97898, language)).toBe("97,898 cr (≈$108.78)")
    expect(formatCreditAmount(44054538, language)).toBe("44,054,538 cr (≈$48,949.49)")
    expect(formatCreditAmount(0, language)).toBe("0 cr (≈$0.00)")
    expect(formatCreditAmount(0.41, language, "USD")).toBe("$0.41 (≈369 cr)")
    expect(formatCreditAmount(0.0001, language, "USD")).toBe("$0.00 (≈0.09 cr)")
  }
})

function provider(baseURL: string): Provider {
  return { id: "teai", name: "teai", source: "api", env: [], key: "test-only", options: { baseURL }, models: {} }
}

test("account endpoint uses resolved credentials and provider origin", () => {
  expect(creditAccount(provider("https://api.teai.io/v1"))).toEqual({ key: "test-only", url: "https://api.teai.io/api/v1/auth/me" })
  expect(creditAccount({ ...provider("https://teai.io/v1"), options: { apiKey: "configured" } })?.key).toBe("configured")
  expect(creditAccount(provider("http://remote.invalid/v1"))).toBeUndefined()
  expect(creditAccount(provider("https://user:password@example.com"))).toBeUndefined()
  expect(creditAccount({ ...provider("https://api.teai.io"), key: undefined })).toBeUndefined()
  expect(creditAccount(undefined)).toBeUndefined()
})

test("invalid, unauthenticated and redirected responses never become zero balances", async () => {
  let body: unknown = { authenticated: false }
  let redirect = false
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => redirect
    ? Response.redirect("https://example.com", 302)
    : Response.json(body) })
  try {
    const account = creditAccount(provider(server.url.href))!
    const signal = new AbortController().signal
    await expect(fetchAccountCredits(account, signal)).rejects.toThrow()
    body = { authenticated: true, credits_remaining: "100", credits_used: 2 }
    await expect(fetchAccountCredits(account, signal)).rejects.toThrow()
    body = { authenticated: true, credits_remaining: 0, credits_used: 1234 }
    expect(await fetchAccountCredits(account, signal)).toEqual({ remaining: 0, used: 1234 })
    redirect = true
    await expect(fetchAccountCredits(account, signal)).rejects.toThrow()
  } finally {
    await server.stop(true)
  }
})

test("sidebar renders live account totals, refreshes on idle and shows failures", async () => {
  let remaining = 12345
  let used = 6789
  let fail = false
  let requests = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    expect(new URL(request.url).pathname).toBe("/api/v1/auth/me")
    expect(request.headers.get("Authorization")).toBe("Bearer test-only")
    requests++
    return fail ? new Response("unavailable", { status: 503 })
      : Response.json({ authenticated: true, credits_remaining: remaining, credits_used: used })
  } })
  let idle = () => {}
  let removed = false
  const event = { on(type, handler) {
    expect(String(type)).toBe("session.status")
    idle = () => handler({ type: "session.status", properties: { sessionID: "session", status: { type: "idle" } } } as never)
    return () => { removed = true }
  } } as TuiPluginApi["event"]
  const api = createTuiPluginApi({ event })
  Object.defineProperty(api.state, "provider", { value: [provider(server.url.href)] })
  let view!: () => JSX.Element
  api.slots = { register(input: TuiSlotPlugin) {
    view = () => input.slots!.sidebar_content!({ theme: api.theme }, { session_id: "session" })
    return "credits-test"
  } }
  await plugin.tui(api, undefined, {
    id: plugin.id, source: "internal", spec: plugin.id, target: plugin.id,
    first_time: 0, last_time: 0, time_changed: 0, load_count: 1, fingerprint: "test", state: "first",
  })
  const app = await testRender(() => view(), { width: 38, height: 8 })
  async function frameContains(value: string) {
    for (let i = 0; i < 100; i++) {
      await app.renderOnce()
      if (app.captureCharFrame().includes(value)) return
      await Bun.sleep(10)
    }
    expect(app.captureCharFrame()).toContain(value)
  }
  try {
    await frameContains("12,345 cr (≈$13.72)")
    const ja = (process.env.TE_LANG || process.env.LC_ALL || process.env.LANG || "en").startsWith("ja")
    expect(app.captureCharFrame()).not.toContain("6,789 cr")
    remaining = 0
    used = 19134
    idle()
    await frameContains("0 cr (≈$0.00)")
    fail = true
    idle()
    await frameContains(ja ? "未確認" : "Unavailable")
    expect(app.captureCharFrame()).not.toContain("19,134 cr")
    expect(requests).toBe(3)
  } finally {
    app.renderer.destroy()
    expect(removed).toBe(true)
    await server.stop(true)
  }
})

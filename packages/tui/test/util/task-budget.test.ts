import { afterEach, expect, test } from "bun:test"
import { TaskBudget } from "../../src/util/task-budget"
import { cardText } from "../../src/util/task-budget-text"

const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(() => { servers.splice(0).forEach((server) => server.stop(true)) })

function fixture() {
  const clock = { now: 1_791_331_200_000 }
  const card: TaskBudget.Card = {
    goal: "Write a greeting", criteria: ["Contains hello"], scope: ["Text only"], prohibited: ["Sending"],
    stop_conditions: ["Budget limit"], session_id: "session", price_version: "fixture", run_limit: 9000,
    month_limit: 9000, duration_ms: 600000, interval_ms: 60000, first_at: clock.now, expires_at: clock.now + 3600000,
  }
  const task: TaskBudget.Task = { id: crypto.randomUUID(), card, state: "ready", next_at: clock.now, spent: 0, reserved: 0, month_spent: 0, month_reserved: 0 }
  const run: TaskBudget.Run = { id: crypto.randomUUID(), task_id: task.id, due_at: clock.now, deadline: clock.now + 600000,
    executor: "sente", estimate: 4, state: "running", reason: null, spent: 0, reserved: 0, evidence: [] }
  const calls: { path: string; method: string; auth: string | null; body: unknown }[] = []
  const state = { runs: [] as TaskBudget.Run[], fail: false, protected: false }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    calls.push({ path, method: req.method, auth: req.headers.get("Authorization"), body: req.method === "POST" ? await req.json() : null })
    if (path.endsWith("/generate")) {
      if (state.fail) return Response.json({ error: "charge_unknown" }, { status: 503 })
      run.state = "waiting"
      run.reason = "verification_required"
      return Response.json({ charged: 1 })
    }
    if (path.endsWith("/claim")) { state.runs = [run]; return Response.json(run) }
    if (path.endsWith("/history")) return Response.json(state.runs)
    if (path.endsWith("/tasks") && req.method === "GET") return Response.json([task])
    if (path.endsWith("/tasks")) return Response.json({ id: task.id, approved: true })
    return Response.json({})
  } })
  servers.push(server)
  const options = { api: server.url.toString(), now: () => clock.now, readKey: async () => "te_fixture", protected: () => state.protected }
  const client = TaskBudget.create(options)
  return { clock, card, task, run, calls, state, client, options }
}

test("API key can read but cannot approve; owner session expires and never persists", async () => {
  const f = fixture()
  await f.client.list("session")
  expect(f.calls[0].auth).toBe("Bearer te_fixture")
  const approval = { id: f.task.id, approval_id: crypto.randomUUID(), card: f.card }
  await expect(f.client.approve("session", approval)).rejects.toThrow("owner_session_required")
  expect(f.calls).toHaveLength(1)
  expect(() => f.client.login("te_fixture", "session")).toThrow("owner_session_required")
  f.client.login("owner-fixture", "session")
  await f.client.approve("session", approval)
  expect(f.calls[1].auth).toBe("Bearer owner-fixture")
  expect(f.calls[1].body).toEqual(approval)
  expect(f.client.isArmed(f.task.id)).toBe(true)
  expect(TaskBudget.create(f.options).authorized("session")).toBe(false)
  f.clock.now += 900000
  expect(f.client.authorized("session")).toBe(false)
  expect(f.client.isArmed(f.task.id)).toBe(false)
})

test("session switch and protected mode revoke execution", async () => {
  const f = fixture()
  f.client.login("owner-fixture", "session")
  f.client.arm("session", f.task)
  expect(f.client.authorized("another-session")).toBe(false)
  await f.client.tick("session", () => {})
  expect(f.calls).toHaveLength(0)
  f.client.login("owner-fixture", "session")
  f.state.protected = true
  await expect(f.client.list("session")).rejects.toThrow("protected_mode")
  expect(f.client.authorized("session")).toBe(false)
  expect(f.calls).toHaveLength(0)
})

test("overlapping ticks dispatch once and recurring jobs wait for verification", async () => {
  const f = fixture()
  f.client.login("owner-fixture", "session")
  f.client.arm("session", f.task)
  const notices: unknown[] = []
  await Promise.all([f.client.tick("session", (_, error) => notices.push(error)), f.client.tick("session", (_, error) => notices.push(error))])
  expect(f.calls.filter((c) => c.path.endsWith("/generate"))).toHaveLength(1)
  expect(notices).toEqual([undefined])
  f.clock.now += 60000
  await f.client.tick("session", () => {})
  expect(f.calls.filter((c) => c.path.endsWith("/claim"))).toHaveLength(1)
  f.run.state = "completed"
  await f.client.tick("session", () => {})
  expect(f.calls.filter((c) => c.path.endsWith("/claim"))).toHaveLength(2)
})

test("uncertain generation disarms and cannot automatically retry", async () => {
  const f = fixture()
  f.client.login("owner-fixture", "session")
  f.client.arm("session", f.task)
  f.state.fail = true
  const notices: unknown[] = []
  await f.client.tick("session", (_, error) => notices.push(error))
  expect(notices[0]).toBeInstanceOf(TaskBudget.TaskError)
  expect(f.client.isArmed(f.task.id)).toBe(false)
  await f.client.tick("session", () => {})
  expect(f.calls.filter((c) => c.path.endsWith("/generate"))).toHaveLength(1)
})

test("zero, exact cents and unsafe amounts remain distinct", () => {
  expect(TaskBudget.credits("0", 900)).toBe(0)
  expect(TaskBudget.credits("10.01", 900)).toBe(9009)
  for (const input of ["-1", "NaN", "1e2", "1.001", "99999999999999999999"]) {
    expect(() => TaskBudget.credits(input, 900)).toThrow("invalid_amount")
  }
})

test("confirmation snapshot exposes limits, price, session and execution boundaries in both languages", () => {
  const f = fixture()
  for (const locale of ["ja", "en"]) {
    const text = cardText(f.card, locale)
    for (const value of ["Write a greeting", "Contains hello", "session", "fixture", "9,000"]) expect(text).toContain(value)
    expect(text).toContain(locale === "ja" ? "15分" : "15 minutes")
  }
})

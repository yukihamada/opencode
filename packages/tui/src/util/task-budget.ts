export * as TaskBudget from "./task-budget"

import { apiBase, credentialsPath, parseCredentials, type Fetcher } from "./teai"

export type Card = {
  goal: string
  criteria: string[]
  scope: string[]
  prohibited: string[]
  stop_conditions: string[]
  session_id: string
  price_version: string
  run_limit: number
  month_limit: number
  duration_ms: number
  interval_ms: number | null
  first_at: number
  expires_at: number
}
export type Task = {
  id: string
  card: Card
  state: string
  next_at: number
  spent: number
  reserved: number
  month_spent: number
  month_reserved: number
}
export type Run = {
  id: string
  task_id: string
  due_at: number
  deadline: number
  executor: string
  estimate: number
  state: string
  reason: string | null
  spent: number
  reserved: number
  evidence: string[]
}
export type Pricing = {
  price_version: string
  currency: string
  credits_per_usd: number
  default_run_limit: number
  models: string[]
  max_output_tokens: number
}
export type Result = { call_id: string; charged: number; response: { choices?: { message?: { content?: string } }[] } | null }
export type Approval = { id: string; approval_id: string; card: Card }

export class TaskError extends Error {
  constructor(readonly code: string) { super(code) }
}

/** UI-owned credentials and armed jobs never enter env, provider auth or disk. */
export function create(opts: {
  api?: string
  fetch?: Fetcher
  now?: () => number
  readKey?: () => Promise<string | undefined>
  protected?: () => boolean
} = {}) {
  const now = opts.now ?? Date.now
  const base = (opts.api ?? apiBase()).replace(/\/+$/, "")
  const url = new URL(base)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
    throw new TaskError("invalid_origin")
  }
  if (url.username || url.password || url.search || url.hash) throw new TaskError("invalid_origin")
  const state = { owner: undefined as { token: string; session: string; until: number } | undefined, busy: false }
  const armed = new Set<string>()
  const blocked = opts.protected ?? (() => Boolean(process.env.SENTE_SCRUB_KEY))
  const readKey = opts.readKey ?? (async () => {
    if (process.env.TEAI_API_KEY) return process.env.TEAI_API_KEY
    return parseCredentials(await Bun.file(credentialsPath()).text().catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw new TaskError("credentials_unavailable")
    }))
  })

  function clear() { state.owner = undefined; armed.clear() }
  function authorized(session: string) {
    if (blocked() || !state.owner || state.owner.until <= now() || state.owner.session !== session) {
      clear()
      return false
    }
    return true
  }
  async function request<T>(path: string, session: string, body?: unknown): Promise<T> {
    if (blocked()) throw new TaskError("protected_mode")
    const owner = authorized(session)
    if (body !== undefined && !owner) throw new TaskError("owner_session_required")
    const token = owner ? state.owner!.token : await readKey()
    if (!token) throw new TaskError("authentication_required")
    // No redirect or automatic retry: a timeout may already have spent credits.
    const response = await (opts.fetch ?? fetch)(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(path.endsWith("/generate") ? 135_000 : 15_000),
    }).catch(() => { throw new TaskError("connection_unknown") })
    const value = await response.json().catch(() => { throw new TaskError("invalid_response") })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) clear()
      throw new TaskError(typeof value?.error === "string" ? value.error : `http_${response.status}`)
    }
    return value as T
  }
  const segment = encodeURIComponent
  const list = (session: string) => request<Task[]>("/api/v1/tasks", session)
  const history = (session: string, id: string) => request<Run[]>(`/api/v1/tasks/${segment(id)}/history`, session)
  const results = (session: string, id: string) => request<Result[]>(`/api/v1/task-runs/${segment(id)}/results`, session)
  async function generate(session: string, task: Task, run: Run, model: string, instruction?: string) {
    if (!authorized(session) || task.card.session_id !== session) throw new TaskError("owner_session_required")
    return request(`/api/v1/task-runs/${segment(run.id)}/generate`, session, {
      call_id: crypto.randomUUID(), model, max_tokens: 4096,
      messages: [{ role: "user", content: JSON.stringify({
        goal: task.card.goal, criteria: task.card.criteria, scope: task.card.scope,
        prohibited: task.card.prohibited, stop_conditions: task.card.stop_conditions,
        instruction: instruction ?? "Produce the requested text. Do not claim external actions or verified completion.",
      }) }],
    })
  }
  async function dispatch(session: string, task: Task, model: string) {
    if (task.card.session_id !== session) throw new TaskError("session_mismatch")
    const run = await request<Run>(`/api/v1/tasks/${segment(task.id)}/claim`, session, { executor: "sente", model })
    if (run.state === "running") await generate(session, task, run, model)
    return run
  }
  return {
    clear, authorized, list, history, results,
    login(token: string, session: string) {
      clear()
      if (blocked() || !session || !token || /^(te_|cw_)/.test(token)) throw new TaskError("owner_session_required")
      state.owner = { token, session, until: now() + 15 * 60_000 }
    },
    pricing: (session: string) => request<Pricing>("/api/v1/tasks/pricing", session),
    async approve(session: string, approval: Approval) {
      if (approval.card.session_id !== session) throw new TaskError("session_mismatch")
      const value = await request<{ id: string; approved: boolean }>("/api/v1/tasks", session, approval)
      if (value.id !== approval.id || value.approved !== true) throw new TaskError("invalid_response")
      if (authorized(session)) armed.add(approval.id)
      return value
    },
    arm(session: string, task: Task) {
      if (!authorized(session) || task.card.session_id !== session) throw new TaskError("owner_session_required")
      armed.add(task.id)
    },
    disarm: (id: string) => armed.delete(id),
    isArmed: (id: string) => armed.has(id),
    async stop(session: string, id: string) {
      armed.delete(id)
      await request(`/api/v1/tasks/${segment(id)}/stop`, session, {})
    },
    confirm: (session: string, run: string, evidence: string[]) => request(`/api/v1/task-runs/${segment(run)}/confirm`, session, { evidence }),
    async resume(session: string, task: Task, run: Run, model: string, instruction: string) {
      if (task.card.session_id !== session) throw new TaskError("session_mismatch")
      await request(`/api/v1/task-runs/${segment(run.id)}/resume`, session, {})
      return generate(session, task, run, model, instruction)
    },
    /** Runs only explicitly armed jobs in this live UI session; never recovers a crashed dispatch. */
    async tick(session: string, notify: (task: Task, error?: unknown) => void) {
      if (!authorized(session) || state.busy || !armed.size) return
      state.busy = true
      try {
        const tasks = await list(session)
        for (const task of tasks) {
          if (!authorized(session)) break
          if (!armed.has(task.id) || task.card.session_id !== session || task.state !== "ready"
            || task.next_at > now() || task.card.expires_at <= now()) continue
          try {
            const runs = await history(session, task.id)
            if (!armed.has(task.id) || runs.some((run) => ["running", "waiting"].includes(run.state))) continue
            await dispatch(session, task, "teai/decision-20b")
            notify(task)
          } catch (error) {
            // Explicit re-arm is required after any uncertain network outcome.
            armed.delete(task.id)
            notify(task, error)
          }
        }
      } finally { state.busy = false }
    },
  }
}
export type Client = ReturnType<typeof create>

export function credits(input: string, rate: number) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(input.trim()) || !Number.isSafeInteger(rate) || rate <= 0) throw new TaskError("invalid_amount")
  const [whole, fraction = ""] = input.trim().split(".")
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
  const scaled = minor * rate
  if (!Number.isSafeInteger(scaled)) throw new TaskError("invalid_amount")
  return Math.ceil(scaled / 100)
}

import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { holdOneShot, LeaseError, leaseDisabled } from "../../../src/cli/cmd/run/runtime.oneshot"
import { ShellBackground } from "../../../src/tool/shell/background"

type Part = Record<string, unknown>

function fakeServer(
  input: {
    metadata?: Record<string, unknown>
    parts?: Part[]
    failUpdates?: number
    skewMs?: number
    /** Replaces the Date/Age headers of GET responses. */
    headers?: Record<string, string>
    failMessages?: boolean
  } = {},
) {
  const state = {
    metadata: { ...input.metadata } as Record<string, unknown>,
    parts: input.parts ?? [],
    // Lets a test hold an update in flight.
    gate: undefined as Promise<void> | undefined,
  }
  const calls = { update: 0, abort: 0, getHeaders: [] as unknown[] }
  let failures = input.failUpdates ?? 0
  const client = {
    session: {
      get: async (_params: unknown, options?: { headers?: unknown }) => {
        calls.getHeaders.push(options?.headers)
        return {
          data: { id: "ses_1", metadata: { ...state.metadata } },
          response: new Response(null, {
            headers: input.headers ?? { date: new Date(Date.now() + (input.skewMs ?? 0)).toUTCString() },
          }),
        }
      },
      update: async (args: { metadata?: Record<string, unknown> }) => {
        calls.update++
        // One-shot: only the update that finds the gate waits on it; later ones go straight through.
        const gate = state.gate
        state.gate = undefined
        if (gate) await gate
        if (failures > 0) {
          failures--
          return { error: "boom" }
        }
        state.metadata = { ...args.metadata }
        return { data: {} }
      },
      abort: async () => {
        calls.abort++
        return { data: true }
      },
      messages: async () =>
        input.failMessages ? { error: "unavailable" } : { data: [{ info: {}, parts: state.parts }] },
    },
  }
  return { state, calls, client: client as never }
}

const signals = () => {
  const emitter = new EventEmitter()
  const killed: string[] = []
  return {
    killed,
    emitter,
    signals: {
      on: (event: string, fn: (signal: NodeJS.Signals) => void) => emitter.on(event, fn),
      off: (event: string, fn: (signal: NodeJS.Signals) => void) => emitter.off(event, fn),
      kill: (_pid: number, signal: string) => void killed.push(signal),
      pid: 1,
    } as never,
  }
}

const bash = (jobId: string, run?: string): Part => ({
  type: "tool",
  tool: "bash",
  state: {
    status: "completed",
    metadata: { background: true, jobId, ...(run ? { run } : {}) },
    time: { start: 0, end: 0 },
  },
})
const waited = (jobId: string, status: string): Part => ({
  type: "tool",
  tool: "wait",
  state: { status: "completed", metadata: { jobId, status }, time: { start: 0, end: 0 } },
})
const lease = (server: ReturnType<typeof fakeServer>) =>
  server.state.metadata[ShellBackground.ONE_SHOT] as ShellBackground.Lease | undefined

describe("sente run --attach one-shot lease", () => {
  test("leases only its own key and removes it again, keeping other metadata", async () => {
    const server = fakeServer({ metadata: { other: "keep" } })
    const hold = await holdOneShot({
      client: server.client,
      sessionID: "ses_1",
      owned: true,
      warn: () => {},
      signals: signals().signals,
    })
    expect(server.state.metadata.other).toBe("keep")
    expect(ShellBackground.live(lease(server))).toBe(true)
    server.state.metadata.later = 1
    await hold.release()
    expect(server.state.metadata).toEqual({ other: "keep", later: 1 })
    expect(server.calls.abort).toBe(0)
  })

  test("renews the lease while the run lives, and stops renewing after release", async () => {
    const server = fakeServer()
    const hold = await holdOneShot({
      client: server.client,
      sessionID: "ses_1",
      owned: true,
      warn: () => {},
      signals: signals().signals,
      renewMs: 20,
    })
    const first = lease(server)!.until
    await Bun.sleep(80)
    expect(lease(server)!.until).toBeGreaterThanOrEqual(first)
    expect(server.calls.update).toBeGreaterThan(1)
    await hold.release()
    const updates = server.calls.update
    await Bun.sleep(60)
    expect(server.calls.update).toBe(updates)
    expect(lease(server)).toBeUndefined()
  })

  test("a renewal still in flight at release cannot bring the lease back", async () => {
    const server = fakeServer()
    const hold = await holdOneShot({
      client: server.client,
      sessionID: "ses_1",
      owned: true,
      warn: () => {},
      signals: signals().signals,
      renewMs: 10,
    })
    let open = () => {}
    server.state.gate = new Promise<void>((resolve) => (open = resolve))
    await Bun.sleep(30) // a renewal is now blocked inside update()
    const releasing = hold.release()
    // Without the write chain the removal would land now, and the stale renewal after it.
    await Bun.sleep(10)
    open()
    await releasing
    await Bun.sleep(30)
    expect(lease(server)).toBeUndefined()
  })

  test.each([5 * 60_000, -5 * 60_000])("the expiry follows the server clock (skew %d ms)", async (skewMs) => {
    const server = fakeServer({ skewMs })
    const hold = await holdOneShot({
      client: server.client,
      sessionID: "ses_1",
      owned: true,
      warn: () => {},
      signals: signals().signals,
    })
    const serverNow = Date.now() + skewMs
    const until = lease(server)!.until
    expect(Math.abs(until - (serverNow + ShellBackground.LEASE_MS))).toBeLessThan(2_000)
    // Judged on the server: live now, gone once the lease time has passed there.
    expect(ShellBackground.mustWait({ metadata: server.state.metadata }, {}, serverNow)).toBe(true)
    expect(
      ShellBackground.mustWait({ metadata: server.state.metadata }, {}, serverNow + ShellBackground.LEASE_MS + 2_000),
    ).toBe(false)
    await hold.release()
  })

  test("Ctrl-C drops the lease before the signal goes through", async () => {
    const server = fakeServer()
    const sig = signals()
    await holdOneShot({ client: server.client, sessionID: "ses_1", owned: false, warn: () => {}, signals: sig.signals })
    sig.emitter.emit("SIGINT", "SIGINT")
    await Bun.sleep(20)
    expect(lease(server)).toBeUndefined()
    expect(sig.killed).toEqual(["SIGINT"])
  })

  test("in a session it made, a background command never collected is stopped by aborting", async () => {
    const server = fakeServer({ parts: [bash("job_b"), waited("job_b", "completed")] })
    const hold = await holdOneShot({
      client: server.client,
      sessionID: "ses_1",
      owned: true,
      warn: () => {},
      signals: signals().signals,
    })
    server.state.parts.push(bash("job_a"))
    await hold.release()
    expect(server.calls.abort).toBe(1)
  })

  test("in a session it joined (-s/-c), it never aborts and names only the jobs this run started", async () => {
    const warnings: string[] = []
    const server = fakeServer({ parts: [bash("job_old")] })
    const hold = await holdOneShot({
      client: server.client,
      sessionID: "ses_1",
      owned: false,
      warn: (text) => void warnings.push(text),
      signals: signals().signals,
    })
    const run = lease(server)!.id
    // Another client (a TUI, another run) starts jobs in the same session meanwhile.
    server.state.parts.push(bash("job_mine", run), bash("job_tui"), bash("job_other_run", "run_other"))
    await hold.release()
    expect(server.calls.abort).toBe(0)
    const text = warnings.join("\n")
    expect(text).toContain("job_mine")
    for (const other of ["job_old", "job_tui", "job_other_run"]) expect(text).not.toContain(other)
  })

  test("with nothing left running it does nothing", async () => {
    const server = fakeServer()
    const hold = await holdOneShot({
      client: server.client,
      sessionID: "ses_1",
      owned: true,
      warn: () => {},
      signals: signals().signals,
    })
    server.state.parts.push(bash("job_a"), waited("job_a", "completed"))
    await hold.release()
    await hold.release()
    expect(server.calls.abort).toBe(0)
  })

  test("a lease that fails once is retried", async () => {
    const server = fakeServer({ failUpdates: 1 })
    const hold = await holdOneShot({
      client: server.client,
      sessionID: "ses_1",
      owned: true,
      warn: () => {},
      signals: signals().signals,
    })
    expect(ShellBackground.live(lease(server))).toBe(true)
    await hold.release()
  })

  test("a lease that keeps failing stops the run with LeaseError and leaves no handlers", async () => {
    const server = fakeServer({ failUpdates: 2 })
    const sig = signals()
    const result = await holdOneShot({
      client: server.client,
      sessionID: "ses_1",
      owned: true,
      warn: () => {},
      signals: sig.signals,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(result).toBeInstanceOf(LeaseError)
    expect(String(result)).toContain("could not mark the session as a one-shot run")
    expect(sig.emitter.listenerCount("SIGINT")).toBe(0)
    expect(server.calls.abort).toBe(0)
  })

  test("reads the session uncached", async () => {
    const server = fakeServer()
    const hold = await holdOneShot({
      client: server.client,
      sessionID: "ses_1",
      owned: true,
      warn: () => {},
      signals: signals().signals,
    })
    expect(server.calls.getHeaders[0]).toEqual({ "cache-control": "no-store" })
    await hold.release()
  })

  test("no Date header: warns once and uses this machine's clock", async () => {
    const warnings: string[] = []
    const server = fakeServer({ headers: {} })
    const hold = await holdOneShot({
      client: server.client,
      sessionID: "ses_1",
      owned: true,
      warn: (text) => void warnings.push(text),
      signals: signals().signals,
    })
    await hold.release()
    expect(warnings.filter((text) => text.includes("no Date header"))).toHaveLength(1)
  })

  test("a cached (Age) or far-off Date is accounted for and reported", async () => {
    const warnings: string[] = []
    const stale = new Date(Date.now() - 2 * 24 * 3_600_000)
    const server = fakeServer({ headers: { date: stale.toUTCString(), age: "60" } })
    const hold = await holdOneShot({
      client: server.client,
      sessionID: "ses_1",
      owned: true,
      warn: (text) => void warnings.push(text),
      signals: signals().signals,
    })
    const until = lease(server)!.until
    // Date + Age + lease time, on the (reported) server clock.
    expect(Math.abs(until - (stale.getTime() + 60_000 + ShellBackground.LEASE_MS))).toBeLessThan(3_000)
    expect(warnings.join("\n")).toContain("server clock differs")
    await hold.release()
  })

  test("two renewals failing in a row are reported once", async () => {
    const warnings: string[] = []
    const server = fakeServer()
    const hold = await holdOneShot({
      client: server.client,
      sessionID: "ses_1",
      owned: true,
      warn: (text) => void warnings.push(text),
      signals: signals().signals,
      renewMs: 15,
    })
    const update = server.client as unknown as { session: { update: (args: unknown) => Promise<unknown> } }
    const real = update.session.update
    update.session.update = async () => ({ error: "down" })
    await Bun.sleep(100)
    update.session.update = real
    await hold.release()
    expect(warnings.filter((text) => text.includes("could not renew"))).toHaveLength(1)
  })

  test("if its own session's messages cannot be read, it warns and stops the session to be safe", async () => {
    const warnings: string[] = []
    const server = fakeServer({ failMessages: true })
    const hold = await holdOneShot({
      client: server.client,
      sessionID: "ses_1",
      owned: true,
      warn: (text) => void warnings.push(text),
      signals: signals().signals,
    })
    await hold.release()
    expect(warnings.join("\n")).toContain("could not check for background commands")
    expect(server.calls.abort).toBe(1)
  })

  test("in a joined session an unreadable message list only warns", async () => {
    const warnings: string[] = []
    const server = fakeServer({ failMessages: true })
    const hold = await holdOneShot({
      client: server.client,
      sessionID: "ses_1",
      owned: false,
      warn: (text) => void warnings.push(text),
      signals: signals().signals,
    })
    await hold.release()
    expect(warnings.join("\n")).toContain("could not check for background commands")
    expect(server.calls.abort).toBe(0)
  })
})

describe("SENTE_SHELL_TIMEOUT_BACKGROUND=0 on the client skips the lease", () => {
  test.each([
    ["0", true],
    ["false", true],
    ["off", true],
    ["1", false],
    ["", false],
    [undefined, false],
  ])("%p → %p", (value, disabled) => {
    expect(leaseDisabled(value === undefined ? {} : { SENTE_SHELL_TIMEOUT_BACKGROUND: value })).toBe(disabled)
  })
})

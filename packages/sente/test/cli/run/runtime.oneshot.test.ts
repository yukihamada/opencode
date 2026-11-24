import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { holdOneShot, LeaseError, leaseDisabled, type HoldInput } from "../../../src/cli/cmd/run/runtime.oneshot"
import { ShellBackground } from "../../../src/tool/shell/background"

type Part = Record<string, unknown>
type Message = { info: Record<string, unknown>; parts: Part[] }

const TURN = "msg_run_turn"

function fakeServer(
  input: {
    metadata?: Record<string, unknown>
    messages?: Message[]
    failUpdates?: number
    skewMs?: number
    /** Replaces the Date/Age headers of GET responses. */
    headers?: Record<string, string>
    failMessages?: boolean
    /** Delay inside update(), so concurrent read-modify-writes interleave. */
    updateDelayMs?: number
    /** Another writer keeps dropping our lease entry. */
    dropLease?: boolean
  } = {},
) {
  const state = {
    metadata: { ...input.metadata } as Record<string, unknown>,
    messages: input.messages ?? [],
    // Lets a test hold one update in flight.
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
        if (input.updateDelayMs) await Bun.sleep(input.updateDelayMs)
        if (failures > 0) {
          failures--
          return { error: "boom" }
        }
        state.metadata = { ...args.metadata }
        if (input.dropLease) delete state.metadata[ShellBackground.ONE_SHOT]
        return { data: {} }
      },
      abort: async () => {
        calls.abort++
        return { data: true }
      },
      messages: async () => (input.failMessages ? { error: "unavailable" } : { data: state.messages }),
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

const hold = (server: ReturnType<typeof fakeServer>, extra: Partial<HoldInput> = {}) =>
  holdOneShot({
    client: server.client,
    sessionID: "ses_1",
    owned: true,
    message: TURN,
    warn: () => {},
    signals: signals().signals,
    settleMs: 5,
    ...extra,
  })

/** A user message: sent by a person/run, or added by the server (all parts synthetic / compaction). */
const user = (id: string, kind: "sent" | "continue" | "compaction" = "sent"): Message => ({
  info: { id, role: "user" },
  parts:
    kind === "compaction"
      ? [{ type: "compaction", auto: true }]
      : [
          {
            type: "text",
            text: kind === "sent" ? "do it" : "Continue",
            ...(kind === "continue" ? { synthetic: true } : {}),
          },
        ],
})
/** An assistant reply in the turn answering `parent`, with the given parts. */
const reply = (parent: string, ...parts: Part[]): Message => ({ info: { role: "assistant", parentID: parent }, parts })
const bash = (jobId: string): Part => ({
  type: "tool",
  tool: "bash",
  state: { status: "completed", metadata: { background: true, jobId }, time: { start: 0, end: 0 } },
})
const waited = (jobId: string, status: string): Part => ({
  type: "tool",
  tool: "wait",
  state: { status: "completed", metadata: { jobId, status }, time: { start: 0, end: 0 } },
})
const entries = (server: ReturnType<typeof fakeServer>) =>
  Object.values(ShellBackground.leases({ metadata: server.state.metadata })) as ShellBackground.Lease[]
const lease = (server: ReturnType<typeof fakeServer>) => entries(server)[0]

describe("sente run --attach one-shot lease", () => {
  test("leases only its own entry (naming its message) and removes it again, keeping other metadata", async () => {
    const server = fakeServer({ metadata: { other: "keep" } })
    const held = await hold(server)
    expect(server.state.metadata.other).toBe("keep")
    expect(lease(server).message).toBe(TURN)
    expect(ShellBackground.live(lease(server))).toBe(true)
    server.state.metadata.later = 1
    await held.release()
    expect(server.state.metadata).toEqual({ other: "keep", later: 1 })
    expect(server.calls.abort).toBe(0)
  })

  test("two runs on the same session keep separate leases; the first to finish leaves the other's", async () => {
    const server = fakeServer()
    const first = await hold(server, { owned: false, message: "msg_first" })
    const second = await hold(server, { owned: false, message: "msg_second" })
    expect(
      entries(server)
        .map((entry) => entry.message)
        .toSorted(),
    ).toEqual(["msg_first", "msg_second"])
    await first.release()
    expect(entries(server).map((entry) => entry.message)).toEqual(["msg_second"])
    // Only the second run's turn is one-shot now.
    expect(ShellBackground.mustWait({ metadata: server.state.metadata }, "msg_second", {})).toBe(true)
    expect(ShellBackground.mustWait({ metadata: server.state.metadata }, "msg_first", {})).toBe(false)
    await second.release()
    expect(server.state.metadata[ShellBackground.ONE_SHOT]).toBeUndefined()
  })

  test("two runs releasing at the same moment both end up removed (no resurrected lease)", async () => {
    const server = fakeServer({ updateDelayMs: 20 })
    const first = await hold(server, { owned: false, message: "msg_first" })
    const second = await hold(server, { owned: false, message: "msg_second" })
    expect(entries(server)).toHaveLength(2)
    // Both read before either writes: without re-checking, one write brings the other's entry back.
    await Promise.all([first.release(), second.release()])
    expect(entries(server)).toHaveLength(0)
  })

  test("two runs taking the lease at the same moment both hold one", async () => {
    const server = fakeServer({ updateDelayMs: 20 })
    const [first, second] = await Promise.all([
      hold(server, { owned: false, message: "msg_first" }),
      hold(server, { owned: false, message: "msg_second" }),
    ])
    expect(
      entries(server)
        .map((entry) => entry.message)
        .toSorted(),
    ).toEqual(["msg_first", "msg_second"])
    await first.release()
    await second.release()
  })

  test("a TUI turn in a session with a live lease stays interactive", async () => {
    const server = fakeServer()
    const held = await hold(server, { owned: false })
    expect(ShellBackground.mustWait({ metadata: server.state.metadata }, TURN, {})).toBe(true)
    expect(ShellBackground.mustWait({ metadata: server.state.metadata }, "msg_tui", {})).toBe(false)
    expect(ShellBackground.turnRun({ metadata: server.state.metadata }, "msg_tui")).toBeUndefined()
    await held.release()
  })

  test("renews the lease while the run lives, and stops renewing after release", async () => {
    const server = fakeServer()
    const held = await hold(server, { renewMs: 20 })
    const first = lease(server).until
    const writes = server.calls.update
    // Wait for a renewal (polled, not a fixed sleep, so a loaded machine does not flake it).
    for (let i = 0; i < 200 && server.calls.update <= writes; i++) await Bun.sleep(10)
    expect(server.calls.update).toBeGreaterThan(writes)
    expect(lease(server).until).toBeGreaterThanOrEqual(first)
    await held.release()
    const updates = server.calls.update
    await Bun.sleep(100)
    expect(server.calls.update).toBe(updates)
    expect(entries(server)).toHaveLength(0)
  })

  test("a renewal still in flight at release cannot bring the lease back", async () => {
    const server = fakeServer()
    const held = await hold(server, { renewMs: 10 })
    let open = () => {}
    server.state.gate = new Promise<void>((resolve) => (open = resolve))
    await Bun.sleep(30) // a renewal is now blocked inside update()
    const releasing = held.release()
    // Without the write chain the removal would land now, and the stale renewal after it.
    await Bun.sleep(10)
    open()
    await releasing
    await Bun.sleep(30)
    expect(entries(server)).toHaveLength(0)
  })

  test.each([5 * 60_000, -5 * 60_000])("the expiry follows the server clock (skew %d ms)", async (skewMs) => {
    const server = fakeServer({ skewMs })
    const held = await hold(server)
    const serverNow = Date.now() + skewMs
    expect(Math.abs(lease(server).until - (serverNow + ShellBackground.LEASE_MS))).toBeLessThan(2_000)
    const session = { metadata: server.state.metadata }
    expect(ShellBackground.mustWait(session, TURN, {}, serverNow)).toBe(true)
    expect(ShellBackground.mustWait(session, TURN, {}, serverNow + ShellBackground.LEASE_MS + 2_000)).toBe(false)
    await held.release()
  })

  test("Ctrl-C drops the lease before the signal goes through", async () => {
    const server = fakeServer()
    const sig = signals()
    await hold(server, { owned: false, signals: sig.signals })
    sig.emitter.emit("SIGINT", "SIGINT")
    await Bun.sleep(20)
    expect(entries(server)).toHaveLength(0)
    expect(sig.killed).toEqual(["SIGINT"])
  })

  test("in a session it made, a background command never collected is stopped by aborting", async () => {
    const server = fakeServer({
      messages: [user("msg_old"), reply("msg_old", bash("job_b"), waited("job_b", "completed"))],
    })
    const held = await hold(server)
    server.state.messages.push(user(TURN), reply(TURN, bash("job_a")))
    await held.release()
    expect(server.calls.abort).toBe(1)
  })

  test("in a session it joined (-s/-c), it never aborts and names only its own turn's jobs", async () => {
    const warnings: string[] = []
    const server = fakeServer({ messages: [user("msg_old"), reply("msg_old", bash("job_old"))] })
    const held = await hold(server, { owned: false, warn: (text) => void warnings.push(text) })
    // A TUI turn starts jobs in the same session meanwhile.
    server.state.messages.push(
      user(TURN),
      reply(TURN, bash("job_mine")),
      user("msg_tui"),
      reply("msg_tui", bash("job_tui")),
    )
    const result = await held.release()
    expect(result.unfinished).toEqual(["job_mine"])
    expect(server.calls.abort).toBe(0)
    const text = warnings.join("\n")
    expect(text).toContain("job_mine")
    for (const other of ["job_old", "job_tui"]) expect(text).not.toContain(other)
  })

  test.each(["continue", "compaction"] as const)(
    "jobs after a server-added %s message still count as this run's turn",
    async (kind) => {
      const warnings: string[] = []
      const server = fakeServer()
      const held = await hold(server, { owned: false, warn: (text) => void warnings.push(text) })
      server.state.messages.push(
        user(TURN),
        reply(TURN, bash("job_before")),
        user("msg_auto", kind),
        ...(kind === "compaction" ? [user("msg_auto_continue", "continue")] : []),
        reply("msg_auto", bash("job_after")),
        user("msg_tui"),
        reply("msg_tui", bash("job_tui")),
      )
      const result = await held.release()
      expect(result.unfinished.toSorted()).toEqual(["job_after", "job_before"])
      expect(server.calls.abort).toBe(0)
    },
  )

  test("in its own session it stops leftovers, says so, and still reports them unfinished", async () => {
    const warnings: string[] = []
    const server = fakeServer()
    const held = await hold(server, { warn: (text) => void warnings.push(text) })
    server.state.messages.push(user(TURN), reply(TURN, bash("job_a")))
    expect((await held.release()).unfinished).toEqual(["job_a"])
    expect(server.calls.abort).toBe(1)
    expect(warnings.join("\n")).toContain("stopped 1 background command(s)")
  })

  test("a lease that never sticks (overwritten each time) stops the run with LeaseError", async () => {
    const server = fakeServer({ dropLease: true })
    const result = await hold(server).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(result).toBeInstanceOf(LeaseError)
    expect(String(result)).toContain("did not stick")
  })

  test("with nothing left running it does nothing", async () => {
    const server = fakeServer()
    const held = await hold(server)
    server.state.messages.push(user(TURN), reply(TURN, bash("job_a"), waited("job_a", "completed")))
    await held.release()
    await held.release()
    expect(server.calls.abort).toBe(0)
  })

  test("a lease that fails once is retried", async () => {
    const server = fakeServer({ failUpdates: 1 })
    const held = await hold(server)
    expect(ShellBackground.live(lease(server))).toBe(true)
    await held.release()
  })

  test("a lease that keeps failing stops the run with LeaseError and leaves no handlers", async () => {
    const server = fakeServer({ failUpdates: 2 })
    const sig = signals()
    const result = await hold(server, { signals: sig.signals }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(result).toBeInstanceOf(LeaseError)
    expect(String(result)).toContain("could not mark the session as a one-shot run")
    expect(sig.emitter.listenerCount("SIGINT")).toBe(0)
  })

  test("reads the session uncached", async () => {
    const server = fakeServer()
    const held = await hold(server)
    expect(server.calls.getHeaders[0]).toEqual({ "cache-control": "no-store" })
    await held.release()
  })

  test("no Date header: warns once and uses this machine's clock", async () => {
    const warnings: string[] = []
    const server = fakeServer({ headers: {} })
    const held = await hold(server, { warn: (text) => void warnings.push(text) })
    await held.release()
    expect(warnings.filter((text) => text.includes("no Date header"))).toHaveLength(1)
  })

  test("a cached (Age) or far-off Date is accounted for and reported", async () => {
    const warnings: string[] = []
    const stale = new Date(Date.now() - 2 * 24 * 3_600_000)
    const server = fakeServer({ headers: { date: stale.toUTCString(), age: "60" } })
    const held = await hold(server, { warn: (text) => void warnings.push(text) })
    expect(Math.abs(lease(server).until - (stale.getTime() + 60_000 + ShellBackground.LEASE_MS))).toBeLessThan(3_000)
    expect(warnings.join("\n")).toContain("server clock differs")
    await held.release()
  })

  test("two renewals failing in a row are reported once", async () => {
    const warnings: string[] = []
    const server = fakeServer()
    const held = await hold(server, { warn: (text) => void warnings.push(text), renewMs: 15 })
    const session = (server.client as unknown as { session: { update: (args: unknown) => Promise<unknown> } }).session
    const real = session.update
    session.update = async () => ({ error: "down" })
    await Bun.sleep(100)
    session.update = real
    await held.release()
    expect(warnings.filter((text) => text.includes("could not renew"))).toHaveLength(1)
  })

  test("if its own session's messages cannot be read, it warns and stops the session to be safe", async () => {
    const warnings: string[] = []
    const server = fakeServer({ failMessages: true })
    const held = await hold(server, { warn: (text) => void warnings.push(text) })
    await held.release()
    expect(warnings.join("\n")).toContain("could not check for background commands")
    expect(server.calls.abort).toBe(1)
  })

  test("in a joined session an unreadable message list only warns", async () => {
    const warnings: string[] = []
    const server = fakeServer({ failMessages: true })
    const held = await hold(server, { owned: false, warn: (text) => void warnings.push(text) })
    await held.release()
    expect(warnings.join("\n")).toContain("could not check for background commands")
    expect(server.calls.abort).toBe(0)
  })

  test("without the lease (client opted out) it writes nothing, warns, and still cleans up its session", async () => {
    const warnings: string[] = []
    const server = fakeServer()
    const sig = signals()
    const held = await hold(server, { lease: false, warn: (text) => void warnings.push(text), signals: sig.signals })
    expect(server.calls.update).toBe(0)
    expect(warnings.join("\n")).toContain("running without the one-shot lease")
    expect(sig.emitter.listenerCount("SIGINT")).toBe(0)
    // The server backgrounded a command for this turn and the model ended without it.
    server.state.messages.push(user(TURN), reply(TURN, bash("job_left")))
    await held.release()
    expect(server.calls.update).toBe(0)
    expect(server.calls.abort).toBe(1)
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

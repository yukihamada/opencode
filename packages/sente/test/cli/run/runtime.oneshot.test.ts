import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { holdOneShot } from "../../../src/cli/cmd/run/runtime.oneshot"
import { ShellBackground } from "../../../src/tool/shell/background"

type Part = Record<string, unknown>

function fakeServer(input: { metadata?: Record<string, unknown>; parts?: Part[]; failUpdate?: boolean } = {}) {
  const state = { metadata: { ...input.metadata } as Record<string, unknown>, parts: input.parts ?? [] }
  const calls = { update: 0, abort: 0 }
  const client = {
    session: {
      get: async () => ({ data: { id: "ses_1", metadata: { ...state.metadata } } }),
      update: async (args: { metadata?: Record<string, unknown> }) => {
        calls.update++
        if (input.failUpdate) return { error: "boom" }
        state.metadata = { ...args.metadata }
        return { data: {} }
      },
      abort: async () => {
        calls.abort++
        return { data: true }
      },
      messages: async () => ({ data: [{ info: {}, parts: state.parts }] }),
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

const bash = (jobId: string, start: number): Part => ({
  type: "tool",
  tool: "bash",
  state: { status: "completed", metadata: { background: true, jobId }, time: { start, end: start } },
})
const waited = (jobId: string, status: string): Part => ({
  type: "tool",
  tool: "wait",
  state: { status: "completed", metadata: { jobId, status }, time: { start: 0, end: 0 } },
})

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
    expect(hold.marked).toBe(true)
    expect(server.state.metadata.other).toBe("keep")
    expect(ShellBackground.live(server.state.metadata[ShellBackground.ONE_SHOT])).toBe(true)
    // Someone else updates metadata meanwhile; release must not drop it.
    server.state.metadata.later = 1
    await hold.release()
    expect(server.state.metadata).toEqual({ other: "keep", later: 1 })
    expect(server.calls.abort).toBe(0)
  })

  test("renews the lease while the run lives", async () => {
    const server = fakeServer()
    const hold = await holdOneShot({
      client: server.client,
      sessionID: "ses_1",
      owned: true,
      warn: () => {},
      signals: signals().signals,
      renewMs: 20,
    })
    const first = (server.state.metadata[ShellBackground.ONE_SHOT] as ShellBackground.Lease).until
    await Bun.sleep(80)
    expect((server.state.metadata[ShellBackground.ONE_SHOT] as ShellBackground.Lease).until).toBeGreaterThan(first)
    await hold.release()
    const updates = server.calls.update
    await Bun.sleep(60)
    expect(server.calls.update).toBe(updates)
  })

  test("Ctrl-C drops the lease before the signal goes through", async () => {
    const server = fakeServer()
    const sig = signals()
    await holdOneShot({ client: server.client, sessionID: "ses_1", owned: false, warn: () => {}, signals: sig.signals })
    sig.emitter.emit("SIGINT", "SIGINT")
    await Bun.sleep(20)
    expect(server.state.metadata[ShellBackground.ONE_SHOT]).toBeUndefined()
    expect(sig.killed).toEqual(["SIGINT"])
  })

  test("in a session it made, a background command never collected is stopped by aborting", async () => {
    const server = fakeServer({ parts: [bash("job_a", 10), bash("job_b", 10), waited("job_b", "completed")] })
    const hold = await holdOneShot({
      client: server.client,
      sessionID: "ses_1",
      owned: true,
      warn: () => {},
      signals: signals().signals,
      startedAt: 5,
    })
    await hold.release()
    expect(server.calls.abort).toBe(1)
  })

  test("in a session it joined (-s/-c), it never aborts: it only warns about its own leftovers", async () => {
    const warnings: string[] = []
    const server = fakeServer({ parts: [bash("job_old", 1), bash("job_mine", 10)] })
    const hold = await holdOneShot({
      client: server.client,
      sessionID: "ses_1",
      owned: false,
      warn: (text) => void warnings.push(text),
      signals: signals().signals,
      startedAt: 5,
    })
    await hold.release()
    expect(server.calls.abort).toBe(0)
    expect(warnings.join("\n")).toContain("job_mine")
    expect(warnings.join("\n")).not.toContain("job_old")
  })

  test("with nothing left running it does nothing", async () => {
    const server = fakeServer({ parts: [bash("job_a", 10), waited("job_a", "completed")] })
    const hold = await holdOneShot({
      client: server.client,
      sessionID: "ses_1",
      owned: true,
      warn: () => {},
      signals: signals().signals,
      startedAt: 5,
    })
    await hold.release()
    await hold.release()
    expect(server.calls.abort).toBe(0)
  })

  test("a failed lease is reported", async () => {
    const warnings: string[] = []
    const server = fakeServer({ failUpdate: true })
    const sig = signals()
    const hold = await holdOneShot({
      client: server.client,
      sessionID: "ses_1",
      owned: false,
      warn: (text) => void warnings.push(text),
      signals: sig.signals,
    })
    expect(hold.marked).toBe(false)
    expect(warnings[0]).toContain("could not mark the session as a one-shot run")
    expect(sig.emitter.listenerCount("SIGINT")).toBe(0)
  })
})

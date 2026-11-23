import { describe, expect, test } from "bun:test"
import { createFetchServer, createWorkerFetch, type FetchInput } from "../../../src/cli/tui/worker-fetch"

// The client and server halves wired directly, as the RPC bridge does.
function wire(handler: (request: Request) => Promise<Response>) {
  const server = createFetchServer(handler)
  const calls: string[] = []
  const client = {
    call(method: "fetch" | "abort", input: unknown) {
      calls.push(method)
      return method === "fetch" ? server.fetch(input as FetchInput) : Promise.resolve(server.abort(input as { id: string }))
    },
  }
  return { server, calls, fetch: createWorkerFetch(client as Parameters<typeof createWorkerFetch>[0]) }
}

describe("worker fetch over RPC", () => {
  test("passes requests and responses through", async () => {
    const bridge = wire(async (request) => Response.json({ method: request.method, body: await request.text() }, { status: 201 }))
    const response = await bridge.fetch("http://localhost/x", { method: "POST", body: "hi" })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ method: "POST", body: "hi" })
    expect(bridge.server.pending).toBe(0)
  })

  test("aborting on the client aborts the server-side request and rejects the fetch", async () => {
    let serverSignal: AbortSignal | undefined
    let entered!: () => void
    const ready = new Promise<void>((resolve) => (entered = resolve))
    const bridge = wire((request) => {
      serverSignal = request.signal
      entered()
      return new Promise<Response>(() => {}) // never answers, like a long model call
    })
    const controller = new AbortController()
    const pending = bridge.fetch("http://localhost/session/x/btw", { method: "POST", body: "{}", signal: controller.signal })
    await ready
    expect(serverSignal?.aborted).toBe(false)
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(serverSignal?.aborted).toBe(true)
    expect(bridge.calls).toEqual(["fetch", "abort"])
    await Bun.sleep(0)
    expect(bridge.server.pending).toBe(0)
  })

  test("an already aborted signal never reaches the server", async () => {
    const bridge = wire(async () => new Response("no"))
    const controller = new AbortController()
    controller.abort()
    await expect(bridge.fetch("http://localhost/", { signal: controller.signal })).rejects.toThrow()
    expect(bridge.calls).toEqual([])
  })
})

// The TUI talks to the in-process server worker over RPC instead of HTTP. A
// Request's AbortSignal cannot cross the worker boundary, so cancellation is
// sent as its own RPC ("abort") keyed by a per-request id. Without this,
// closing a /btw panel (or any aborted request) left the server handler and
// its model request running and billing.

export type FetchInput = { id?: string; url: string; method: string; headers: Record<string, string>; body?: string }
export type FetchOutput = { status: number; headers: Record<string, string>; body: string }

type Caller = {
  call(method: "fetch", input: FetchInput): Promise<FetchOutput>
  call(method: "abort", input: { id: string }): Promise<unknown>
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError")
}

/** Client side (TUI thread): a `fetch` that forwards aborts to the worker. */
export function createWorkerFetch(client: Caller): typeof fetch {
  let next = 0
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const signal = request.signal
    if (signal.aborted) throw abortError(signal)
    const body = request.body ? await request.text() : undefined
    const id = `${Date.now().toString(36)}-${next++}`
    const call = client.call("fetch", {
      id,
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    let onAbort = () => {}
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        void client.call("abort", { id })
        reject(abortError(signal))
      }
      signal.addEventListener("abort", onAbort, { once: true })
    })
    const result = await Promise.race([call, aborted]).finally(() => signal.removeEventListener("abort", onAbort))
    return new Response(result.body, { status: result.status, headers: result.headers })
  }
  return fn as typeof fetch
}

/** Worker side: runs requests with an AbortController each, so an "abort" RPC interrupts the handler. */
export function createFetchServer(handler: (request: Request) => Promise<Response>, prepare?: (headers: Record<string, string>) => Record<string, string>) {
  const controllers = new Map<string, AbortController>()
  return {
    async fetch(input: FetchInput): Promise<FetchOutput> {
      const controller = new AbortController()
      if (input.id) controllers.set(input.id, controller)
      const request = new Request(input.url, {
        method: input.method,
        headers: prepare ? prepare({ ...input.headers }) : input.headers,
        body: input.body,
        signal: controller.signal,
      })
      // An interrupted handler may never resolve; answer the (already abandoned) call anyway.
      const aborted = new Promise<FetchOutput>((resolve) =>
        controller.signal.addEventListener("abort", () => resolve({ status: 499, headers: {}, body: "" }), { once: true }),
      )
      const served = handler(request).then(async (response) => ({
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.text(),
      }))
      return Promise.race([served, aborted]).finally(() => {
        if (input.id) controllers.delete(input.id)
      })
    },
    abort(input: { id: string }) {
      controllers.get(input.id)?.abort()
      controllers.delete(input.id)
      return true
    },
    /** In-flight request count (tests). */
    get pending() {
      return controllers.size
    },
  }
}

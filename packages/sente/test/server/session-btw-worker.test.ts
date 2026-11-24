// End to end along the path the TUI uses in a normal launch:
// SDK client → createWorkerFetch → (RPC) → createFetchServer → server → model.
// Closing the /btw panel aborts the SDK call; that must stop the server handler
// and the upstream model request, and still record what was spent.
import { afterEach, expect, test } from "bun:test"
import { createSenteClient } from "@sente-ai/sdk/v2"
import { Server } from "../../src/server/server"
import { createFetchServer, createWorkerFetch, type FetchInput } from "../../src/cli/tui/worker-fetch"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testProviderConfig } from "../lib/test-provider"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

async function wait(fn: () => boolean | Promise<boolean>, timeout = 10_000) {
  const start = Date.now()
  while (!(await fn())) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(20)
  }
}

test("closing /btw over the worker bridge stops the upstream model request and records the spend", async () => {
  const upstream = { requests: 0, aborted: false }
  const encoder = new TextEncoder()
  const llm = Bun.serve({
    port: 0,
    fetch(request) {
      upstream.requests++
      request.signal.addEventListener("abort", () => (upstream.aborted = true))
      const chunk = {
        id: "c1",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-small",
        choices: [{ index: 0, delta: { role: "assistant", content: "部分的な回答" } }],
      }
      // One chunk, then the stream stays open like a long answer.
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  try {
    const base = testProviderConfig(`http://127.0.0.1:${llm.port}/v1`)
    const model = base.provider.test.models["test-model"]
    await using tmp = await tmpdir({
      git: true,
      config: {
        ...base,
        small_model: "test/test-small",
        provider: {
          test: {
            ...base.provider.test,
            models: {
              "test-model": model,
              "test-small": { ...model, id: "test-small", name: "Test Small", cost: { input: 1, output: 2 } },
            },
          },
        },
      },
    })

    const server = createFetchServer(async (request) => Server.Default().app.fetch(request))
    const bridge = {
      call(method: "fetch" | "abort", input: unknown) {
        return method === "fetch" ? server.fetch(input as FetchInput) : Promise.resolve(server.abort(input as { id: string }))
      },
    }
    const sdk = createSenteClient({
      baseUrl: "http://test",
      directory: tmp.path,
      fetch: createWorkerFetch(bridge as Parameters<typeof createWorkerFetch>[0]),
    })
    const created = await sdk.session.create({}, { throwOnError: true })
    const before = created.data.time.updated

    const controller = new AbortController()
    const pending = sdk.session.btw({ sessionID: created.data.id, question: "長い回答をください" }, { signal: controller.signal })
    await wait(() => upstream.requests === 1)
    await Bun.sleep(100)
    controller.abort()
    // The SDK reports the abort as an error result (no answer).
    const result = await pending
    expect(result.data).toBeUndefined()
    expect(result.error).toBeDefined()

    await wait(() => upstream.aborted)
    await wait(async () => {
      const current = await sdk.session.get({ sessionID: created.data.id }, { throwOnError: true })
      const spend = current.data.metadata?.btw_spend as { total?: number } | undefined
      return (spend?.total ?? 0) > 0
    })
    const after = await sdk.session.get({ sessionID: created.data.id }, { throwOnError: true })
    // Recording the side cost does not reorder the session list.
    expect(after.data.time.updated).toBe(before)
    expect(server.pending).toBe(0)
  } finally {
    llm.stop(true)
  }
}, 30_000)

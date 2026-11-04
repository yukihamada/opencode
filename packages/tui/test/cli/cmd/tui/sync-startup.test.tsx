/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test"
import type { Model, Provider } from "@sente-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"

function model(id: string): Model {
  return {
    id,
    providerID: "teai",
    name: id,
    api: { id, url: "https://example.test", npm: "@ai-sdk/openai-compatible" },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      interleaved: false,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    cost: { input: 10, output: 50, cache: { read: 0, write: 0 } },
    limit: { context: 1048576, output: 32768 },
    status: "active",
    release_date: "2026-09-10",
    options: {},
    headers: {},
  }
}

const provider: Provider = {
  id: "teai",
  name: "teai",
  source: "config",
  env: [],
  options: {},
  models: { auto: model("auto") },
}

const agent = {
  name: "build",
  mode: "primary" as const,
  native: true,
  options: {},
  permission: [],
}

const emptyCatalog = { all: [], default: {}, connected: [] }

test("startup does not block on the provider catalog", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let settle!: (response: Response) => void
  const catalog = new Promise<Response>((resolve) => {
    settle = resolve
  })
  let released = false
  const release = (response: Response) => {
    if (released) return
    released = true
    settle(response)
  }

  let app: Awaited<ReturnType<typeof mount>>["app"] | undefined
  try {
    const mounted = await mount(
      (url) => {
        if (url.pathname === "/config/providers") return json({ providers: [provider], default: { teai: "auto" } })
        if (url.pathname === "/agent") return json([agent])
        if (url.pathname === "/provider") return catalog
        return undefined
      },
      tmp.path,
      { complete: false, release: () => release(json(emptyCatalog)) },
    )
    app = mounted.app
    const sync = mounted.sync

    await wait(() => sync.status === "partial")

    expect(sync.status).toBe("partial")
    expect(sync.data.provider.map((item) => item.id)).toEqual(["teai"])
    expect(sync.data.provider_default).toEqual({ teai: "auto" })
    expect(sync.data.agent.map((item) => item.name)).toEqual(["build"])
    expect(sync.data.provider_next.all).toEqual([])
    expect(sync.data.provider_next.connected).toEqual([])

    release(json({ all: [provider], default: { teai: "auto" }, connected: ["teai"] }))

    await wait(() => sync.status === "complete")
    await wait(() => sync.data.provider_next.all.length === 1)

    expect(sync.data.provider_next.all.map((item) => item.id)).toEqual(["teai"])
    expect(sync.data.provider_next.connected).toEqual(["teai"])
  } finally {
    release(json(emptyCatalog))
    app?.renderer.destroy()
  }
})

test("provider catalog failure is reported without taking down the ready screen", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let settle!: (response: Response) => void
  const catalog = new Promise<Response>((resolve) => {
    settle = resolve
  })
  const errors = spyOn(console, "error").mockImplementation(() => {})
  let app: Awaited<ReturnType<typeof mount>>["app"] | undefined
  try {
    const mounted = await mount((url) => (url.pathname === "/provider" ? catalog : undefined), tmp.path, {
      complete: false,
      release: () => settle(json(emptyCatalog)),
    })
    app = mounted.app
    settle(new Response("catalog unavailable", { status: 503 }))
    await wait(() => errors.mock.calls.some((call) => call[0] === "tui background sync failed"))
    expect(mounted.sync.ready).toBe(true)
    expect(mounted.sync.status).toBe("partial")
  } finally {
    settle(json(emptyCatalog))
    app?.renderer.destroy()
    errors.mockRestore()
  }
})

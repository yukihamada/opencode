import os from "node:os"
import path from "node:path"
import { afterAll, expect } from "bun:test"
import { LayerNode } from "@sente-ai/core/effect/layer-node"
import { Effect } from "effect"
import { MCP } from "../../src/mcp/index"
import { McpLazy } from "../../src/mcp/lazy"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const previous = process.env.SENTE_MCP_IDLE_MS
process.env.SENTE_MCP_IDLE_MS = "150"
afterAll(() => {
  if (previous === undefined) delete process.env.SENTE_MCP_IDLE_MS
  else process.env.SENTE_MCP_IDLE_MS = previous
})

const it = testEffect(LayerNode.compile(MCP.node))
const fixture = path.join(import.meta.dir, "../fixture/mcp-lazy-stdio.ts")
const cachedLog = path.join(os.tmpdir(), `mcp-lazy-${crypto.randomUUID()}.log`)
const cachedServer = {
  type: "local" as const,
  command: [process.execPath, fixture],
  environment: { MCP_LAZY_LOG: cachedLog },
}

const starts = (log: string) =>
  Effect.promise(() =>
    Bun.file(log)
      .text()
      .then((text) => text.trim().split("\n").filter(Boolean).map(Number))
      .catch(() => [] as number[]),
  )

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const whoami = (mcp: MCP.Interface) =>
  Effect.gen(function* () {
    const entry = (yield* mcp.tools())["lazy_whoami"]
    const result = yield* Effect.promise(() => entry.client.callTool({ name: "whoami", arguments: {} }))
    return Number((result.content as Array<{ text: string }>)[0].text)
  })

it.instance("an idle local server is stopped and started again by the next call", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const log = path.join(test.directory, "starts.log")
    const mcp = yield* MCP.Service
    yield* mcp.add("lazy", { type: "local", command: [process.execPath, fixture], environment: { MCP_LAZY_LOG: log } })

    const first = (yield* starts(log))[0]
    expect(alive(first)).toBe(true)
    yield* pollWithTimeout(
      Effect.sync(() => (alive(first) ? undefined : true)),
      "idle server was not stopped",
    )

    expect((yield* mcp.status()).lazy).toEqual({ status: "connected" })
    expect(Object.keys(yield* mcp.tools())).toEqual(["lazy_whoami"])
    expect(yield* starts(log)).toHaveLength(1)

    const second = yield* whoami(mcp)
    expect(second).not.toBe(first)
    expect(yield* starts(log)).toEqual([first, second])
  }),
)

it.instance(
  "a remembered local server lists its tools without starting until it is called",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service

      expect((yield* mcp.tools())["lazy_whoami"]?.def.description).toBe("remembered")
      expect((yield* mcp.status()).lazy).toEqual({ status: "connected" })
      expect(yield* starts(cachedLog)).toEqual([])

      const pid = yield* whoami(mcp)
      expect(yield* starts(cachedLog)).toEqual([pid])
      // The remembered list is reconciled with what the server reports once it is running.
      yield* pollWithTimeout(
        Effect.gen(function* () {
          return (yield* mcp.tools())["lazy_whoami"]?.def.description === "live" ? true : undefined
        }),
        "remembered tools were not refreshed",
      )
    }),
  {
    config: { mcp: { lazy: cachedServer } },
    init: (directory) =>
      Effect.promise(() =>
        McpLazy.write(McpLazy.key({ ...cachedServer, cwd: directory }), {
          time: Date.now(),
          capabilities: { tools: {} },
          defs: [{ name: "whoami", description: "remembered", inputSchema: { type: "object", properties: {} } }],
        }),
      ),
  },
)

it.instance("a call fails and the server is reported failed when it cannot start", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const log = path.join(test.directory, "starts.log")
    const script = path.join(test.directory, "server.ts")
    yield* Effect.promise(() => Bun.write(script, `await import(${JSON.stringify(fixture)})`))
    const mcp = yield* MCP.Service
    yield* mcp.add("lazy", { type: "local", command: [process.execPath, script], environment: { MCP_LAZY_LOG: log } })
    const first = (yield* starts(log))[0]
    yield* pollWithTimeout(
      Effect.sync(() => (alive(first) ? undefined : true)),
      "idle server was not stopped",
    )

    yield* Effect.promise(() => Bun.write(script, "process.exit(1)"))
    const entry = (yield* mcp.tools())["lazy_whoami"]
    const error = yield* Effect.promise(() =>
      entry.client.callTool({ name: "whoami", arguments: {} }).then(
        () => undefined,
        (error: Error) => error,
      ),
    )
    expect(error).toBeInstanceOf(Error)
    expect((yield* mcp.status()).lazy.status).toBe("failed")
    expect(Object.keys(yield* mcp.tools())).toEqual([])
  }),
)

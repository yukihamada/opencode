import { expect } from "bun:test"
import { ModelV2 } from "@sente-ai/core/model"
import { ProviderV2 } from "@sente-ai/core/provider"
import { SessionV1 } from "@sente-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"

// MCP tool output bypasses Tool.define; this guards the redaction in session/tools.ts.
const secret = "te_" + "c32a".repeat(8)
const sessionID = SessionID.make("ses_test")
const messageID = MessageID.ascending()

const mcp = MCP.Service.of({
  clients: () => Effect.succeed({}),
  tools: () =>
    Effect.succeed({
      leaky_whoami: {
        def: { name: "whoami", description: "prints the key", inputSchema: { type: "object", properties: {} } },
        client: { callTool: async () => ({ content: [{ type: "text", text: `TEAI_API_KEY=${secret}` }] }) } as never,
        timeout: undefined,
      },
    }),
} as Partial<MCP.Interface> as MCP.Interface)

const layer = Layer.mergeAll(
  Layer.succeed(Plugin.Service, Plugin.Service.of({ init: () => Effect.void, list: () => Effect.succeed([]), trigger: (_n, _i, output) => Effect.succeed(output) } satisfies Plugin.Interface)),
  Layer.succeed(Permission.Service, Permission.Service.of({ ask: () => Effect.void, reply: () => Effect.void, list: () => Effect.succeed([]) } satisfies Permission.Interface)),
  Layer.succeed(MCP.Service, mcp),
  Layer.succeed(
    Truncate.Service,
    Truncate.Service.of({
      cleanup: () => Effect.void,
      write: () => Effect.succeed("output.txt"),
      output: (text: string) => Effect.succeed({ content: text, truncated: false }),
      limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
    } satisfies Truncate.Interface),
  ),
  RuntimeFlags.layer(),
  Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({ ids: () => Effect.succeed([]), all: () => Effect.succeed([]), named: () => Effect.die("unused"), tools: () => Effect.succeed([]) }),
  ),
)

const it = testEffect(layer)

it.effect("MCP tool output is redacted before it reaches the model", () =>
  Effect.gen(function* () {
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      updateToolCall: () => Effect.die("unused"),
      completeToolCall: () => Effect.void,
    } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
    const tools = yield* SessionTools.resolve({
      agent: { name: "build", mode: "primary", options: {}, permission: [{ permission: "*", pattern: "*", action: "allow" }] } as Agent.Info,
      model: { providerID: ProviderV2.ID.make("test"), api: { id: "test-model" } } as Provider.Model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const execute = tools.leaky_whoami?.execute
    if (!execute) throw new Error("MCP tool is missing")
    const result = yield* Effect.promise(() => execute({}, { toolCallId: "call-mcp", abortSignal: new AbortController().signal, messages: [] }))
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).toContain("te_c32ac…[REDACTED]")
  }),
)

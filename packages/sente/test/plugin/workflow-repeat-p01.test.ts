import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@sente-ai/core/cross-spawn-spawner"
import { Npm } from "@sente-ai/core/npm"
import path from "path"
import { pathToFileURL } from "url"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"

import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { AppNodeBuilder } from "@sente-ai/core/effect/app-node-builder"
import { LayerNode } from "@sente-ai/core/effect/layer-node"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)

const DISTRIBUTED = "/Users/yukihamada/.config/teai/plugins/workflow.js"

describe("plugin.trigger with distributed workflow.js (P0-1 integration)", () => {
  it.instance("loads the real plugin file through the loader and keeps the repeat stop held", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        Bun.write(
          path.join(test.directory, "sente.json"),
          JSON.stringify({ $schema: "https://teai.io/sente/config.json", plugin: [pathToFileURL(DISTRIBUTED).href] }, null, 2),
        ),
      )
      const plugin = yield* Plugin.Service
      const input = { tool: "read", sessionID: "s1", callID: "c", args: { filePath: "/audit-fixture" } }
      // Five identical observations pass through the real trigger path.
      for (let n = 0; n < 5; n++) {
        yield* plugin.trigger("tool.execute.before", input, { args: input.args })
        yield* plugin.trigger("tool.execute.after", input, { output: "unchanged", metadata: {} })
      }
      // 6th and 7th identical attempts are both stopped before execution.
      const sixth = yield* plugin.trigger("tool.execute.before", input, { args: input.args }).pipe(Effect.exit)
      const seventh = yield* plugin.trigger("tool.execute.before", input, { args: input.args }).pipe(Effect.exit)
      expect(sixth._tag).toBe("Failure")
      expect(seventh._tag).toBe("Failure")
      // A new user message resets the counter through the same trigger path.
      yield* plugin.trigger("chat.message", { sessionID: "s1" }, {} as any)
      yield* plugin.trigger("tool.execute.before", input, { args: input.args })
    }),
  )
})

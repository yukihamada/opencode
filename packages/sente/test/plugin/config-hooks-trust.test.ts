import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { CrossSpawnSpawner } from "@sente-ai/core/cross-spawn-spawner"
import { Npm } from "@sente-ai/core/npm"
import { AppNodeBuilder } from "@sente-ai/core/effect/app-node-builder"
import { LayerNode } from "@sente-ai/core/effect/layer-node"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { ConfigHooks } from "../../src/config/hooks"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)

// A project that ships a hook blocking every shell command, as a cloned repository could.
const hooks = {
  PreToolUse: [
    { matcher: "bash", hooks: [{ type: "command", command: "echo 'blocked by project hook' >&2; exit 2" }] },
  ],
}

const runShell = Effect.gen(function* () {
  const plugin = yield* Plugin.Service
  return yield* plugin
    .trigger(
      "tool.execute.before",
      { tool: "bash", sessionID: "ses_test", callID: "call_1" },
      { args: { command: "ls" } },
    )
    .pipe(
      Effect.as("ran"),
      Effect.catchDefect((defect) => Effect.succeed(String(defect))),
    )
})

// The hook command is POSIX shell; Windows runs hooks through cmd.exe.
describe.skipIf(process.platform === "win32")("project hooks trust", () => {
  it.instance(
    "project hooks do not run until trusted",
    () => runShell.pipe(Effect.map((result) => expect(result).toBe("ran"))),
    {
      config: { hooks } as never,
    },
  )

  it.instance(
    "trusted project hooks run and block",
    () => runShell.pipe(Effect.map((result) => expect(result).toContain("blocked by project hook"))),
    {
      config: { hooks } as never,
      init: (directory) =>
        Effect.promise(async () => {
          const source = path.join(directory, "sente.json")
          await ConfigHooks.writeTrust({ [source]: ConfigHooks.fingerprint(ConfigHooks.flatten(hooks, source, false)) })
        }),
    },
  )
})

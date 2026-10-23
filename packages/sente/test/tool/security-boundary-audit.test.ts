// Local security audit: dummy data only, no provider calls or external requests.
// These assertions describe current boundaries, not desired security guarantees.
import { expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { LayerNode } from "@sente-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@sente-ai/core/cross-spawn-spawner"
import { FSUtil } from "@sente-ai/core/fs-util"
import { PermissionV1 } from "@sente-ai/core/v1/permission"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { MessageID, SessionID } from "../../src/session/schema"
import { ShellTool } from "../../src/tool/shell"
import { Truncate } from "../../src/tool/truncate"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        CrossSpawnSpawner.node,
        FSUtil.node,
        Plugin.node,
        Truncate.node,
        Config.node,
        Agent.node,
        RuntimeFlags.node,
        Permission.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

const probe = Effect.fn("SecurityAudit.probe")(function* (command: string) {
  const agents = yield* Agent.Service
  const agent = yield* agents.get("build")
  if (!agent) throw new Error("build agent missing")
  const permission = yield* Permission.Service
  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  const shell = yield* ShellTool
  const tool = yield* shell.init()
  const result = yield* tool.execute(
    { command, timeout: 5000 },
    {
      sessionID: SessionID.make("ses_security_audit"),
      messageID: MessageID.make("msg_security_audit"),
      callID: "audit",
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: (request) =>
        Effect.gen(function* () {
          requests.push(request)
          yield* permission
            .ask({ ...request, sessionID: SessionID.make("ses_security_audit"), ruleset: agent.permission })
            .pipe(Effect.orDie)
        }),
    },
  )
  return { result, requests }
})

it.live("audit: read deny does not protect a project .env from the shell", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({
      config: { permission: { read: "deny" } },
      init: (dir) => Effect.promise(() => Bun.write(`${dir}/.env`, "AUDIT_DUMMY=not-a-secret")).pipe(Effect.asVoid),
    })
    const out = yield* probe("cat .env").pipe(provideInstance(dir))
    expect(out.result.output).toContain("AUDIT_DUMMY=not-a-secret")
    expect(out.requests.map((req) => req.permission)).toEqual(["bash"])
  }),
)

it.live("audit: an interpreter can read a dummy external file without external_directory permission", () =>
  Effect.gen(function* () {
    const external = yield* tmpdirScoped({
      init: (dir) => Effect.promise(() => Bun.write(`${dir}/dummy.txt`, "external-dummy")).pipe(Effect.asVoid),
    })
    const dir = yield* tmpdirScoped({ config: { permission: { external_directory: "deny" } } })
    const code = `process.stdout.write(await Bun.file(${JSON.stringify(`${external}/dummy.txt`)}).text())`
    const out = yield* probe(`"${process.execPath}" -e '${code}'`).pipe(provideInstance(dir))
    expect(out.result.output).toContain("external-dummy")
    expect(out.requests.map((req) => req.permission)).toEqual(["bash"])
  }),
)

it.live("audit: shell inherits a dummy environment value", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const prev = process.env.SENTE_AUDIT_DUMMY
        process.env.SENTE_AUDIT_DUMMY = "inherited-dummy"
        return prev
      }),
      () =>
        Effect.gen(function* () {
          const out = yield* probe("printf '%s' \"$SENTE_AUDIT_DUMMY\"").pipe(provideInstance(dir))
          expect(out.result.output).toContain("inherited-dummy")
        }),
      (prev) =>
        Effect.sync(() => {
          if (prev === undefined) delete process.env.SENTE_AUDIT_DUMMY
          else process.env.SENTE_AUDIT_DUMMY = prev
        }),
    )
  }),
)

it.live("audit: bash deny blocks a regular command before its file side effect", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ config: { permission: { bash: "deny" } } })
    const exit = yield* probe("printf dummy > command-marker.txt").pipe(provideInstance(dir), Effect.exit)
    if (!Exit.isFailure(exit)) throw new Error("expected permission denial")
    expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.DeniedError)
    expect(yield* Effect.promise(() => Bun.file(`${dir}/command-marker.txt`).exists())).toBe(false)
  }),
)

for (const command of [
  "> redirect-marker.txt",
  "cd . > redirect-marker.txt",
  "AUDIT_VAR=dummy > redirect-marker.txt",
  "(> redirect-marker.txt)",
  "{ > redirect-marker.txt; }",
  "printf dummy; > redirect-marker.txt",
]) {
  it.live(`audit: bash deny blocks shell syntax: ${command}`, () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ config: { permission: { bash: "deny", edit: "deny" } } })
      const exit = yield* probe(command).pipe(provideInstance(dir), Effect.exit)
      if (!Exit.isFailure(exit)) throw new Error("expected permission denial")
      expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.DeniedError)
      expect(yield* Effect.promise(() => Bun.file(`${dir}/redirect-marker.txt`).exists())).toBe(false)
    }),
  )
}

it.live("audit: bare redirect waits for actual permission reply before creating a file", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ config: { permission: { bash: "ask" } } })
    yield* Effect.gen(function* () {
      const permission = yield* Permission.Service
      const fiber = yield* probe("> approval-marker.txt").pipe(Effect.forkChild)
      const request = yield* pollWithTimeout(
        permission.list().pipe(Effect.map((items) => items[0])),
        "redirect never requested permission",
      )
      expect(request.permission).toBe("bash")
      expect(request.patterns).toContain("> approval-marker.txt")
      // Raw shell input may contain wildcards; don't turn it into an allow rule.
      expect(request.always).toEqual([])
      expect(yield* Effect.promise(() => Bun.file(`${dir}/approval-marker.txt`).exists())).toBe(false)
      yield* permission.reply({ requestID: request.id, reply: "once" })
      const out = yield* Fiber.join(fiber)
      expect(out.result.metadata.exit).toBe(0)
      expect(yield* Effect.promise(() => Bun.file(`${dir}/approval-marker.txt`).exists())).toBe(true)
    }).pipe(provideInstance(dir))
  }),
)

it.live("audit: checking complete input preserves denial of an extracted subcommand", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({
      config: { permission: { bash: { "*": "deny", "printf *": "allow" } } },
    })
    const exit = yield* probe("printf dummy; touch denied-marker.txt").pipe(provideInstance(dir), Effect.exit)
    if (!Exit.isFailure(exit)) throw new Error("expected permission denial")
    expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.DeniedError)
    expect(yield* Effect.promise(() => Bun.file(`${dir}/denied-marker.txt`).exists())).toBe(false)
  }),
)

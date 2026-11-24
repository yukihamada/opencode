export * as ConfigHooksRunner from "./config-hooks"

// Runs the shell commands configured under `hooks` (Claude Code hooks format) as a built-in plugin, on top of the
// existing plugin hooks: PreToolUse/PostToolUse = tool.execute.before/after, UserPromptSubmit + SessionStart =
// chat.message, Stop = session.idle event, Notification = permission.asked / question.asked events.
//
// A hook that fails, times out or prints garbage never takes Sente down: only an explicit block (exit code 2 or a
// JSON decision) changes what happens, everything else is logged and ignored.
import { execFileSync, spawn, type ChildProcess } from "child_process"
import path from "path"
import type { Plugin } from "@sente-ai/plugin"
import type { ConfigHooks } from "@/config/hooks"
import { SecretRedact } from "@/tool/secret-redact"
import { PartID } from "@/session/schema"
import { NamedError } from "@sente-ai/core/util/error"
import { Schema } from "effect"

export const DEFAULT_TIMEOUT_SECONDS = 60

// A prompt refused by a UserPromptSubmit hook. The server answers it as a 400 with this message instead of an opaque
// 500, so the person sees why their prompt was dropped.
export const HookBlockedError = NamedError.create("HookBlockedError", { message: Schema.String })
const MAX_OUTPUT = 64 * 1024

export const EVENTS = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SessionStart", "Notification"] as const

// Claude Code tool names, so matchers and scripts written for it ("Bash", "Edit|Write") keep working.
const ALIASES: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  apply_patch: "Edit",
  glob: "Glob",
  grep: "Grep",
  list: "LS",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  task: "Task",
  todowrite: "TodoWrite",
  skill: "Skill",
}

// MCP tools are registered as `<server>_<tool>` (see McpCatalog.toolName); Claude Code calls them
// `mcp__<server>__<tool>`. The configured server names make the split unambiguous.
export function toolNames(tool: string, mcpServers: string[] = []) {
  const server = mcpServers
    .filter((name) => tool.startsWith(name.replace(/[^a-zA-Z0-9_-]/g, "_") + "_"))
    .toSorted((a, b) => b.length - a.length)[0]
  return [
    tool,
    ...(ALIASES[tool] ? [ALIASES[tool]] : []),
    ...(server ? [`mcp__${server}__${tool.slice(server.replace(/[^a-zA-Z0-9_-]/g, "_").length + 1)}`] : []),
  ]
}

export type Result = {
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted?: boolean
  // Set when the command was ended by a signal it did not expect (not Sente's timeout or cancel).
  signal?: string
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

// Same rule as Claude Code: a plain name list ("bash|edit") matches exactly, anything else is a regular expression.
export function matches(matcher: string | undefined, names: string[]) {
  if (!matcher || matcher === "*") return true
  if (/^[\w|-]+$/.test(matcher)) return matcher.split("|").some((item) => names.includes(item))
  const re = (() => {
    try {
      return new RegExp(matcher)
    } catch {
      return undefined
    }
  })()
  return !!re && names.some((name) => re.test(name))
}

// Sente's own credentials are kept out of the hook's environment: a project hook the user trusted for linting should not
// get the teai console token, the server password or inline auth/config content for free. This is one layer of defence,
// not a boundary: a trusted hook runs as the user and can still read credential files such as auth.json. Other
// variables (including provider API keys the user put in their shell) are passed through; the docs say so.
const SENTE_CREDENTIAL = /^(SENTE|OPENCODE|TEAI)_\w*(TOKEN|KEY|SECRET|PASSWORD|PASS|CREDENTIAL)S?$/i
const SENTE_PRIVATE = new Set([
  "SENTE_AUTH_CONTENT",
  "SENTE_CONFIG_CONTENT",
  "OPENCODE_AUTH_CONTENT",
  "OPENCODE_CONFIG_CONTENT",
])

export function hookEnv(extra: Record<string, string | undefined> = {}) {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...extra }).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && !SENTE_CREDENTIAL.test(entry[0]) && !SENTE_PRIVATE.has(entry[0]),
    ),
  )
}

// Hook processes still running, killed on a normal exit of Sente ("exit" event). Sente installs no signal handlers for
// this: a handler would change what SIGHUP/SIGTERM do to Sente itself (for example undo `nohup`). Abnormal ends are
// covered by the lifeline below on POSIX instead.
const live = new Set<ChildProcess>()
const exitWatch = { installed: false }

// Kills every hook process still running. Called when the TUI server worker shuts down: terminating a worker does not
// close the pipes it opened on every platform (Linux keeps them until the process exits), so the lifeline alone would
// only fire once the whole TUI process ends.
export function killAll() {
  live.forEach((item) => killTree(item, true))
}

function killTree(child: ChildProcess, sync = false) {
  if (!child.pid || child.exitCode !== null) return
  try {
    if (process.platform === "win32") {
      // cmd.exe /c starts the command as a grandchild; only taskkill /T reaches the whole tree.
      if (sync)
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      else
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on(
          "error",
          () => {},
        )
      return
    }
    process.kill(-child.pid, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
}

// POSIX wrapper around the hook command. The hook runs in its own process group (detached) so a timeout can kill
// everything it started. Fd 3 is a pipe whose other end only Sente holds: a background watcher in the group blocks
// reading it, and when it reaches end-of-file (Sente closed it after the hook finished, or Sente died in any way,
// SIGKILL and a terminated TUI worker included) it kills the whole group. So hook processes never outlive the hook run
// or Sente, without Sente touching its own signal handling.
const LIFELINE = [
  "( read _ <&3; kill -s KILL 0 ) </dev/null >/dev/null 2>&1 &",
  "exec 3<&-",
  'sente_hook_command=$SENTE_HOOK_COMMAND; unset SENTE_HOOK_COMMAND; eval "$sente_hook_command"',
].join("\n")

// node:child_process rather than the Effect CrossSpawnSpawner: plugin hooks are plain promises with no Effect services
// in reach, a hook must stop being awaited as soon as the command exits even if something it started keeps stdout open
// (CrossSpawnSpawner waits for "close"), and the lifeline needs an extra pipe. The kill strategy matches
// CrossSpawnSpawner: process group on POSIX, taskkill /T on Windows.
export function exec(
  command: string,
  input: unknown,
  options: { cwd: string; env?: Record<string, string>; timeout?: number; signal?: AbortSignal },
): Promise<Result> {
  return new Promise((resolve) => {
    const out = { stdout: "", stderr: "" }
    const state = {
      done: false,
      ended: 0,
      exit: undefined as { code: number | null; signal: string | null } | undefined,
    }
    let grace: ReturnType<typeof setTimeout> | undefined
    const posix = process.platform !== "win32"
    const finish = (result: Omit<Result, "command" | "stdout" | "stderr">) => {
      if (state.done) return
      state.done = true
      clearTimeout(timer)
      clearTimeout(grace)
      options.signal?.removeEventListener("abort", abort)
      if (!(child instanceof Error)) {
        live.delete(child)
        // Closing the lifeline also stops anything the hook left running in the background.
        child.stdio[3]?.destroy()
      }
      resolve({ command, stdout: out.stdout, stderr: out.stderr, ...result })
    }
    const child = (() => {
      try {
        const env = options.env ?? hookEnv()
        if (!posix)
          return spawn(command, {
            shell: true,
            cwd: options.cwd,
            env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          })
        return spawn("/bin/sh", ["-c", LIFELINE], {
          cwd: options.cwd,
          env: { ...env, SENTE_HOOK_COMMAND: command },
          stdio: ["pipe", "pipe", "pipe", "pipe"],
          detached: true,
        })
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error))
      }
    })()
    const timer = setTimeout(
      () => {
        if (!(child instanceof Error)) killTree(child)
        finish({ exitCode: null, timedOut: true })
      },
      Math.max(0.001, options.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
    )
    const abort = () => {
      if (!(child instanceof Error)) killTree(child)
      finish({ exitCode: null, timedOut: false, aborted: true })
    }
    if (child instanceof Error) return finish({ exitCode: null, timedOut: false, error: child.message })
    if (options.signal?.aborted) return abort()
    options.signal?.addEventListener("abort", abort, { once: true })
    live.add(child)
    if (!exitWatch.installed) {
      exitWatch.installed = true
      process.on("exit", killAll)
    }
    // The lifeline pipe must not keep Sente's event loop alive.
    const lifeline = child.stdio[3]
    if (lifeline && "unref" in lifeline && typeof lifeline.unref === "function") lifeline.unref()
    const settle = () => {
      if (!state.exit || state.ended < 2) return
      finish({ exitCode: state.exit.code, timedOut: false, signal: state.exit.signal ?? undefined })
    }
    // Decode as UTF-8 per stream so a multi-byte character split across chunks is not mangled.
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    const append = (key: "stdout" | "stderr") => (chunk: string) => {
      if (out[key].length < MAX_OUTPUT) out[key] = (out[key] + chunk).slice(0, MAX_OUTPUT)
    }
    child.stdout?.on("data", append("stdout"))
    child.stderr?.on("data", append("stderr"))
    for (const stream of [child.stdout, child.stderr])
      stream?.on("end", () => {
        state.ended++
        settle()
      })
    child.on("error", (error) => finish({ exitCode: null, timedOut: false, error: error.message }))
    child.on("exit", (code, signal) => {
      state.exit = { code, signal }
      settle()
      // A command that leaves a background process holding stdout open never ends the stream; stop waiting shortly
      // after the command itself exits.
      grace = setTimeout(() => finish({ exitCode: code, timedOut: false, signal: signal ?? undefined }), 200)
    })
    // Hooks are free to ignore stdin; a closed pipe must not surface as an uncaught EPIPE.
    child.stdin?.on("error", () => {})
    child.stdin?.end(JSON.stringify(input))
  })
}

export type Outcome = {
  block: boolean
  reasons: string[]
  context: string[]
  updatedInput?: Record<string, unknown>
  results: Result[]
}

function parse(stdout: string) {
  const text = stdout.trim()
  if (!text.startsWith("{")) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

// Reads one hook result the way Claude Code does: exit 2 blocks with stderr as the reason; on exit 0 a JSON object can
// block (`decision: "block"`, `continue: false`, `hookSpecificOutput.permissionDecision: "deny"`) or add context;
// plain stdout on exit 0 is context for UserPromptSubmit and SessionStart.
export function interpret(event: string, results: Result[]): Outcome {
  return results.reduce<Outcome>(
    (acc, result) => {
      // Fail closed for the checks that guard an action: a PreToolUse or UserPromptSubmit hook that did not finish
      // (timed out, cancelled, killed by a signal, or could not start) blocks instead of letting the action through.
      if (result.exitCode === null && (event === "PreToolUse" || event === "UserPromptSubmit")) {
        acc.block = true
        const why = result.timedOut
          ? "timed out"
          : result.aborted
            ? "was cancelled"
            : result.signal
              ? `was stopped by ${result.signal}`
              : `could not start${result.error ? ` (${result.error})` : ""}`
        acc.reasons.push(`hook ${why}: ${result.command}`)
        return acc
      }
      if (result.exitCode === 2) {
        acc.block = true
        acc.reasons.push(result.stderr.trim() || `hook exited with code 2: ${result.command}`)
        return acc
      }
      if (result.exitCode !== 0) return acc
      const json = parse(result.stdout)
      if (!json) {
        if ((event === "UserPromptSubmit" || event === "SessionStart") && result.stdout.trim())
          acc.context.push(result.stdout.trim())
        return acc
      }
      const specific = isRecord(json.hookSpecificOutput) ? json.hookSpecificOutput : {}
      const denied = specific.permissionDecision === "deny"
      if (json.continue === false || json.decision === "block" || json.decision === "deny" || denied) {
        acc.block = true
        const reason = [denied ? specific.permissionDecisionReason : undefined, json.reason, json.stopReason].find(
          (item): item is string => typeof item === "string" && item.trim().length > 0,
        )
        acc.reasons.push(reason?.trim() ?? `blocked by hook: ${result.command}`)
      }
      if (typeof specific.additionalContext === "string" && specific.additionalContext.trim())
        acc.context.push(specific.additionalContext.trim())
      if (isRecord(specific.updatedInput)) acc.updatedInput = { ...acc.updatedInput, ...specific.updatedInput }
      return acc
    },
    { block: false, reasons: [], context: [], results },
  )
}

export async function run(input: {
  hooks: ConfigHooks.Origin[]
  event: string
  names?: string[]
  payload: Record<string, unknown>
  cwd: string
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  warn?: (message: string) => void
  // Returns why a hook must not run right now (project/remote trust no longer matches); it is then skipped.
  verify?: (hook: ConfigHooks.Origin) => string | undefined
}): Promise<Outcome> {
  const selected = input.hooks.filter((hook) => {
    if (hook.event !== input.event || (input.names && !matches(hook.matcher, input.names))) return false
    const refused = input.verify?.(hook)
    if (refused) input.warn?.(`${input.event} hook not run (${refused}): ${hook.command}`)
    return !refused
  })
  if (!selected.length) return { block: false, reasons: [], context: [], results: [] }
  const env = hookEnv(input.env)
  // Every matching hook runs, in parallel, like Claude Code.
  const results = await Promise.all(
    selected.map((hook) =>
      exec(hook.command, input.payload, { cwd: input.cwd, env, timeout: hook.timeout, signal: input.signal }),
    ),
  )
  for (const result of results) {
    if (result.exitCode === 0 || result.exitCode === 2 || result.aborted) continue
    if (result.exitCode === null && (input.event === "PreToolUse" || input.event === "UserPromptSubmit")) continue
    const why = result.timedOut
      ? "timed out"
      : result.error
        ? result.error
        : `exit ${result.exitCode}${result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 500)}` : ""}`
    input.warn?.(SecretRedact.redact(`${input.event} hook failed (${why}), continuing: ${result.command}`))
  }
  const outcome = interpret(input.event, results)
  // Whatever goes back to the model or the screen passes the same secret mask as tool output.
  return {
    ...outcome,
    reasons: outcome.reasons.map((item) => SecretRedact.redact(item)),
    context: outcome.context.map((item) => SecretRedact.redact(item)),
  }
}

const snake = (key: string) => key.replace(/[A-Z]/g, (char) => "_" + char.toLowerCase())
const camel = (key: string) => key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase())

// What hooks see as tool_input. Sente tools use camelCase arguments (filePath); Claude Code scripts read snake_case
// (file_path), so both are offered. apply_patch carries its files inside the patch text; they are listed as
// file_path / file_paths (absolute) so "Edit|Write" scripts that read file_path also cover it.
export function toolInput(tool: string, args: unknown, cwd: string) {
  if (!isRecord(args)) return args
  const input = Object.entries(args).reduce<Record<string, unknown>>(
    (acc, [key, value]) => (snake(key) in acc ? acc : { ...acc, [snake(key)]: value }),
    { ...args },
  )
  if (tool !== "apply_patch" || typeof args.patchText !== "string") return input
  const files = [
    ...new Set(
      [...args.patchText.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm)].map((match) =>
        path.resolve(cwd, match[1]),
      ),
    ),
  ]
  return { ...input, file_path: files[0], file_paths: files }
}

// Applies hookSpecificOutput.updatedInput to the real arguments. Keys are mapped back to Sente's names (file_path ->
// filePath). A hook that echoes the whole tool_input back has both spellings of a key, only one of them edited: the
// edited value wins, whichever order the keys come in. Keys that only exist in tool_input (file_paths) are dropped.
export function applyUpdate(args: Record<string, unknown>, update: Record<string, unknown>, offered: unknown) {
  const original = { ...args }
  const shown = isRecord(offered) ? offered : {}
  const next = new Map<string, { value: unknown; changed: boolean }>()
  for (const [key, value] of Object.entries(update)) {
    const target = key in original ? key : camel(key) in original ? camel(key) : key
    if (!(target in original) && key in shown) continue
    const changed = JSON.stringify(value) !== JSON.stringify(key in shown ? shown[key] : original[target])
    if (next.get(target)?.changed && !changed) continue
    next.set(target, { value, changed })
  }
  for (const [key, item] of next) args[key] = item.value
}

export function ConfigHooksPlugin(
  hooks: ConfigHooks.Origin[],
  options: {
    warn?: (message: string) => void
    // Configured MCP server names, for `mcp__<server>__<tool>` matchers.
    mcpServers?: string[]
    // Re-checks project/remote trust right before a hook runs (see ConfigHooks.recheck).
    verify?: (hook: ConfigHooks.Origin) => string | undefined
    // Called once, on the first prompt of this process: by then the TUI is surely listening, so a warning about hooks
    // that were not run (untrusted project/remote hooks) is not lost in startup.
    notice?: (sessionID: string) => void
  } = {},
): Plugin {
  return async (input) => {
    if (!hooks.length && !options.notice) return {}
    const has = (event: string) => hooks.some((hook) => hook.event === event)
    const projectDir = input.worktree && input.worktree !== "/" ? input.worktree : input.directory
    const created = new Set<string>()
    const parents = new Map<string, Promise<boolean>>()
    const started = new Set<string>()
    const pending = new Set<Promise<unknown>>()
    // In-flight hooks per session, cancelled when the session goes idle (Esc / cancel) so a slow PreToolUse hook does
    // not keep running, or let the tool run, after the user stopped the turn.
    const running = new Map<string, Set<AbortController>>()
    const noticed = { done: false }

    const fire = async (event: string, sessionID: string, extra: Record<string, unknown>, names?: string[]) => {
      const controller = new AbortController()
      const set = running.get(sessionID) ?? new Set()
      running.set(sessionID, set.add(controller))
      const outcome = await run({
        hooks,
        event,
        names,
        cwd: input.directory,
        env: { SENTE_PROJECT_DIR: projectDir, CLAUDE_PROJECT_DIR: projectDir, SENTE_SESSION_ID: sessionID },
        signal: event === "Stop" || event === "Notification" ? undefined : controller.signal,
        warn: options.warn,
        verify: options.verify,
        payload: {
          session_id: sessionID,
          transcript_path: "",
          cwd: input.directory,
          permission_mode: "default",
          hook_event_name: event,
          ...extra,
        },
      }).finally(() => set.delete(controller))
      return { ...outcome, aborted: controller.signal.aborted }
    }

    // Background events (Stop, Notification) are awaited on dispose so `sente run` does not exit under them.
    const track = (promise: Promise<unknown>) => {
      const guarded = promise.catch((error) => options.warn?.(`hook failed: ${String(error)}`))
      pending.add(guarded)
      void guarded.finally(() => pending.delete(guarded))
    }

    // Subagent sessions have a parent; user-turn events (UserPromptSubmit, SessionStart, Stop) are for the main one.
    const isChild = (sessionID: string) => {
      const known = parents.get(sessionID)
      if (known) return known
      const lookup = Promise.resolve(input.client.session.get({ path: { id: sessionID } }))
        .then((res) => !!res.data?.parentID)
        .catch(() => false)
      parents.set(sessionID, lookup)
      return lookup
    }

    const textOf = (parts: { type: string; text?: string; synthetic?: boolean }[]) =>
      parts
        .filter((part) => part.type === "text" && !part.synthetic && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")

    return {
      async event(payload) {
        // The v1 plugin Event union predates permission.asked / question.asked; compare on the runtime type string.
        const event: { type: string; properties: unknown } = payload.event
        const props: Record<string, unknown> = isRecord(event.properties) ? event.properties : {}
        const sessionID = typeof props.sessionID === "string" ? props.sessionID : undefined
        if (event.type === "session.created" && sessionID) {
          created.add(sessionID)
          const info = isRecord(props.info) ? props.info : {}
          parents.set(sessionID, Promise.resolve(typeof info.parentID === "string"))
          return
        }
        if (event.type === "session.idle" && sessionID) {
          running.get(sessionID)?.forEach((controller) => controller.abort())
          if (!has("Stop")) return
          track(
            isChild(sessionID).then(async (child) => {
              if (child) return
              const outcome = await fire("Stop", sessionID, { stop_hook_active: false })
              // Not supported yet: continuing the turn from a Stop hook (Claude Code's exit 2 / decision "block").
              if (outcome.block)
                options.warn?.(
                  `Stop hook asked to continue the turn; Sente does not support that yet: ${outcome.reasons.join("; ")}`,
                )
            }),
          )
          return
        }
        if (
          (event.type === "permission.asked" || event.type === "question.asked") &&
          sessionID &&
          has("Notification")
        ) {
          const type = event.type === "permission.asked" ? "permission_prompt" : "elicitation_dialog"
          const message =
            event.type === "permission.asked"
              ? `Sente needs your permission to use ${String(props.permission ?? "a tool")}`
              : "Sente is asking you a question"
          track(fire("Notification", sessionID, { message, notification_type: type }, [type]))
        }
      },
      async "chat.message"(meta, output) {
        if (options.notice && !noticed.done) {
          noticed.done = true
          options.notice(meta.sessionID)
        }
        if (!has("SessionStart") && !has("UserPromptSubmit")) return
        if (await isChild(meta.sessionID)) return
        const context: string[] = []
        if (!started.has(meta.sessionID) && has("SessionStart")) {
          started.add(meta.sessionID)
          const source = created.has(meta.sessionID) ? "startup" : "resume"
          const outcome = await fire("SessionStart", meta.sessionID, { source }, [source])
          context.push(...outcome.context)
        }
        if (has("UserPromptSubmit")) {
          const outcome = await fire("UserPromptSubmit", meta.sessionID, { prompt: textOf(output.parts) })
          // Throwing here happens before the message is saved, so a blocked prompt never reaches the model.
          if (outcome.block)
            throw new HookBlockedError({
              message: `UserPromptSubmit hook blocked this prompt: ${outcome.reasons.join("; ")}`,
            })
          context.push(...outcome.context)
        }
        if (!context.length) return
        output.parts.push({
          id: PartID.ascending(),
          sessionID: output.message.sessionID,
          messageID: output.message.id,
          type: "text",
          synthetic: true,
          text: `<hook-context>\n${context.join("\n\n")}\n</hook-context>`,
        })
      },
      async "tool.execute.before"(meta, output) {
        if (!has("PreToolUse")) return
        const offered = toolInput(meta.tool, output.args, input.directory)
        const outcome = await fire(
          "PreToolUse",
          meta.sessionID,
          { tool_name: meta.tool, tool_input: offered, tool_use_id: meta.callID },
          toolNames(meta.tool, options.mcpServers),
        )
        if (outcome.block) throw new Error(`PreToolUse hook blocked this tool call: ${outcome.reasons.join("; ")}`)
        // The turn was stopped while the hook ran: do not run the tool afterwards.
        if (outcome.aborted) throw new Error("PreToolUse hook was cancelled with the turn")
        if (outcome.updatedInput && isRecord(output.args)) applyUpdate(output.args, outcome.updatedInput, offered)
      },
      async "tool.execute.after"(meta, output) {
        if (!has("PostToolUse")) return
        const outcome = await fire(
          "PostToolUse",
          meta.sessionID,
          {
            tool_name: meta.tool,
            tool_input: toolInput(meta.tool, meta.args, input.directory),
            tool_use_id: meta.callID,
            tool_response: { title: output.title, output: SecretRedact.redact(output.output ?? "") },
          },
          toolNames(meta.tool, options.mcpServers),
        )
        const notes = [...outcome.reasons, ...outcome.context]
        if (notes.length)
          output.output = `${output.output ?? ""}\n\n<hook-feedback>\n${notes.join("\n\n")}\n</hook-feedback>`
      },
      async dispose() {
        // Hooks guarding a turn are pointless once the instance goes away; Stop/Notification hooks may finish (they
        // are bounded by their own timeout) so `sente run` does not exit under them.
        running.forEach((set) => set.forEach((controller) => controller.abort()))
        await Promise.allSettled([...pending])
      },
    }
  }
}

export * as ConfigHooksRunner from "./config-hooks"

// Runs the shell commands configured under `hooks` (Claude Code hooks format) as a built-in plugin, on top of the
// existing plugin hooks: PreToolUse/PostToolUse = tool.execute.before/after, UserPromptSubmit + SessionStart =
// chat.message, Stop = session.idle event, Notification = permission.asked / question.asked events.
//
// A hook that fails, times out or prints garbage never takes Sente down: only an explicit block (exit code 2 or a
// JSON decision) changes what happens, everything else is logged and ignored.
import { spawn } from "child_process"
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

export function toolNames(tool: string) {
  return ALIASES[tool] ? [tool, ALIASES[tool]] : [tool]
}

export type Result = {
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
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

export function exec(
  command: string,
  input: unknown,
  options: { cwd: string; env?: Record<string, string | undefined>; timeout?: number },
): Promise<Result> {
  return new Promise((resolve) => {
    const out = { stdout: "", stderr: "" }
    const finish = (result: Omit<Result, "command" | "stdout" | "stderr">) => {
      clearTimeout(timer)
      clearTimeout(grace)
      resolve({ command, stdout: out.stdout, stderr: out.stderr, ...result })
    }
    const child = (() => {
      try {
        return spawn(command, {
          shell: true,
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          stdio: ["pipe", "pipe", "pipe"],
          // Own process group, so a timeout also kills whatever the command started.
          detached: process.platform !== "win32",
        })
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error))
      }
    })()
    let grace: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(
      () => {
        if (child instanceof Error) return
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL")
          else child.kill("SIGKILL")
        } catch {
          child.kill("SIGKILL")
        }
        finish({ exitCode: null, timedOut: true })
      },
      Math.max(0.001, options.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
    )
    if (child instanceof Error) return finish({ exitCode: null, timedOut: false, error: child.message })
    const append = (key: "stdout" | "stderr") => (chunk: Buffer) => {
      if (out[key].length < MAX_OUTPUT) out[key] = (out[key] + chunk.toString()).slice(0, MAX_OUTPUT)
    }
    child.stdout?.on("data", append("stdout"))
    child.stderr?.on("data", append("stderr"))
    child.on("error", (error) => finish({ exitCode: null, timedOut: false, error: error.message }))
    child.on("close", (code) => finish({ exitCode: code, timedOut: false }))
    // A command that leaves a background process holding stdout open would never "close"; stop waiting shortly after
    // the command itself exits.
    child.on("exit", (code) => {
      grace = setTimeout(() => finish({ exitCode: code, timedOut: false }), 200)
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
  warn?: (message: string) => void
}): Promise<Outcome> {
  const selected = input.hooks.filter(
    (hook) => hook.event === input.event && (!input.names || matches(hook.matcher, input.names)),
  )
  if (!selected.length) return { block: false, reasons: [], context: [], results: [] }
  // Every matching hook runs, in parallel, like Claude Code.
  const results = await Promise.all(
    selected.map((hook) =>
      exec(hook.command, input.payload, { cwd: input.cwd, env: input.env, timeout: hook.timeout }),
    ),
  )
  for (const result of results) {
    if (result.exitCode === 0 || result.exitCode === 2) continue
    const why = result.timedOut
      ? "timed out"
      : result.error
        ? result.error
        : `exit ${result.exitCode}${result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 500)}` : ""}`
    input.warn?.(`${input.event} hook failed (${why}), continuing: ${result.command}`)
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

// Sente tools use camelCase arguments (filePath); Claude Code scripts read snake_case (file_path). Offer both.
export function toolInput(args: unknown) {
  if (!isRecord(args)) return args
  return Object.entries(args).reduce<Record<string, unknown>>(
    (acc, [key, value]) => (snake(key) in acc ? acc : { ...acc, [snake(key)]: value }),
    { ...args },
  )
}

function applyUpdate(args: Record<string, unknown>, update: Record<string, unknown>) {
  for (const [key, value] of Object.entries(update)) {
    const target = key in args ? key : camel(key) in args ? camel(key) : key
    args[target] = value
  }
}

export function ConfigHooksPlugin(
  hooks: ConfigHooks.Origin[],
  options: { warn?: (message: string) => void } = {},
): Plugin {
  return async (input) => {
    if (!hooks.length) return {}
    const has = (event: string) => hooks.some((hook) => hook.event === event)
    const projectDir = input.worktree && input.worktree !== "/" ? input.worktree : input.directory
    const created = new Set<string>()
    const parents = new Map<string, Promise<boolean>>()
    const started = new Set<string>()
    const pending = new Set<Promise<unknown>>()

    const fire = (event: string, sessionID: string, extra: Record<string, unknown>, names?: string[]) =>
      run({
        hooks,
        event,
        names,
        cwd: input.directory,
        env: { SENTE_PROJECT_DIR: projectDir, CLAUDE_PROJECT_DIR: projectDir, SENTE_SESSION_ID: sessionID },
        warn: options.warn,
        payload: {
          session_id: sessionID,
          transcript_path: "",
          cwd: input.directory,
          permission_mode: "default",
          hook_event_name: event,
          ...extra,
        },
      })

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
        if (event.type === "session.idle" && sessionID && has("Stop")) {
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
        const outcome = await fire(
          "PreToolUse",
          meta.sessionID,
          { tool_name: meta.tool, tool_input: toolInput(output.args), tool_use_id: meta.callID },
          toolNames(meta.tool),
        )
        if (outcome.block) throw new Error(`PreToolUse hook blocked this tool call: ${outcome.reasons.join("; ")}`)
        if (outcome.updatedInput && isRecord(output.args)) applyUpdate(output.args, outcome.updatedInput)
      },
      async "tool.execute.after"(meta, output) {
        if (!has("PostToolUse")) return
        const outcome = await fire(
          "PostToolUse",
          meta.sessionID,
          {
            tool_name: meta.tool,
            tool_input: toolInput(meta.args),
            tool_use_id: meta.callID,
            tool_response: { title: output.title, output: SecretRedact.redact(output.output ?? "") },
          },
          toolNames(meta.tool),
        )
        const notes = [...outcome.reasons, ...outcome.context]
        if (notes.length)
          output.output = `${output.output ?? ""}\n\n<hook-feedback>\n${notes.join("\n\n")}\n</hook-feedback>`
      },
      async dispose() {
        await Promise.allSettled([...pending])
      },
    }
  }
}

import { Effect, Exit, Fiber, Option, Scope, Semaphore, Stream } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { FSUtil } from "@sente-ai/core/fs-util"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@sente-ai/core/shell"
import { ShellID } from "./shell/id"
import { ShellSandbox } from "./shell/sandbox"
import { ShellBackground } from "./shell/background"
import { Unattended } from "@/permission/unattended"
import { BackgroundJob } from "@/background/job"
import { SecretRedact } from "./secret-redact"
import type { TaskPromptOps } from "./task"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
// Serializes the per-session background limit check with registering the job (process-wide: cheap).
const admit = Semaphore.makeUnsafe(1)
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (
  ctx: Tool.Context,
  scan: Scan,
  input: { command: string },
  sandbox?: string,
) {
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {
        command: input.command,
        directories,
        patterns: globs,
      },
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {
      command: input.command,
      // Offered to a non-interactive run, which may approve it on the condition that it runs confined.
      ...(sandbox ? { sandbox } : {}),
    },
  })
})

/** May this command be approved on the condition that it runs confined? Never for denied-class commands. */
function confinable(scan: Scan, ps: boolean) {
  if (ps || !ShellSandbox.enabled() || Unattended.current()) return false
  if (scan.dirs.size > 0 || scan.patterns.size === 0) return false
  return Array.from(scan.patterns).every((pattern) =>
    Unattended.danger(pattern).every((kind) => ShellSandbox.CONTAINED.has(kind)),
  )
}

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv, sandbox?: string[]) {
  if (sandbox) {
    const confined = ShellSandbox.command(shell, command, sandbox)
    return ChildProcess.make(confined.file, confined.args, {
      cwd,
      env,
      stdin: "ignore",
      detached: true,
      forceKillAfter: "3 seconds",
    })
  }
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
      forceKillAfter: "3 seconds",
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
    // Closing the owning scope (abort, job cancel, instance dispose at exit) must not hang on a
    // process that ignores SIGTERM.
    forceKillAfter: "3 seconds",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const jobs = yield* BackgroundJob.Service
    const scope = yield* Scope.Scope
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return FSUtil.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            yield* Effect.logInfo("resolved path", { arg, resolved })
            if (!resolved || containsPath(resolved, instance)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...process.env,
        ...extra.env,
      }
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        /** Writable directories when the command runs confined. */
        sandbox?: string[]
        /** Move the command to the background when the timeout expires instead of killing it. */
        background: boolean
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false
      // Set once the process is handed to a background job; the tool call has returned by then.
      let detached = false
      // Serializes switching output from memory to the spill file between the reader and the handover.
      const lock = yield* Semaphore.make(1)

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      const spill = Effect.fnUntraced(function* () {
        if (file) return
        file = yield* trunc.write(full)
        sink = createWriteStream(file, { flags: "a" })
        full = ""
      })

      const format = Effect.fnUntraced(function* (code: number | null, meta: string[]) {
        if (input.sandbox) meta.push(ShellSandbox.NOTE)
        const raw = list.map((item) => item.text).join("")
        const end = tail(raw, limits.maxLines, limits.maxBytes)
        if (end.cut) cut = true
        if (!file && end.cut) {
          file = yield* trunc.write(raw)
        }

        let output = end.text
        if (!output) output = "(no output)"

        if (cut && file) {
          output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
        }

        if (meta.length > 0) {
          output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
        }
        return { output, cut }
      })

      yield* ctx.metadata({
        metadata: {
          output: "",
        },
      })

      // The process lives in its own scope so a timed-out command can outlive this tool call: the
      // scope is closed here (killing the process) unless it was handed to a background job.
      return yield* Effect.acquireUseRelease(
        Scope.make(),
        (owner) =>
          Effect.gen(function* () {
            const handle = yield* spawner
              .spawn(cmd(input.shell, input.command, input.cwd, input.env, input.sandbox))
              .pipe(Effect.provideService(Scope.Scope, owner))

            const reader = yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              last = preview(last + chunk)
              const update = detached ? Effect.void : ctx.metadata({ metadata: { output: last } })

              return lock.withPermits(1)(
                Effect.suspend(() => {
                  if (file) {
                    sink?.write(chunk)
                    return update
                  }
                  full += chunk
                  if (Buffer.byteLength(full, "utf-8") <= limits.maxBytes) return update
                  cut = true
                  return spill().pipe(Effect.andThen(update))
                }),
              )
            }).pipe(Effect.forkIn(owner, { startImmediately: true }))

            const abort = Effect.callback<void>((resume) => {
              if (ctx.abort.aborted) return resume(Effect.void)
              const handler = () => resume(Effect.void)
              ctx.abort.addEventListener("abort", handler, { once: true })
              return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
            })

            const timeout = Effect.sleep(`${input.timeout + 100} millis`)

            const exit = yield* Effect.raceAll([
              handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
              abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
              timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
            ])

            // A command that exited right at the deadline is simply done, not a background job.
            const lapsed = exit.kind === "timeout" && (yield* handle.isRunning)
            const settled =
              exit.kind === "timeout" && !lapsed
                ? {
                    kind: "exit" as const,
                    code: yield* handle.exitCode.pipe(Effect.catch(() => Effect.succeed(null))),
                  }
                : exit
            const maxJobs = flags.shellBackgroundMaxJobs ?? ShellBackground.DEFAULT_MAX_JOBS
            const session = ctx.extra?.session as { parentID?: string; metadata?: Record<string, unknown> } | undefined
            // The user message this turn answers (skipping server-added continuations): a
            // `sente run --attach` lease names the one it sent.
            const turn = ShellBackground.turnOrigin(ctx.messages)
            const mustWait = ShellBackground.mustWait(session, turn)
            // The `sente run --attach` whose turn started it.
            const run = ShellBackground.turnRun(session, turn)
            const pid = Number(handle.pid)
            const known = Number.isInteger(pid) && pid > 0
            const maxMs = flags.shellBackgroundMaxMs ?? ShellBackground.DEFAULT_MAX_MS
            // Counting and registering under one permit, so commands timing out together cannot all slip
            // past the per-session limit; uninterruptible until the job owns the process (no orphan).
            const info =
              lapsed && input.background
                ? yield* Effect.uninterruptible(
                    admit.withPermits(1)(
                      Effect.gen(function* () {
                        const running = (yield* jobs.list()).filter(
                          (job) =>
                            job.type === ShellID.ToolID &&
                            job.status === "running" &&
                            job.metadata?.sessionId === ctx.sessionID,
                        ).length
                        if (running >= maxJobs) return undefined
                        yield* lock.withPermits(1)(spill())
                        detached = true
                        return yield* jobs.start({
                          type: ShellID.ToolID,
                          title: input.command,
                          metadata: {
                            sessionId: ctx.sessionID,
                            background: true,
                            command: input.command,
                            outputPath: file,
                            mustWait,
                            ...(run ? { run } : {}),
                            ...(known ? { pid } : {}),
                          },
                          run: Effect.gen(function* () {
                            const finished = yield* handle.exitCode.pipe(
                              Effect.catch(() => Effect.succeed(null)),
                              Effect.timeoutOption(maxMs),
                            )
                            // Past the lifetime cap: stop it like a timeout used to.
                            if (Option.isNone(finished))
                              yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.ignore)
                            const code = Option.getOrNull(finished)
                            // Let the reader drain what the process wrote last (bounded: a grandchild may hold the pipe).
                            yield* Fiber.await(reader).pipe(Effect.timeoutOption("1 second"))
                            yield* closeSink()
                            const result = yield* format(
                              code,
                              Option.isNone(finished)
                                ? [
                                    `Stopped after running ${Math.round(maxMs / 60_000)} minutes in the background (limit set by SENTE_SHELL_BACKGROUND_MAX_MS).`,
                                  ]
                                : [],
                            )
                            return SecretRedact.redact(
                              `Exit code: ${code ?? "none (terminated by a signal)"}\n\n${result.output}`,
                            )
                          }).pipe(Effect.ensuring(Scope.close(owner, Exit.void).pipe(Effect.andThen(closeSink())))),
                        })
                      }),
                    ),
                  )
                : undefined
            const crowded = lapsed && input.background && !info

            if (info) {
              const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
              // Only an interactive top-level session reads a follow-up turn; the others wait in-turn.
              if (ops && !mustWait) {
                ShellBackground.expectAnnouncement(info.id)
                yield* jobs.wait({ id: info.id }).pipe(
                  Effect.flatMap((done) => {
                    const state = done.info?.status
                    // Decided once; a wait call that delivered the result suppresses it.
                    const announce = ShellBackground.takeAnnouncement(info.id)
                    if (state !== "completed" && state !== "error") return Effect.void
                    if (!announce) return Effect.void
                    return ops.prompt({
                      sessionID: ctx.sessionID,
                      agent: ctx.agent,
                      parts: [
                        {
                          type: "text",
                          synthetic: true,
                          text: [
                            `<background_shell job="${info.id}" state="${state}">`,
                            `<command>${SecretRedact.redact(input.command)}</command>`,
                            done.info?.output ?? done.info?.error ?? "",
                            "</background_shell>",
                          ].join("\n"),
                        },
                      ],
                    })
                  }),
                  Effect.ignore,
                  Effect.forkIn(scope, { startImmediately: true }),
                )
              }
              const result = yield* format(null, [
                `The command did not finish within its timeout of ${input.timeout} ms. It was NOT killed: it keeps running in the background as job ${info.id}${known ? ` (PID ${pid})` : ""}.`,
                `Output keeps streaming to: ${file}`,
                mustWait
                  ? `This session ends when you finish your reply, and the command is stopped then. Before you finish, call the wait tool with job "${info.id}"; if it returns pending, call it again until the job has finished.`
                  : "You will be notified automatically when it finishes. Wait for that notification instead of checking on it; if you have nothing else to do now, end your reply.",
                `Do not start another copy while it is running. To stop it early, call the wait tool with job "${info.id}" and stop: true.`,
                "(Setting SENTE_SHELL_TIMEOUT_BACKGROUND=0 turns this off: timed-out commands are then stopped.)",
              ])
              return {
                title: input.command,
                metadata: {
                  output: last || preview(result.output),
                  exit: null,
                  truncated: result.cut,
                  outputPath: file,
                  background: true,
                  jobId: info.id,
                  ...(known ? { pid } : {}),
                  ...(run ? { run } : {}),
                },
                output: result.output,
              }
            }

            if (settled.kind === "abort") {
              aborted = true
              yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
            }
            if (lapsed) {
              expired = true
              yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
            }

            const code: number | null = settled.kind === "exit" ? settled.code : null
            const meta: string[] = []
            if (crowded) {
              meta.push(
                `${maxJobs} timed-out commands are already running in the background in this session, so this one was stopped instead of joining them. Wait for or stop one of them first.`,
              )
            }
            if (expired) {
              meta.push(
                `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
              )
            }
            if (aborted) meta.push("User aborted the command")
            // Stop the reader and close the spill file before reading what was captured.
            yield* Scope.close(owner, Exit.void)
            yield* closeSink()
            const result = yield* format(code, meta)
            return {
              title: input.command,
              metadata: {
                output: last || preview(result.output),
                exit: code,
                truncated: result.cut,
                ...(result.cut && file ? { outputPath: file } : {}),
              },
              output: result.output,
            }
          }),
        (owner) => (detached ? Effect.void : Scope.close(owner, Exit.void).pipe(Effect.andThen(closeSink()))),
      ).pipe(Effect.orDie)
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(
          name,
          process.platform,
          limits,
          defaultTimeoutMs,
          flags.shellTimeoutBackground,
        )
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? defaultTimeoutMs
              const ps = Shell.ps(shell)
              let sandbox: string[] | undefined
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  const token = confinable(scan, ps) ? crypto.randomUUID() : undefined
                  yield* ask(ctx, scan, params, token)
                  // Approved by the run only on condition of confinement (an ordinary allow leaves no grant).
                  if (token && ShellSandbox.granted.delete(token))
                    // A project outside git reports its worktree as "/"; never make a filesystem root writable.
                    sandbox = [...new Set([instanceCtx.directory, instanceCtx.worktree, cwd])].filter(
                      (dir) => dir && path.parse(dir).root !== path.resolve(dir),
                    )
                }),
              )

              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                  sandbox,
                  background: flags.shellTimeoutBackground,
                },
                ctx,
              )
            }),
        }
      })
  }),
)

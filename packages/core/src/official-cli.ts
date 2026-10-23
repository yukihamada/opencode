import { spawn } from "cross-spawn"
import { realpathSync } from "node:fs"
import path from "node:path"

export interface OfficialCliSpec {
  binary: string
  loginArgs: string[]
  statusArgs: string[]
  install: string
  envKey: string
  plan: string
}

export function officialCliSpec(tool: "codex" | "claude"): OfficialCliSpec {
  if (tool === "codex") {
    return {
      binary: "codex",
      loginArgs: ["login"],
      statusArgs: ["login", "status"],
      install: "npm i -g @openai/codex (https://developers.openai.com/codex/cli)",
      envKey: "OPENAI_API_KEY",
      plan: "ChatGPT Plus/Pro",
    }
  }
  return {
    binary: "claude",
    loginArgs: ["auth", "login"],
    statusArgs: ["auth", "status"],
    install: "npm i -g @anthropic-ai/claude-code (https://code.claude.com/docs/en/setup)",
    envKey: "ANTHROPIC_API_KEY",
    plan: "Claude Pro/Max",
  }
}

export function officialCliCandidates(tool: "codex" | "claude", env = process.env) {
  const binary = officialCliSpec(tool).binary
  const paths = (env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, binary))
  const local = env.SENTE_BINARY
  if (local) paths.push(local)
  return [...new Set(paths)]
}

export function resolveOfficialCli(
  tool: "codex" | "claude",
  candidates = officialCliCandidates(tool),
  own = [process.execPath, process.argv[1], process.env.SENTE_BINARY],
) {
  const self = own
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .flatMap((value) => {
      try {
        return [realpathSync(value)]
      } catch {
        return []
      }
    })
  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate)
      if (self.includes(real)) continue
      return candidate
    } catch {
      continue
    }
  }
  return undefined
}

export type OfficialCliProbe = { ok: true } | { ok: false; reason: "missing" | "failed"; detail: string }

export function probeOfficialCli(
  binary: string,
  options: { timeoutMs?: number } = {},
): Promise<OfficialCliProbe> {
  const timeoutMs = options.timeoutMs ?? 5_000
  return new Promise((resolve) => {
    const child = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "pipe"] })
    let stderr = ""
    let settled = false
    const finish = (result: OfficialCliProbe) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish({ ok: false, reason: "failed", detail: `\`${binary} --version\` did not answer within ${timeoutMs}ms` })
    }, timeoutMs)
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        finish({ ok: false, reason: "missing", detail: `${binary} not found on PATH` })
        return
      }
      finish({ ok: false, reason: "failed", detail: error.message })
    })
    child.on("exit", (code, signal) => {
      if (code === 0) {
        finish({ ok: true })
        return
      }
      const detail = stderr.trim()
      finish({
        ok: false,
        reason: "failed",
        detail:
          `\`${binary} --version\` exited with ${signal ? `signal ${signal}` : `code ${code ?? "null"}`}` +
          (detail ? `: ${detail}` : ""),
      })
    })
  })
}

export type OfficialCliRun = { code: number } | { error: string }

export function runOfficialCli(
  binary: string,
  argv: string[],
  options: { cwd?: string } = {},
): Promise<OfficialCliRun> {
  return new Promise((resolve) => {
    const child = spawn(binary, argv, { cwd: options.cwd ?? process.cwd(), stdio: "inherit" })
    child.on("error", (error) => resolve({ error: error.message }))
    child.on("exit", (code, signal) => resolve({ code: code ?? (signal ? 1 : 0) }))
  })
}

export * as OfficialCli from "./official-cli"

import { spawn } from "node:child_process"
import { InstallationVersion } from "@sente-ai/core/installation/version"

export interface CodexAppServerWindow {
  usedPercent: number
  windowDurationMins?: number
  resetsAt?: number
}

export interface CodexAppServerLimit {
  limitId?: string
  limitName?: string | null
  primary?: CodexAppServerWindow | null
  secondary?: CodexAppServerWindow | null
  rateLimitReachedType?: string | null
}

export interface CodexAppServerAccount {
  type: string
  planType?: string | null
}

export interface CodexAppServerResult {
  account: CodexAppServerAccount | null
  requiresOpenaiAuth: boolean
  rateLimits: CodexAppServerLimit | null
  rateLimitsByLimitId: Record<string, CodexAppServerLimit>
}

export class CodexAppServerError extends Error {
  readonly reason: "not_installed" | "spawn_failed" | "exited" | "timeout" | "rpc_error" | "malformed"
  readonly accountAuthenticated: boolean
  constructor(reason: CodexAppServerError["reason"], message: string, accountAuthenticated = false) {
    super(message)
    this.name = "CodexAppServerError"
    this.reason = reason
    this.accountAuthenticated = accountAuthenticated
  }
}

const REQUEST_TIMEOUT_MS = 10_000
const MAX_LINE_BYTES = 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function parseWindow(value: unknown): CodexAppServerWindow | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const usedPercent = finiteNumber(value.usedPercent)
  if (usedPercent === undefined) return undefined
  return {
    usedPercent,
    ...(finiteNumber(value.windowDurationMins) !== undefined
      ? { windowDurationMins: finiteNumber(value.windowDurationMins) }
      : {}),
    ...(finiteNumber(value.resetsAt) !== undefined ? { resetsAt: finiteNumber(value.resetsAt) } : {}),
  }
}

function parseLimit(value: unknown): CodexAppServerLimit | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const primary = parseWindow(value.primary)
  const secondary = parseWindow(value.secondary)
  if (primary === undefined || secondary === undefined) return undefined
  return {
    ...(typeof value.limitId === "string" ? { limitId: value.limitId } : {}),
    ...(typeof value.limitName === "string" || value.limitName === null ? { limitName: value.limitName } : {}),
    primary,
    secondary,
    ...(typeof value.rateLimitReachedType === "string" || value.rateLimitReachedType === null
      ? { rateLimitReachedType: value.rateLimitReachedType }
      : {}),
  }
}

function parseAccount(value: unknown): CodexAppServerAccount | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  if (typeof value.type !== "string") return undefined
  return {
    type: value.type,
    ...(typeof value.planType === "string" || value.planType === null ? { planType: value.planType } : {}),
  }
}

function parseAccountResult(value: unknown): { account: CodexAppServerAccount | null; requiresOpenaiAuth: boolean } | undefined {
  if (!isRecord(value)) return undefined
  const account = parseAccount(value.account)
  if (account === undefined) return undefined
  return { account, requiresOpenaiAuth: value.requiresOpenaiAuth === true }
}

function parseRateLimitsResult(value: unknown): {
  rateLimits: CodexAppServerLimit | null
  rateLimitsByLimitId: Record<string, CodexAppServerLimit>
} | undefined {
  if (!isRecord(value)) return undefined
  const rateLimits = parseLimit(value.rateLimits)
  if (rateLimits === undefined) return undefined
  const byId: Record<string, CodexAppServerLimit> = {}
  if (value.rateLimitsByLimitId !== undefined && value.rateLimitsByLimitId !== null) {
    if (!isRecord(value.rateLimitsByLimitId)) return undefined
    for (const [key, entry] of Object.entries(value.rateLimitsByLimitId)) {
      const parsed = parseLimit(entry)
      if (!parsed) return undefined
      byId[key] = parsed
    }
  }
  return { rateLimits, rateLimitsByLimitId: byId }
}

export async function readCodexAppServerAccount(
  options: { command?: string; timeoutMs?: number } = {},
): Promise<CodexAppServerResult> {
  const command = options.command ?? "codex"
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS

  const child = spawn(command, ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  })
  child.stderr?.resume()

  let nextId = 0
  let settled = false
  let accountAuthenticated = false
  let buffered = 0
  let newline = -1
  const chunks: Buffer[] = []
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  const stop = () => {
    child.stdout?.removeAllListeners()
    child.stdout?.pause()
    child.stdin?.end()
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill("SIGTERM")
    const escalated = setTimeout(() => child.kill("SIGKILL"), 1_000)
    escalated.unref()
    child.once("exit", () => clearTimeout(escalated))
    child.unref()
  }

  const fail = (error: CodexAppServerError) => {
    if (settled) return
    settled = true
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
    stop()
  }

  const exited = new Promise<never>((_, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        new CodexAppServerError(
          error.code === "ENOENT" ? "not_installed" : "spawn_failed",
          error.code === "ENOENT"
            ? "The official `codex` CLI is not installed. Install it to read ChatGPT Codex subscription quota."
            : `Failed to start \`codex app-server\`: ${error.message}`,
          accountAuthenticated,
        ),
      )
    })
    child.once("exit", (code, signal) => {
      reject(
        new CodexAppServerError(
          "exited",
          `\`codex app-server\` exited before answering (code ${code ?? "null"}, signal ${signal ?? "null"})`,
          accountAuthenticated,
        ),
      )
    })
  })
  void exited.catch(() => undefined)

  const write = (message: Record<string, unknown>) => {
    try {
      child.stdin!.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) fail(new CodexAppServerError("exited", "Codex app-server input closed", accountAuthenticated))
      })
    } catch {
      fail(new CodexAppServerError("exited", "Codex app-server input closed", accountAuthenticated))
    }
  }
  child.stdin?.on("error", () => {
    fail(new CodexAppServerError("exited", "Codex app-server input closed", accountAuthenticated))
  })

  const handleLine = (line: string) => {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      fail(new CodexAppServerError("malformed", "`codex app-server` sent a non-JSON message", accountAuthenticated))
      return
    }
    if (!isRecord(message)) return
    if (message.id !== undefined && typeof message.method === "string") {
      write({ id: message.id, error: { code: -32601, message: "Sente does not handle server-initiated requests" } })
      return
    }
    if (typeof message.id !== "number") return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error !== undefined) {
      const detail = isRecord(message.error) && typeof message.error.message === "string" ? message.error.message : "unknown error"
      entry.reject(new CodexAppServerError("rpc_error", `\`codex app-server\` RPC error: ${detail}`, accountAuthenticated))
      return
    }
    entry.resolve(message.result)
  }

  const handleChunk = (chunk: Buffer) => {
    if (settled) return
    buffered += chunk.length
    chunks.push(chunk)
    if (buffered > MAX_LINE_BYTES && newline < 0) {
      fail(new CodexAppServerError("malformed", "`codex app-server` sent an oversized message", accountAuthenticated))
      return
    }
    while (true) {
      if (newline < 0) {
        newline = Buffer.concat(chunks).indexOf(0x0a)
        if (newline < 0) return
      }
      const line = Buffer.concat(chunks).subarray(0, newline).toString("utf8")
      const rest = Buffer.concat(chunks).subarray(newline + 1)
      chunks.length = 0
      if (rest.length) chunks.push(rest)
      buffered = rest.length
      newline = rest.indexOf(0x0a)
      handleLine(line)
      if (settled || newline < 0) return
    }
  }
  child.stdout?.on("data", handleChunk)

  const request = (method: string, params?: Record<string, unknown>) =>
    Promise.race([
      new Promise<unknown>((resolve, reject) => {
        const id = ++nextId
        pending.set(id, { resolve, reject })
        write(params === undefined ? { method, id } : { method, id, params })
      }),
      exited,
    ])

  const timer = setTimeout(() => {
    fail(new CodexAppServerError("timeout", `\`codex app-server\` did not answer within ${timeoutMs}ms`, accountAuthenticated))
  }, timeoutMs)

  try {
    await request("initialize", {
      clientInfo: { name: "sente", title: "Sente", version: InstallationVersion },
    })
    write({ method: "initialized", params: {} })
    const accountResult = await request("account/read", { refreshToken: false })
    const account = parseAccountResult(accountResult)
    if (!account) throw new CodexAppServerError("malformed", "`codex app-server` account/read returned an unexpected shape")
    accountAuthenticated = account.account?.type === "chatgpt"
    if (!accountAuthenticated) return { ...account, rateLimits: null, rateLimitsByLimitId: {} }
    const rateLimitsResult = await request("account/rateLimits/read")
    const rateLimits = parseRateLimitsResult(rateLimitsResult)
    if (!rateLimits)
      throw new CodexAppServerError(
        "malformed",
        "`codex app-server` account/rateLimits/read returned an unexpected shape",
        accountAuthenticated,
      )
    return { ...account, ...rateLimits }
  } finally {
    clearTimeout(timer)
    settled = true
    stop()
  }
}

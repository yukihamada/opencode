import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  CodexAppServerError,
  readCodexAppServerAccount,
} from "../../src/plugin/openai/codex-app-server"

const dirs: string[] = []

async function fakeCodex(script: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-app-server-test-"))
  dirs.push(dir)
  const file = path.join(dir, "codex")
  await writeFile(file, script)
  await chmod(file, 0o755)
  return file
}

function nodeServer(handler: string): string {
  return `#!/usr/bin/env node
const readline = require("node:readline")
const rl = readline.createInterface({ input: process.stdin })
const handler = ${handler}
rl.on("line", (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const out = handler(message)
  if (out) process.stdout.write(JSON.stringify(out) + "\\n")
})
`
}

const chatgptAccount = `(message) => {
  if (message.method === "initialize") {
    if (message.params?.clientInfo?.name !== "sente") throw new Error("missing clientInfo")
    return { id: message.id, result: { userAgent: "codex/test" } }
  }
  if (message.method === "initialized") return null
  if (message.method === "account/read") {
    return {
      id: message.id,
      result: {
        account: { type: "chatgpt", email: "user@example.com", planType: "pro" },
        requiresOpenaiAuth: true,
      },
    }
  }
  if (message.method === "account/rateLimits/read") {
    return {
      id: message.id,
      result: {
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 1730947200 },
          secondary: null,
          rateLimitReachedType: null,
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: null,
            primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 1730947200 },
            secondary: null,
            rateLimitReachedType: null,
          },
          codex_other: {
            limitId: "codex_other",
            limitName: "codex_other",
            primary: { usedPercent: 42, windowDurationMins: 60, resetsAt: 1730950800 },
            secondary: null,
            rateLimitReachedType: null,
          },
        },
        rateLimitResetCredits: null,
      },
    }
  }
  return null
}`

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

describe("plugin.codex-app-server", () => {
  test("reads account and rate limits through initialize/initialized handshake", async () => {
    const command = await fakeCodex(nodeServer(chatgptAccount))

    const result = await readCodexAppServerAccount({ command })

    expect(result.account).toEqual({ type: "chatgpt", planType: "pro" })
    expect(result.requiresOpenaiAuth).toBe(true)
    expect(result.rateLimits?.primary?.usedPercent).toBe(25)
    expect(result.rateLimitsByLimitId.codex_other?.primary?.usedPercent).toBe(42)
  })

  test("reports not_installed when the codex binary is missing", async () => {
    const error = await readCodexAppServerAccount({
      command: path.join(tmpdir(), "definitely-not-a-real-codex-binary"),
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CodexAppServerError)
    expect((error as CodexAppServerError).reason).toBe("not_installed")
    expect((error as CodexAppServerError).accountAuthenticated).toBe(false)
  })

  test("reports exited when the server dies before answering", async () => {
    const command = await fakeCodex("#!/bin/sh\nexit 1\n")
    const error = await readCodexAppServerAccount({ command }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CodexAppServerError)
    expect((error as CodexAppServerError).reason).toBe("exited")
  })

  test("reports exited when the server dies after authentication and flags the account state", async () => {
    const command = await fakeCodex(
      nodeServer(`(message) => {
        if (message.method === "initialize") return { id: message.id, result: {} }
        if (message.method === "initialized") return null
        if (message.method === "account/read") {
          return { id: message.id, result: { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: true } }
        }
        if (message.method === "account/rateLimits/read") process.exit(1)
        return null
      }`),
    )
    const error = await readCodexAppServerAccount({ command }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CodexAppServerError)
    expect((error as CodexAppServerError).reason).toBe("exited")
    expect((error as CodexAppServerError).accountAuthenticated).toBe(true)
  })

  test("reports malformed on non-JSON output", async () => {
    const command = await fakeCodex("#!/bin/sh\necho not-json\nsleep 5\n")
    const error = await readCodexAppServerAccount({ command }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CodexAppServerError)
    expect((error as CodexAppServerError).reason).toBe("malformed")
  })

  test("reports malformed on an oversized pre-newline flood", async () => {
    const command = await fakeCodex(
      `#!/usr/bin/env node
process.stdout.write("x".repeat(2 * 1024 * 1024))
setTimeout(() => process.exit(0), 5000)
`,
    )
    const error = await readCodexAppServerAccount({ command }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CodexAppServerError)
    expect((error as CodexAppServerError).reason).toBe("malformed")
    expect((error as CodexAppServerError).message).toContain("oversized")
  })

  test("reports malformed on unexpected response shapes", async () => {
    const command = await fakeCodex(
      nodeServer(`(message) => {
        if (message.method === "initialize") return { id: message.id, result: {} }
        if (message.method === "initialized") return null
        if (message.method === "account/read") return { id: message.id, result: { account: "nope" } }
        return null
      }`),
    )
    const error = await readCodexAppServerAccount({ command }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CodexAppServerError)
    expect((error as CodexAppServerError).reason).toBe("malformed")
  })

  test("surfaces RPC errors without inventing quota", async () => {
    const command = await fakeCodex(
      nodeServer(`(message) => {
        if (message.method === "initialize") return { id: message.id, result: {} }
        if (message.method === "initialized") return null
        if (message.method === "account/read") {
          return { id: message.id, result: { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: true } }
        }
        if (message.method === "account/rateLimits/read") {
          return { id: message.id, error: { code: -32000, message: "upstream exploded" } }
        }
        return null
      }`),
    )
    const error = await readCodexAppServerAccount({ command }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CodexAppServerError)
    expect((error as CodexAppServerError).reason).toBe("rpc_error")
    expect((error as CodexAppServerError).message).toContain("upstream exploded")
    expect((error as CodexAppServerError).accountAuthenticated).toBe(true)
  })

  test("returns empty rate limits without querying them when the account is not ChatGPT", async () => {
    const command = await fakeCodex(
      nodeServer(`(message) => {
        if (message.method === "initialize") return { id: message.id, result: {} }
        if (message.method === "initialized") return null
        if (message.method === "account/read") {
          return { id: message.id, result: { account: { type: "apiKey" }, requiresOpenaiAuth: true } }
        }
        if (message.method === "account/rateLimits/read") {
          return { id: message.id, error: { code: -32000, message: "must not be called" } }
        }
        return null
      }`),
    )
    const result = await readCodexAppServerAccount({ command })
    expect(result.account).toEqual({ type: "apiKey" })
    expect(result.rateLimits).toBeNull()
    expect(result.rateLimitsByLimitId).toEqual({})
  })

  test("returns empty rate limits without querying them when no account is signed in", async () => {
    const command = await fakeCodex(
      nodeServer(`(message) => {
        if (message.method === "initialize") return { id: message.id, result: {} }
        if (message.method === "initialized") return null
        if (message.method === "account/read") {
          return { id: message.id, result: { account: null, requiresOpenaiAuth: true } }
        }
        if (message.method === "account/rateLimits/read") {
          return { id: message.id, error: { code: -32000, message: "must not be called" } }
        }
        return null
      }`),
    )
    const result = await readCodexAppServerAccount({ command })
    expect(result.account).toBeNull()
    expect(result.rateLimits).toBeNull()
    expect(result.rateLimitsByLimitId).toEqual({})
  })

  test("times out when the server never answers", async () => {
    const command = await fakeCodex("#!/bin/sh\nsleep 5\n")
    const error = await readCodexAppServerAccount({ command, timeoutMs: 500 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CodexAppServerError)
    expect((error as CodexAppServerError).reason).toBe("timeout")
  })

  test("rejects server-initiated requests and never matches them to pending ids", async () => {
    const command = await fakeCodex(
      nodeServer(`(message) => {
        if (message.method === "initialize") {
          setTimeout(() => {
            process.stdout.write(
              JSON.stringify({ method: "item/commandExecution/requestApproval", id: 2, params: {} }) + "\\n",
            )
          }, 10)
          return { id: message.id, result: {} }
        }
        if (message.method === "initialized") return null
        if (message.id === 2 && message.error) return null
        if (message.method === "account/read") {
          return { id: message.id, result: { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: true } }
        }
        if (message.method === "account/rateLimits/read") {
          return { id: message.id, result: { rateLimits: null, rateLimitsByLimitId: {} } }
        }
        return null
      }`),
    )
    const result = await readCodexAppServerAccount({ command })
    expect(result.account?.type).toBe("chatgpt")
    expect(result.rateLimits).toBeNull()
  })

  test("does not echo child stderr into errors", async () => {
    const command = await fakeCodex("#!/bin/sh\necho sk-secret-token-value 1>&2\nexit 1\n")
    const error = await readCodexAppServerAccount({ command }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CodexAppServerError)
    expect((error as CodexAppServerError).message).not.toContain("sk-secret-token-value")
  })

  test("kills the child process during cleanup", async () => {
    const pidDir = await mkdtemp(path.join(tmpdir(), "codex-app-server-pid-"))
    dirs.push(pidDir)
    const pidFile = path.join(pidDir, "pid")
    const command = await fakeCodex(
      `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
const readline = require("node:readline")
readline.createInterface({ input: process.stdin })
setInterval(() => {}, 1000)
`,
    )
    const started = readCodexAppServerAccount({ command, timeoutMs: 500 }).catch((e: unknown) => e)
    let pid = ""
    for (let i = 0; i < 100 && !pid; i++) {
      pid = await Bun.file(pidFile)
        .text()
        .catch(() => "")
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(pid).not.toBe("")
    const error = await started
    expect((error as CodexAppServerError).reason).toBe("timeout")
    const alive = await Promise.race([
      new Promise<"dead">((resolve) => {
        const check = () => {
          try {
            process.kill(Number(pid), 0)
            setTimeout(check, 25)
          } catch {
            resolve("dead")
          }
        }
        check()
      }),
      new Promise<"alive">((resolve) => setTimeout(() => resolve("alive"), 3_000)),
    ])
    expect(alive).toBe("dead")
  })
})

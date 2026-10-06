import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { APICallError } from "ai"
import { ProviderV2 } from "@sente-ai/core/provider"
import { authErrorText, loginHint } from "@sente-ai/tui/util/teai"
import { ProviderError } from "@/provider/error"
import { ProviderKeyReload } from "@/provider/key-reload"

const OLD = "te_old_key_0000000000"
const NEW = "te_new_key_1111111111"
const URL_ = "https://api.teai.example/v1/chat/completions"

type Call = { key: string; body: unknown }

/** Fake upstream: answers per key, records what it was asked. Never touches the network. */
function upstream(answer: (key: string) => Response) {
  const calls: Call[] = []
  const fetch = async (_input: any, init?: any) => {
    const key = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer\s+/i, "")
    calls.push({ key, body: init?.body })
    return answer(key)
  }
  return { calls, fetch }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

const ok = () => json(200, { ok: true })
const revoked = () => json(401, { error: { message: "Invalid API key", code: "invalid_api_key" } })
const monthly = () =>
  json(402, { error: { message: "This API key has reached its monthly limit", code: "api_key_monthly_limit_exceeded" } })
const balance = () => json(402, { error: { message: "Insufficient credits", code: "insufficient_credits" } })
const demo = () => json(402, { error: { message: "こちらはデモです", code: "anonymous_demo_only", type: "signup_required" } })

function request(key: string | undefined, body: unknown = '{"messages":[]}') {
  return { method: "POST", headers: key === undefined ? {} : { Authorization: `Bearer ${key}` }, body }
}

describe("ProviderKeyReload.failure", () => {
  test("separates revoked key, key cap, balance and keyless demo", () => {
    expect(ProviderKeyReload.failure(401, "")).toBe("invalid")
    expect(ProviderKeyReload.failure(402, '{"error":{"code":"api_key_monthly_limit_exceeded"}}')).toBe("limit")
    expect(ProviderKeyReload.failure(402, '{"error":{"code":"api_key_daily_limit_exceeded"}}')).toBe("limit")
    expect(ProviderKeyReload.failure(402, '{"error":{"code":"insufficient_credits"}}')).toBe("balance")
    expect(ProviderKeyReload.failure(402, '{"error":{"code":"anonymous_demo_only"}}')).toBe("demo")
    expect(ProviderKeyReload.failure(409, '{"error":"api key revoked"}')).toBe("invalid")
  })

  test("leaves unrelated failures alone", () => {
    expect(ProviderKeyReload.failure(403, '{"error":"content policy"}')).toBeUndefined()
    expect(ProviderKeyReload.failure(409, '{"error":"conflict"}')).toBeUndefined()
    expect(ProviderKeyReload.failure(429, "rate limited")).toBeUndefined()
    expect(ProviderKeyReload.failure(500, "invalid api key")).toBeUndefined()
  })
})

describe("ProviderKeyReload.wrap", () => {
  for (const [name, failed] of [
    ["revoked key (401)", revoked],
    ["key monthly cap (402)", monthly],
    ["empty balance (402)", balance],
  ] as const) {
    test(`${name}: retries once with the saved key when it changed`, async () => {
      const up = upstream((key) => (key === NEW ? ok() : failed()))
      const env: Record<string, string | undefined> = { TEAI_API_KEY: OLD }
      const swaps: unknown[] = []
      const fetch = ProviderKeyReload.wrap(up.fetch, { env, read: async () => NEW, onSwap: (info) => swaps.push(info) })

      const response = await fetch(URL_, request(OLD))

      expect(response.status).toBe(200)
      expect(up.calls.map((call) => call.key)).toEqual([OLD, NEW])
      expect(up.calls[1].body).toBe(up.calls[0].body)
      expect(env.TEAI_API_KEY).toBe(NEW)
      expect(swaps).toHaveLength(1)
      expect(JSON.stringify(swaps)).not.toContain("te_")
    })
  }

  test("a session started without a key picks up a login made elsewhere", async () => {
    const up = upstream((key) => (key === NEW ? ok() : demo()))
    const fetch = ProviderKeyReload.wrap(up.fetch, { env: {}, read: async () => NEW })

    expect((await fetch(URL_, request(undefined))).status).toBe(200)
    expect(up.calls.map((call) => call.key)).toEqual(["", NEW])
  })

  test("later requests go straight out with the new key", async () => {
    const up = upstream((key) => (key === NEW ? ok() : revoked()))
    const fetch = ProviderKeyReload.wrap(up.fetch, { env: {}, read: async () => NEW })

    await fetch(URL_, request(OLD))
    await fetch(URL_, request(OLD))
    await fetch(URL_, request(OLD))

    expect(up.calls.map((call) => call.key)).toEqual([OLD, NEW, NEW, NEW])
  })

  test("unchanged key: no retry, the original failure is returned untouched", async () => {
    const up = upstream(() => monthly())
    let reads = 0
    const fetch = ProviderKeyReload.wrap(up.fetch, {
      env: {},
      read: async () => {
        reads++
        return OLD
      },
    })

    const response = await fetch(URL_, request(OLD))

    expect(response.status).toBe(402)
    expect((await response.json()).error.code).toBe("api_key_monthly_limit_exceeded")
    expect(up.calls).toHaveLength(1)
    expect(reads).toBe(1)
  })

  test("no saved key: no retry", async () => {
    const up = upstream(() => revoked())
    const fetch = ProviderKeyReload.wrap(up.fetch, { env: {}, read: async () => undefined })

    expect((await fetch(URL_, request(OLD))).status).toBe(401)
    expect(up.calls).toHaveLength(1)
  })

  test("never loops: a new key that also fails is tried exactly once per request", async () => {
    const up = upstream(() => revoked())
    const fetch = ProviderKeyReload.wrap(up.fetch, { env: {}, read: async () => NEW })

    expect((await fetch(URL_, request(OLD))).status).toBe(401)
    expect(up.calls.map((call) => call.key)).toEqual([OLD, NEW])

    // Same saved key next time: nothing new to try, so a single request.
    expect((await fetch(URL_, request(OLD))).status).toBe(401)
    expect(up.calls.map((call) => call.key)).toEqual([OLD, NEW, NEW])
  })

  test("an explicit env key is never replaced by the saved one", async () => {
    const up = upstream((key) => (key === NEW ? ok() : balance()))
    const env = { TEAI_API_KEY: OLD, [ProviderKeyReload.SOURCE_ENV]: "env" }
    const fetch = ProviderKeyReload.wrap(up.fetch, { env, read: async () => NEW })

    expect((await fetch(URL_, request(OLD))).status).toBe(402)
    expect(up.calls.map((call) => call.key)).toEqual([OLD])
    expect(env.TEAI_API_KEY).toBe(OLD)
  })

  test("protected mode never reads the real key", async () => {
    const up = upstream(() => revoked())
    let reads = 0
    const fetch = ProviderKeyReload.wrap(up.fetch, {
      env: { SENTE_SCRUB_KEY: "proxy" },
      read: async () => {
        reads++
        return NEW
      },
    })

    expect((await fetch(URL_, request(OLD))).status).toBe(401)
    expect(reads).toBe(0)
    expect(up.calls).toHaveLength(1)
  })

  test("unrelated failures and successes do not read credentials", async () => {
    let reads = 0
    const read = async () => {
      reads++
      return NEW
    }
    for (const answer of [ok, () => json(500, { error: "boom" }), () => json(429, { error: "slow down" })]) {
      const up = upstream(answer)
      await ProviderKeyReload.wrap(up.fetch, { env: {}, read })(URL_, request(OLD))
      expect(up.calls).toHaveLength(1)
    }
    expect(reads).toBe(0)
  })

  test("a one-shot stream body is not replayed", async () => {
    const up = upstream(() => revoked())
    const fetch = ProviderKeyReload.wrap(up.fetch, { env: {}, read: async () => NEW })
    const body = new ReadableStream({ start: (ctrl) => ctrl.close() })

    expect((await fetch(URL_, request(OLD, body))).status).toBe(401)
    expect(up.calls).toHaveLength(1)
  })
})

describe("saved credentials on disk", () => {
  async function home(content?: string) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sente-key-reload-"))
    if (content !== undefined) {
      await mkdir(path.join(dir, ".config", "teai"), { recursive: true })
      await writeFile(path.join(dir, ".config", "teai", "credentials"), content)
    }
    return dir
  }

  test("reads the key the launcher saved; missing file is not an error", async () => {
    expect(await ProviderKeyReload.savedKey({}, await home(`# teai\nTEAI_API_KEY=${NEW}\n`))).toBe(NEW)
    expect(await ProviderKeyReload.savedKey({}, await home())).toBeUndefined()
    expect(await ProviderKeyReload.savedKey({ SENTE_SCRUB_KEY: "proxy" }, await home(`TEAI_API_KEY=${NEW}\n`))).toBeUndefined()
  })

  test("markSource: saved or absent key may follow rotations, a different env key may not", async () => {
    const same: Record<string, string | undefined> = { TEAI_API_KEY: NEW }
    await ProviderKeyReload.markSource(same, await home(`TEAI_API_KEY=${NEW}\n`))
    expect(same[ProviderKeyReload.SOURCE_ENV]).toBe("saved")

    const none: Record<string, string | undefined> = {}
    await ProviderKeyReload.markSource(none, await home())
    expect(none[ProviderKeyReload.SOURCE_ENV]).toBe("saved")

    const override: Record<string, string | undefined> = { TEAI_API_KEY: OLD }
    await ProviderKeyReload.markSource(override, await home(`TEAI_API_KEY=${NEW}\n`))
    expect(override[ProviderKeyReload.SOURCE_ENV]).toBe("env")

    // Already decided at launch: a worker that inherits the mark does not re-decide after a rotation.
    await ProviderKeyReload.markSource(same, await home(`TEAI_API_KEY=${OLD}\n`))
    expect(same[ProviderKeyReload.SOURCE_ENV]).toBe("saved")
  })

  test("end to end with the file: rotate on disk, next failure swaps", async () => {
    const dir = await home(`TEAI_API_KEY=${OLD}\n`)
    const env: Record<string, string | undefined> = { TEAI_API_KEY: OLD }
    await ProviderKeyReload.markSource(env, dir)
    const up = upstream((key) => (key === NEW ? ok() : revoked()))
    const fetch = ProviderKeyReload.wrap(up.fetch, { env, home: dir })

    expect((await fetch(URL_, request(OLD))).status).toBe(401)
    await writeFile(path.join(dir, ".config", "teai", "credentials"), `TEAI_API_KEY=${NEW}\n`)
    expect((await fetch(URL_, request(OLD))).status).toBe(200)
    expect(up.calls.map((call) => call.key)).toEqual([OLD, OLD, NEW])
  })
})

describe("unchanged key: the stored error still names its cause and next step", () => {
  const ja = { TEAI_SITE: "https://teai.io", LANG: "ja_JP.UTF-8" }

  function stored(statusCode: number, body: unknown) {
    const parsed = ProviderError.parseAPICallError({
      providerID: ProviderV2.ID.make("teai"),
      error: new APICallError({
        message: (body as { error: { message: string } }).error.message,
        url: URL_,
        requestBodyValues: {},
        statusCode,
        responseBody: JSON.stringify(body),
        isRetryable: false,
      }),
    })
    if (parsed.type !== "api_error") throw new Error("expected api_error")
    return { name: "APIError", data: parsed }
  }

  function hint(error: ReturnType<typeof stored>) {
    return loginHint(authErrorText(error, "teai", error.data.message), ja)
  }

  test("key monthly cap → te key rotate / dashboard", () => {
    const line = hint(stored(402, { error: { message: "This API key has reached its monthly limit", code: "api_key_monthly_limit_exceeded" } }))
    expect(line).toContain("月次上限")
    expect(line).toContain("te key rotate")
  })

  test("empty balance → top up", () => {
    const line = hint(stored(402, { error: { message: "Insufficient credits", code: "insufficient_credits" } }))
    expect(line).toContain("残高不足")
    expect(line).toContain("https://teai.io/pricing")
  })

  test("revoked key → /login", () => {
    const line = hint(stored(401, { error: { message: "Invalid API key", code: "invalid_api_key" } }))
    expect(line).toContain("キーが無効")
    expect(line).toContain("/login")
  })

  test("anything else gets no account advice", () => {
    expect(hint(stored(500, { error: { message: "upstream exploded" } }))).toBeUndefined()
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "fs/promises"
import os from "os"
import path from "path"
import {
  apiBase,
  configDir,
  credentialsPath,
  formatCredits,
  loginHint,
  looksLikeKey,
  normalizeKey,
  parseCredentials,
  renderCredentials,
  saveCredentials,
  verifyKey,
} from "../../src/util/teai"

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("util.teai paths", () => {
  test("TE_CONFIG_DIR wins over the default ~/.config/teai", () => {
    expect(configDir({}, "/home/u")).toBe(path.join("/home/u", ".config", "teai"))
    expect(configDir({ TE_CONFIG_DIR: "/tmp/teai-x" }, "/home/u")).toBe("/tmp/teai-x")
    expect(credentialsPath({ TE_CONFIG_DIR: " " }, "/home/u")).toBe(
      path.join("/home/u", ".config", "teai", "credentials"),
    )
  })

  test("api base honours TEAI_API and strips trailing slashes", () => {
    expect(apiBase({})).toBe("https://api.teai.io")
    expect(apiBase({ TEAI_API: "http://localhost:8787/" })).toBe("http://localhost:8787")
  })
})

describe("util.teai keys", () => {
  test("normalizeKey accepts the raw key or a pasted credentials line", () => {
    expect(normalizeKey("  te_abc123def456  ")).toBe("te_abc123def456")
    expect(normalizeKey("TEAI_API_KEY=te_abc123def456")).toBe("te_abc123def456")
    expect(normalizeKey('export TEAI_API_KEY="te_abc123def456"')).toBe("te_abc123def456")
  })

  test("looksLikeKey only accepts te_ prefixed keys", () => {
    expect(looksLikeKey("te_527a7f58c9424183bbd1f50edb22256c")).toBe(true)
    expect(looksLikeKey("sk-ant-xxxx")).toBe(false)
    expect(looksLikeKey("te_")).toBe(false)
  })

  test("parseCredentials reads the launcher's file format", () => {
    expect(parseCredentials("TEAI_API_KEY=te_one\n")).toBe("te_one")
    expect(parseCredentials("# comment\nexport TEAI_API_KEY='te_two'\n")).toBe("te_two")
    expect(parseCredentials("OTHER=1\n")).toBeUndefined()
    expect(parseCredentials("TEAI_API_KEY=\n")).toBeUndefined()
  })

  test("renderCredentials replaces the key line and keeps everything else", () => {
    const before = "# managed by te\nTEAI_API_KEY=te_old\nTEAI_VOICE_KEY=te_voice\n"
    expect(renderCredentials(before, "te_new")).toBe("# managed by te\nTEAI_API_KEY=te_new\nTEAI_VOICE_KEY=te_voice\n")
    expect(renderCredentials("", "te_new")).toBe("TEAI_API_KEY=te_new\n")
    expect(renderCredentials("FOO=bar", "te_new")).toBe("FOO=bar\nTEAI_API_KEY=te_new\n")
  })

  test("saveCredentials writes 0600 and round-trips through parseCredentials", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "teai-login-"))
    temps.push(dir)
    const file = path.join(dir, "nested", "credentials")
    await saveCredentials("te_first", file)
    await saveCredentials("te_second", file)
    const text = await readFile(file, "utf8")
    expect(parseCredentials(text)).toBe("te_second")
    expect(text.match(/TEAI_API_KEY=/g)?.length).toBe(1)
    if (process.platform !== "win32") {
      const mode = (await stat(file)).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })
})

describe("util.teai verifyKey", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

  test("accepts authenticated:true and returns the account", async () => {
    let seen: { url: string; auth: string | null } | undefined
    const result = await verifyKey("te_good", {
      api: "https://api.example",
      fetch: async (url, init) => {
        seen = { url, auth: new Headers(init?.headers).get("authorization") }
        return json(200, { authenticated: true, email: "a@b.c", plan: "starter", credits_remaining: 42 })
      },
    })
    expect(seen).toEqual({ url: "https://api.example/api/v1/auth/me", auth: "Bearer te_good" })
    expect(result).toEqual({
      ok: true,
      account: { email: "a@b.c", display_name: undefined, plan: "starter", credits_remaining: 42 },
    })
  })

  test("401 or authenticated:false is invalid, 5xx and thrown errors are network", async () => {
    const invalid = await verifyKey("te_bad", { api: "x", fetch: async () => json(401, { error: "nope" }) })
    expect(invalid).toEqual({ ok: false, reason: "invalid", detail: "HTTP 401" })

    const anon = await verifyKey("te_bad", { api: "x", fetch: async () => json(200, { authenticated: false }) })
    expect(anon.ok).toBe(false)
    if (!anon.ok) expect(anon.reason).toBe("invalid")

    const down = await verifyKey("te_x", { api: "x", fetch: async () => json(503, {}) })
    expect(down).toEqual({ ok: false, reason: "network", detail: "HTTP 503" })

    const thrown = await verifyKey("te_x", {
      api: "x",
      fetch: async () => {
        throw new Error("ECONNREFUSED")
      },
    })
    expect(thrown).toEqual({ ok: false, reason: "network", detail: "ECONNREFUSED" })
  })
})

describe("util.teai hints", () => {
  const env = { TEAI_SITE: "https://teai.io" }

  test("demo-mode message points at /login", () => {
    const hint = loginHint(
      "こちらはデモです。用意した例なら今すぐ試せます。\n自由な質問・全モデル・ツール実行はアカウント登録から（登録だけで100クレジット・カード不要）: https://teai.io",
      env,
    )
    expect(hint).toContain("/login")
    expect(hint).toContain("dashboard#api-keys")
  })

  test("per-key monthly limit explains where to raise it", () => {
    const hint = loginHint(
      "This API key reached its monthly limit (50004315 of 50000000 credits this month). Raise or remove the limit in the dashboard: https://teai.io/dashboard#api-keys",
      env,
    )
    expect(hint).toContain("月次上限")
    expect(hint).toContain("/login")
  })

  test("insufficient credits and invalid key get their own advice", () => {
    expect(loginHint("Insufficient credits", env)).toContain("pricing")
    expect(loginHint('{"error":{"code":"insufficient_quota"}}', env)).toContain("残高不足")
    expect(loginHint("Invalid API key", env)).toContain("無効")
  })

  test("unrelated errors are left alone", () => {
    expect(loginHint("ECONNRESET", env)).toBeUndefined()
    expect(loginHint("Rate limit exceeded", env)).toBeUndefined()
    expect(loginHint(undefined, env)).toBeUndefined()
    expect(formatCredits(undefined)).toBe("残高 未確認")
    expect(formatCredits(1234)).toBe("残高 1,234cr")
  })
})

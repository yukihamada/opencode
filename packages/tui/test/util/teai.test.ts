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
  loadCredentials,
  looksLikeEmail,
  looksLikeKey,
  normalizeCode,
  normalizeKey,
  parseCredentials,
  renderCredentials,
  requestEmailCode,
  saveCredentials,
  verifyEmailCode,
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

  test("login survives process exit and is restored by a fresh process", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "teai-restart-"))
    temps.push(dir)
    const module = new URL("../../src/util/teai.ts", import.meta.url).href
    const env = { ...process.env, TE_CONFIG_DIR: dir, TEAI_API_KEY: "" }
    const login = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      import { saveCredentials } from ${JSON.stringify(module)};
      await saveCredentials("te_restart_fixture");
    `,
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    )
    expect(await login.exited).toBe(0)
    for (let attempt = 0; attempt < 2; attempt++) {
      const next = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
        import { loadCredentials } from ${JSON.stringify(module)};
        await loadCredentials();
        process.exit(process.env.TEAI_API_KEY === "te_restart_fixture" ? 0 : 1);
      `,
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      )
      expect(await next.exited).toBe(0)
    }
  })

  test("restores email tokens, respects explicit env overrides and isolates config dirs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "teai-restore-"))
    temps.push(dir)
    await saveCredentials("session-token.fixture", path.join(dir, "credentials"))
    const saved = { TE_CONFIG_DIR: dir, TEAI_API_KEY: "" }
    await loadCredentials(saved)
    expect(saved.TEAI_API_KEY).toBe("session-token.fixture")
    const override = { TE_CONFIG_DIR: dir, TEAI_API_KEY: "te_explicit" }
    await loadCredentials(override)
    expect(override.TEAI_API_KEY).toBe("te_explicit")
    const missing = { TE_CONFIG_DIR: path.join(dir, "other"), TEAI_API_KEY: "" }
    await loadCredentials(missing)
    expect(missing.TEAI_API_KEY).toBe("")
    const protectedEnv = { TE_CONFIG_DIR: dir, TEAI_API_KEY: "", SENTE_SCRUB_KEY: "local-proxy-fixture" }
    await loadCredentials(protectedEnv)
    expect(protectedEnv.TEAI_API_KEY).toBe("")
  })

  test("duplicate assignments cannot restore the old key on shell relaunch", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "teai-duplicate-"))
    temps.push(dir)
    const file = path.join(dir, "credentials")
    await Bun.write(file, "# keep\nTEAI_API_KEY=te_first\nOTHER=1\nexport TEAI_API_KEY=te_old\n")
    expect(parseCredentials(await Bun.file(file).text())).toBe("te_old")
    await saveCredentials("te_new", file)
    expect(await Bun.file(file).text()).toBe("# keep\nTEAI_API_KEY=te_new\nOTHER=1\n")
    const child = Bun.spawn(["sh", "-c", '. "$1"; test "$TEAI_API_KEY" = te_new', "sh", file], {
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await child.exited).toBe(0)
  })

  test("read errors are not silently reported as a missing login", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "teai-unreadable-"))
    temps.push(dir)
    await Bun.write(path.join(dir, "not-a-directory"), "x")
    await expect(loadCredentials({ TE_CONFIG_DIR: path.join(dir, "not-a-directory") })).rejects.toThrow()
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

describe("util.teai email login", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

  test("looksLikeEmail accepts plain addresses and rejects keys/junk", () => {
    expect(looksLikeEmail("a@b.co")).toBe(true)
    expect(looksLikeEmail("te_527a7f58c9424183bbd1f50edb22256c")).toBe(false)
    expect(looksLikeEmail("not-an-email")).toBe(false)
  })

  test("normalizeCode strips everything but digits", () => {
    expect(normalizeCode(" 123 456 ")).toBe("123456")
    expect(normalizeCode("12-34-56")).toBe("123456")
  })

  test("requestEmailCode posts the email and maps errors", async () => {
    let seen: { url: string; body: string } | undefined
    const ok = await requestEmailCode("a@b.co", {
      api: "https://api.example",
      fetch: async (url, init) => {
        seen = { url, body: String(init?.body) }
        return json(200, { ok: true })
      },
    })
    expect(ok).toEqual({ ok: true })
    expect(seen?.url).toBe("https://api.example/api/v1/auth/email")
    expect(JSON.parse(seen?.body ?? "{}")).toEqual({ email: "a@b.co" })

    const rejected = await requestEmailCode("a@b.co", {
      api: "x",
      fetch: async () => json(400, { error: "Invalid email format" }),
    })
    expect(rejected).toEqual({ ok: false, reason: "invalid", detail: "Invalid email format" })
  })

  test("verifyEmailCode returns token and api_key for new accounts", async () => {
    const result = await verifyEmailCode("a@b.co", "123456", {
      api: "https://api.example",
      fetch: async () => json(200, { ok: true, token: "tok-1", api_key: "te_new", email: "a@b.co" }),
    })
    expect(result).toEqual({ ok: true, token: "tok-1", apiKey: "te_new", account: { email: "a@b.co" } })

    const existing = await verifyEmailCode("a@b.co", "123456", {
      api: "x",
      fetch: async () => json(200, { ok: true, token: "tok-2", email: "a@b.co" }),
    })
    expect(existing.ok && existing.apiKey).toBeUndefined()

    const wrong = await verifyEmailCode("a@b.co", "000000", {
      api: "x",
      fetch: async () => json(400, { error: "認証コードが正しくありません。" }),
    })
    expect(wrong).toEqual({ ok: false, reason: "invalid", detail: "認証コードが正しくありません。" })
  })
})

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { OfficialCli } from "@sente-ai/core/official-cli"

const subscriptionToolSpec = OfficialCli.officialCliSpec
const subscriptionToolCandidates = OfficialCli.officialCliCandidates
const resolveSubscriptionBinary = OfficialCli.resolveOfficialCli

describe("subscriptionToolSpec", () => {
  test("codex delegates to the official Codex CLI verbs", () => {
    const spec = subscriptionToolSpec("codex")
    expect(spec.binary).toBe("codex")
    expect(spec.loginArgs).toEqual(["login"])
    expect(spec.statusArgs).toEqual(["login", "status"])
    expect(spec.install).toContain("npm i -g @openai/codex")
  })

  test("claude delegates to the official Claude Code CLI verbs", () => {
    const spec = subscriptionToolSpec("claude")
    expect(spec.binary).toBe("claude")
    expect(spec.loginArgs).toEqual(["auth", "login"])
    expect(spec.statusArgs).toEqual(["auth", "status"])
    expect(spec.install).toContain("npm i -g @anthropic-ai/claude-code")
  })

  test("never imports or stores subscription tokens", () => {
    for (const tool of ["codex", "claude"] as const) {
      const spec = subscriptionToolSpec(tool)
      expect([spec.binary, ...spec.loginArgs, ...spec.statusArgs]).not.toContain("token")
    }
  })
})

describe("resolveSubscriptionBinary", () => {
  test("returns the first executable candidate that is not this binary", async () => {
    await using tmp = await tmpdir()
    const official = path.join(tmp.path, "codex")
    await Bun.write(official, "#!/bin/sh\nexit 0\n")
    fs.chmodSync(official, 0o755)
    expect(resolveSubscriptionBinary("codex", [official])).toBe(official)
  })

  test("skips candidates that resolve back to the sente binary", async () => {
    await using tmp = await tmpdir()
    const official = path.join(tmp.path, "codex")
    await Bun.write(official, "#!/bin/sh\nexit 0\n")
    fs.chmodSync(official, 0o755)
    const loop = path.join(tmp.path, "loop-codex")
    fs.symlinkSync(process.execPath, loop)
    expect(resolveSubscriptionBinary("codex", [loop, official])).toBe(official)
  })

  test("returns undefined when every candidate loops back or is missing", async () => {
    await using tmp = await tmpdir()
    const loop = path.join(tmp.path, "codex")
    fs.symlinkSync(process.execPath, loop)
    expect(resolveSubscriptionBinary("codex", [loop, path.join(tmp.path, "missing")])).toBeUndefined()
  })

  test("builds candidates from PATH entries", () => {
    const candidates = subscriptionToolCandidates("codex")
    expect(candidates.every((candidate) => path.basename(candidate) === "codex")).toBe(true)
    expect(new Set(candidates).size).toBe(candidates.length)
  })
})

describe("probeOfficialCli", () => {
  test("reports missing binaries without throwing", async () => {
    const probe = await OfficialCli.probeOfficialCli(path.join(os.tmpdir(), "sente-no-such-cli"))
    expect(probe.ok).toBe(false)
    if (!probe.ok) expect(probe.reason).toBe("missing")
  })

  test("reports nonzero exits as failures with detail", async () => {
    await using tmp = await tmpdir()
    const failing = path.join(tmp.path, "codex")
    await Bun.write(failing, "#!/bin/sh\necho broken >&2\nexit 3\n")
    fs.chmodSync(failing, 0o755)
    const probe = await OfficialCli.probeOfficialCli(failing)
    expect(probe.ok).toBe(false)
    if (!probe.ok) {
      expect(probe.reason).toBe("failed")
      expect(probe.detail).toContain("3")
      expect(probe.detail).toContain("broken")
    }
  })

  test("times out a hanging probe instead of waiting forever", async () => {
    await using tmp = await tmpdir()
    const hanging = path.join(tmp.path, "codex")
    await Bun.write(hanging, "#!/bin/sh\nsleep 30\n")
    fs.chmodSync(hanging, 0o755)
    const probe = await OfficialCli.probeOfficialCli(hanging, { timeoutMs: 200 })
    expect(probe.ok).toBe(false)
    if (!probe.ok) {
      expect(probe.reason).toBe("failed")
      expect(probe.detail).toContain("did not answer")
    }
  })

  test("accepts a healthy binary", async () => {
    await using tmp = await tmpdir()
    const healthy = path.join(tmp.path, "codex")
    await Bun.write(healthy, "#!/bin/sh\necho 1.0.0\nexit 0\n")
    fs.chmodSync(healthy, 0o755)
    const probe = await OfficialCli.probeOfficialCli(healthy)
    expect(probe.ok).toBe(true)
  })
})

describe("runOfficialCli", () => {
  test("propagates nonzero exit codes", async () => {
    await using tmp = await tmpdir()
    const failing = path.join(tmp.path, "codex")
    await Bun.write(failing, "#!/bin/sh\nexit 7\n")
    fs.chmodSync(failing, 0o755)
    const result = await OfficialCli.runOfficialCli(failing, [])
    expect(result).toEqual({ code: 7 })
  })

  test("surfaces spawn errors instead of swallowing them", async () => {
    const result = await OfficialCli.runOfficialCli(path.join("/tmp", "sente-no-such-cli"), [])
    expect("error" in result).toBe(true)
  })
})

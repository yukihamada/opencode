// Subprocess integration tests for `sente run` (non-interactive mode).
// These exercise the real CLI binary against a TestLLMServer running in the
// same process. See `test/lib/cli-process.ts` for the harness — each test uses
// `sente.run(message, opts?)` to spawn `bun src/index.ts run ...` with
// `SENTE_CONFIG_CONTENT` providing the test provider config inline.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { reply } from "../../lib/llm-server"
import { cliIt } from "../../lib/cli-process"
import { AUTO_REJECT_LIMIT } from "../../../src/cli/cmd/run"
import { ExitCode } from "../../../src/cli/exit-code"

describe("sente run (non-interactive subprocess)", () => {
  // Happy path: prompt completes, output reaches stdout, process exits 0.
  // If this fails, all the others likely will too — debug here first.
  cliIt.concurrent(
    "exits 0 and writes the response to stdout on a successful prompt",
    ({ llm, sente }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from the test llm")
        const result = yield* sente.run("say hi")
        sente.expectExit(result, 0)
        expect(result.stdout).toBe("hello from the test llm\n")
      }),
    60_000,
  )

  cliIt.concurrent(
    "prints each completed text part in order around a tool continuation",
    ({ llm, sente }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("  before tool  ").tool("bash", {
            command: "printf tool-output",
            description: "Print deterministic output",
          }),
        )
        yield* llm.text("  after tool  ")

        const result = yield* sente.run("use a tool", {
          extraArgs: ["--dangerously-skip-permissions"],
        })

        sente.expectExit(result, 0)
        expect(result.stdout).toBe("before tool\nafter tool\n")
      }),
    60_000,
  )

  cliIt.concurrent(
    "prints reasoning before text only with --thinking",
    ({ llm, sente }) =>
      Effect.gen(function* () {
        yield* llm.reason("  considering  ", { text: "  answer  " })
        const thinking = yield* sente.run("think", { extraArgs: ["--thinking"] })
        sente.expectExit(thinking, 0)
        expect(thinking.stdout).toBe("Thinking: considering\nanswer\n")

        yield* llm.reason("hidden", { text: "visible" })
        const plain = yield* sente.run("think again")
        sente.expectExit(plain, 0)
        expect(plain.stdout).toBe("visible\n")
      }),
    60_000,
  )

  // Regression for #27371: an unknown model used to hang the process forever
  // waiting on a session.status === idle event that never arrived. The fix
  // makes the SDK call surface an error promptly so the process exits nonzero.
  // We assert nonzero exit AND wall-clock under the harness timeout — a hang
  // would expire the timeout and produce a different (signal-killed) failure.
  // Keep competing CLI startups out of this wall-clock assertion on busy CI runners.
  cliIt.live(
    "exits nonzero promptly when the model is unknown (regression for #27371)",
    ({ sente }) =>
      Effect.gen(function* () {
        const result = yield* sente.run("say hi", {
          model: "test/nonexistent-model",
          timeoutMs: 15_000,
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(15_000)
      }),
    30_000,
  )

  // The test provider's SSE error item is interpreted by the SDK as an unknown
  // finish, not a fatal provider/session error. Unknown finishes should continue
  // the prompt loop so a subsequent response can complete the run.
  cliIt.concurrent(
    "unknown stream finish preserves partial output and continues",
    ({ llm, sente }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("partial response").tool("bash", {
            command: "printf tool",
            description: "Print deterministic output",
          }),
        )
        yield* llm.fail("upstream provider exploded mid-stream")
        yield* llm.text("recovered")
        const result = yield* sente.run("trigger midstream error", { timeoutMs: 30_000 })
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe("partial response\nrecovered\n")
        expect(result.stderr).not.toContain("upstream provider exploded mid-stream")
      }),
    60_000,
  )

  // --format json puts one JSON object per line on stdout for each emitted
  // event. Consumers (CI scripts, tooling) parse this stream. Asserts the
  // shape so a future event-emit change has to update this expectation.
  cliIt.concurrent(
    "--format json emits parseable line-delimited JSON to stdout",
    ({ llm, sente }) =>
      Effect.gen(function* () {
        yield* llm.text("structured output")
        const result = yield* sente.run("say hi", { format: "json" })
        sente.expectExit(result, 0)

        const events = sente.parseJsonEvents(result.stdout)
        expect(events.length).toBeGreaterThan(0)
        for (const evt of events) {
          expect(typeof evt.type).toBe("string")
          expect(typeof evt.sessionID).toBe("string")
        }
        expect(events.map((event) => event.type)).toEqual(["step_start", "text", "step_finish"])
        expect(events.map(({ timestamp: _, sessionID: __, ...event }) => event)).toEqual([
          { type: "step_start", part: expect.objectContaining({ type: "step-start" }) },
          {
            type: "text",
            part: expect.objectContaining({ type: "text", text: "structured output" }),
          },
          { type: "step_finish", part: expect.objectContaining({ type: "step-finish" }) },
        ])
        expect(result.stdout.endsWith("\n")).toBe(true)
        expect(
          result.stdout
            .split("\n")
            .slice(0, -1)
            .every((line) => line.length > 0),
        ).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "--format json emits a pure error record for a rejected prompt request",
    ({ sente }) =>
      Effect.gen(function* () {
        const result = yield* sente.run("use an unknown model", {
          model: "test/nonexistent-model",
          format: "json",
        })

        expect(result.exitCode).not.toBe(0)
        const events = sente.parseJsonEvents(result.stdout)
        expect(events.map((event) => event.type)).toEqual(["error"])
        expect(events[0]).toEqual({
          type: "error",
          timestamp: expect.any(Number),
          sessionID: expect.any(String),
          exitCode: expect.any(Number),
          error: expect.any(Object),
        })
        expect(result.stdout.split("\n").filter(Boolean)).toHaveLength(1)
      }),
    30_000,
  )

  cliIt.concurrent(
    "--format json preserves reasoning, tool, and continuation ordering",
    ({ llm, sente }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().reason("reasoning").text("before").tool("bash", {
            command: "printf tool",
            description: "Print deterministic output",
          }),
        )
        yield* llm.text("after")

        const result = yield* sente.run("exercise json records", {
          format: "json",
          extraArgs: ["--thinking", "--dangerously-skip-permissions"],
        })

        expect(result.exitCode).toBe(0)
        const events = sente.parseJsonEvents(result.stdout)
        expect(events.map((event) => event.type)).toEqual([
          "step_start",
          "reasoning",
          "text",
          "tool_use",
          "step_finish",
          "step_start",
          "text",
          "step_finish",
        ])
        expect(events.find((event) => event.type === "reasoning")?.part).toEqual(
          expect.objectContaining({ type: "reasoning", text: "reasoning" }),
        )
        expect(events.find((event) => event.type === "tool_use")?.part).toEqual(
          expect.objectContaining({
            type: "tool",
            tool: "bash",
            state: expect.objectContaining({ status: "completed" }),
          }),
        )
        expect(
          result.stdout
            .split("\n")
            .slice(0, -1)
            .every((line) => line.startsWith("{")),
        ).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "--format json records an unknown stream finish and continuation",
    ({ llm, sente }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("partial json").tool("bash", {
            command: "printf tool",
            description: "Print deterministic output",
          }),
        )
        yield* llm.fail("provider failed")
        yield* llm.text("recovered")
        const result = yield* sente.run("fail after output", { format: "json" })

        const events = sente.parseJsonEvents(result.stdout)
        expect(result.exitCode).toBe(0)
        expect(events.map((event) => event.type)).toEqual([
          "step_start",
          "text",
          "tool_use",
          "step_finish",
          "step_start",
          "step_finish",
          "step_start",
          "text",
          "step_finish",
        ])
        expect(events[1]?.part).toEqual(expect.objectContaining({ type: "text", text: "partial json" }))
        expect(events[5]?.part).toEqual(expect.objectContaining({ type: "step-finish", reason: "unknown" }))
        expect(events[7]?.part).toEqual(expect.objectContaining({ type: "text", text: "recovered" }))
        expect(events.at(-1)?.part).toEqual(expect.objectContaining({ type: "step-finish", reason: "stop" }))
      }),
    60_000,
  )

  cliIt.concurrent(
    "rejects requested permissions by default and allows them with the dangerous flag",
    ({ home, llm, sente }) =>
      Effect.gen(function* () {
        // Nobody can answer the prompt, so the action is refused — but the model
        // is told why and gets to finish, the same as with an explicit deny.
        yield* Effect.promise(() => Bun.write(`${home}/denied-file`, "keep"))
        yield* llm.tool("bash", { command: "rm -f denied-file", description: "Remove a test file" })
        yield* llm.text("continued after rejection")
        const denied = yield* sente.run("request permission", { permission: { bash: "ask" } })
        sente.expectExit(denied, 0)
        expect(denied.stderr).toContain("permission requested: bash")
        expect(denied.stdout).toBe("continued after rejection\n")
        expect(yield* Effect.promise(() => Bun.file(`${home}/denied-file`).exists())).toBe(true)

        yield* llm.reset
        yield* llm.tool("bash", { command: "rm -f allowed-file", description: "Remove a test file" })
        yield* llm.text("continued after approval")
        const allowed = yield* sente.run("request permission", {
          permission: { bash: "ask" },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        sente.expectExit(allowed, 0)
        expect(allowed.stderr).not.toContain("permission requested: bash")
        expect(allowed.stdout).toContain("continued after approval")

        yield* llm.reset
        yield* llm.tool("bash", { command: "touch explicitly-denied", description: "Create a denied marker" })
        yield* llm.text("continued after explicit denial")
        const explicitlyDenied = yield* sente.run("request denied permission", {
          permission: { bash: "deny" },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        sente.expectExit(explicitlyDenied, 0)
        expect(explicitlyDenied.stdout).toContain("continued after explicit denial")
        expect(yield* Effect.promise(() => Bun.file(`${home}/explicitly-denied`).exists())).toBe(false)
      }),
    60_000,
  )

  cliIt.concurrent(
    "stops with the permission exit code when the model keeps asking for refused actions",
    ({ home, llm, sente }) =>
      Effect.gen(function* () {
        for (let i = 0; i <= AUTO_REJECT_LIMIT; i++) {
          yield* llm.tool("bash", { command: `touch refused-${i}`, description: "Create a marker" })
        }
        yield* llm.text("never reached")
        const result = yield* sente.run("keep asking", { permission: { bash: "ask" } })
        sente.expectExit(result, ExitCode.PermissionDenied)
        expect(result.stdout).not.toContain("never reached")
        expect(result.stderr).toContain(`stopped after ${AUTO_REJECT_LIMIT + 1} actions`)
        expect(yield* Effect.promise(() => Bun.file(`${home}/refused-0`).exists())).toBe(false)
      }),
    60_000,
  )

  // This failure is one the request-level retry does not pick up (status and wording are both
  // outside its lists), so the turn stops at once — exactly the state automatic resume starts
  // from, without first sitting through a minute of built-in backoff.
  cliIt.concurrent(
    "resumes by itself after a transient failure stops the turn, and reports success",
    ({ llm, sente }) =>
      Effect.gen(function* () {
        yield* llm.error(418, { error: { message: "socket closed by peer" } })
        yield* llm.error(418, { error: { message: "socket closed by peer" } })
        yield* llm.text("recovered after resume")
        const result = yield* sente.run("survive an outage", { env: { SENTE_AUTO_RESUME_BASE_MS: "50" } })
        sente.expectExit(result, 0)
        expect(result.stdout).toBe("recovered after resume\n")
      }),
    60_000,
  )

  cliIt.concurrent(
    "does not resume when it is switched off, or when the failure cannot be fixed by waiting",
    ({ llm, sente }) =>
      Effect.gen(function* () {
        yield* llm.error(418, { error: { message: "socket closed by peer" } })
        yield* llm.text("must not be reached")
        const off = yield* sente.run("no resume", { env: { SENTE_AUTO_RESUME_BASE_MS: "0" } })
        expect(off.exitCode).not.toBe(0)
        expect(off.stdout).not.toContain("must not be reached")

        yield* llm.reset
        yield* llm.error(401, { error: { message: "invalid api key" } })
        yield* llm.text("must not be reached")
        const auth = yield* sente.run("bad key", { env: { SENTE_AUTO_RESUME_BASE_MS: "50" } })
        expect(auth.exitCode).not.toBe(0)
        expect(auth.stdout).not.toContain("must not be reached")
      }),
    60_000,
  )

  cliIt.concurrent(
    "gives up after five resumes and exits with the error",
    ({ llm, sente }) =>
      Effect.gen(function* () {
        for (let i = 0; i < 8; i++) yield* llm.error(418, { error: { message: "socket closed by peer" } })
        yield* llm.text("must not be reached")
        const result = yield* sente.run("outage that never ends", { env: { SENTE_AUTO_RESUME_BASE_MS: "20" } })
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout).not.toContain("must not be reached")
        // 1 original + 5 resumes, then it stops: two queued failures are left untouched.
        expect(yield* llm.pending).toBe(3)
      }),
    60_000,
  )

  cliIt.live(
    "attach mode sends client-local file contents without a shared path",
    ({ home, llm, sente }) =>
      Effect.gen(function* () {
        const source = `${home}/client-only.txt`
        const sentinel = "client-only attachment sentinel"
        yield* Effect.promise(() => Bun.write(source, sentinel))
        yield* llm.text("attachment received")
        const server = yield* sente.serve()

        const result = yield* sente.run("read the attachment", {
          extraArgs: ["--attach", server.url, `--file=${source}`, "--"],
        })

        sente.expectExit(result, 0)
        const input = JSON.stringify(yield* llm.inputs)
        expect(input).toContain(sentinel)
        expect(input).not.toContain(`file://${source}`)
      }),
    60_000,
  )

  cliIt.concurrent(
    "attach mode rejects local directories before prompt admission",
    ({ home, sente }) =>
      Effect.gen(function* () {
        const result = yield* sente.run("read the directory", {
          extraArgs: ["--attach", "http://127.0.0.1:1", `--file=${home}`, "--"],
        })

        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("Cannot attach local directory without a shared filesystem")
      }),
    30_000,
  )

  cliIt.live(
    "SIGINT interrupts an active non-interactive run without leaking the process",
    ({ llm, sente }) =>
      Effect.gen(function* () {
        yield* llm.hang
        const run = yield* sente.startRun("wait forever")
        yield* llm.wait(1)
        run.interrupt()
        const result = yield* run.result

        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(30_000)
      }),
    30_000,
  )
})

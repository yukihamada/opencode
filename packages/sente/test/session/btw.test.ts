import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@sente-ai/core/v1/session"
import { Effect, Fiber, Stream } from "effect"
import { LLMEvent } from "@sente-ai/llm"
import type { Provider } from "@/provider/provider"
import type { LLM } from "@/session/llm"
import { SessionBtw } from "../../src/session/btw"

const user = (parts: unknown[], model = { providerID: "p", modelID: "main" }) =>
  ({ info: { role: "user", model }, parts }) as unknown as SessionV1.WithParts
const assistant = (parts: unknown[], summary = false) =>
  ({ info: { role: "assistant", summary }, parts }) as unknown as SessionV1.WithParts

const model = {
  id: "small",
  providerID: "p",
  cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
} as unknown as Provider.Model

describe("SessionBtw excerpt", () => {
  test("keeps user and assistant text, tool calls and summaries, skipping synthetic parts", () => {
    const text = SessionBtw.transcript([
      assistant([{ type: "text", text: "Earlier work was about auth." }], true),
      user([
        { type: "text", text: "ログイン画面を直して" },
        { type: "text", text: "<system-reminder>", synthetic: true },
      ]),
      assistant([
        { type: "reasoning", text: "secret thoughts" },
        { type: "tool", tool: "bash", state: { status: "running", input: { command: "bun test" } } },
        { type: "tool", tool: "edit", state: { status: "error", input: { filePath: "a.ts" }, error: "no match" } },
        { type: "text", text: "テストを実行中です" },
      ]),
    ])
    expect(text).toContain("Summary of earlier conversation:\nEarlier work was about auth.")
    expect(text).toContain("User:\nログイン画面を直して")
    expect(text).toContain('[tool bash running] {"command":"bun test"}')
    expect(text).toContain("[tool edit failed: no match]")
    expect(text).toContain("テストを実行中です")
    expect(text).not.toContain("system-reminder")
    expect(text).not.toContain("secret thoughts")
  })

  test("drops the oldest messages first when the excerpt is too long", () => {
    const messages = Array.from({ length: 10 }, (_, i) => user([{ type: "text", text: `msg${i} ` + "x".repeat(90) }]))
    const text = SessionBtw.transcript(messages, 350)
    expect(text).toContain("msg9")
    expect(text).not.toContain("msg0")
  })

  test("request carries the goal, the excerpt and the question; default titles are not a goal", () => {
    const content = SessionBtw.request({
      title: "Fix the login form",
      messages: [user([{ type: "text", text: "go" }])],
      question: "進捗は?",
    })
    expect(content).toContain("<session_goal>\nFix the login form\n</session_goal>")
    expect(content).toContain("<side_question>\n進捗は?\n</side_question>")
    expect(
      SessionBtw.request({ title: "New session - 2026-11-24T00:00:00.000Z", messages: [], question: "q" }),
    ).not.toContain("<session_goal>")
  })

  test("main model is the latest user message's model", () => {
    const found = SessionBtw.mainModel([
      user([], { providerID: "a", modelID: "1" }),
      assistant([]),
      user([], { providerID: "b", modelID: "2" }),
    ])
    expect(`${found?.providerID}/${found?.modelID}`).toBe("b/2")
    expect(SessionBtw.mainModel([])).toBeUndefined()
  })

  test("the side agent is read-only", () => {
    expect(SessionBtw.AGENT.permission).toEqual([{ permission: "*", pattern: "*", action: "deny" }])
    expect(SessionBtw.AGENT.prompt).toContain("cannot call tools")
  })
})

describe("SessionBtw excerpt details", () => {
  test("includes the tail of tool output so results can be quoted", () => {
    const output = "noise\n".repeat(200) + "12 pass\n3 fail\nRan 15 tests"
    const text = SessionBtw.transcript([
      assistant([
        {
          type: "tool",
          tool: "bash",
          state: { status: "completed", input: { command: "bun test" }, output, title: "bun test", time: { start: 1, end: 2 }, metadata: {} },
        },
      ]),
    ])
    expect(text).toContain("3 fail\nRan 15 tests")
    expect(text.length).toBeLessThan(1_000)
  })

  test("keeps an old compaction summary even when newer messages fill the budget", () => {
    const messages = [
      assistant([{ type: "text", text: "SUMMARY: the goal is the login form" }], true),
      ...Array.from({ length: 30 }, (_, i) => user([{ type: "text", text: `msg${i} ` + "x".repeat(900) }])),
    ]
    const text = SessionBtw.transcript(messages, 6_000)
    expect(text).toContain("SUMMARY: the goal is the login form")
    expect(text).toContain("msg29")
    expect(text).not.toContain("msg0 ")
    expect(text.indexOf("SUMMARY")).toBeLessThan(text.indexOf("msg29"))
  })

  test("masks secrets in the whole request, including pasted text and tool input", () => {
    const key = "te_" + "A1b2C3d4".repeat(4)
    const content = SessionBtw.request({
      title: "Goal",
      messages: [
        user([{ type: "text", text: `my key is ${key}` }]),
        assistant([{ type: "tool", tool: "bash", state: { status: "running", input: { command: `curl -H ${key}` } } }]),
      ],
      question: `why does ${key} fail?`,
    })
    expect(content).not.toContain(key)
    expect(content).toContain("[REDACTED]")
  })

  test("tells the model to say when the answer is outside the visible excerpt", () => {
    expect(SessionBtw.AGENT.prompt).toContain("その内容は今見えている範囲にありません")
  })
})

describe("SessionBtw.resolveModel", () => {
  const small = { ...model, id: "small" } as Provider.Model
  const main = { ...model, id: "main" } as Provider.Model
  const provider = (opts: { small?: boolean; known: string[] }) => ({
    getSmallModel: () => Effect.succeed(opts.small ? small : undefined),
    getModel: (_providerID: string, modelID: string) =>
      opts.known.includes(modelID) ? Effect.succeed({ ...model, id: modelID } as Provider.Model) : Effect.fail(new Error("nope")),
  }) as unknown as Parameters<typeof SessionBtw.resolveModel>[0]["provider"]
  const ref = (modelID: string) => ({ providerID: "p", modelID }) as unknown as SessionBtw.ModelRef

  test("prefers the small model, then falls back to the main model and says so", async () => {
    expect(await Effect.runPromise(SessionBtw.resolveModel({ main: ref("main"), provider: provider({ small: true, known: ["main"] }) }))).toEqual({
      model: small,
      fallback: false,
    })
    const fallback = await Effect.runPromise(SessionBtw.resolveModel({ main: ref("main"), provider: provider({ known: ["main"] }) }))
    expect(fallback.model.id).toBe(main.id)
    expect(fallback.fallback).toBe(true)
  })

  test("an explicit model that does not exist is an error, not a silent fallback", async () => {
    const result = await Effect.runPromise(
      SessionBtw.resolveModel({ explicit: ref("missing"), main: ref("main"), provider: provider({ small: true, known: ["main"] })}).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    expect(result._tag === "Failure" ? result.failure.message : "").toContain("p/missing")
  })

  test("no model at all is an error", async () => {
    const result = await Effect.runPromise(SessionBtw.resolveModel({ provider: provider({ known: [] }) }).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
  })
})

describe("SessionBtw spend and budget", () => {
  test("records spend in metadata without touching other keys", () => {
    const first = SessionBtw.withSpend({ cost_limit_usd: 2 }, 0.1, 1)
    const second = SessionBtw.withSpend(first, 0.2, 2)
    expect(second.cost_limit_usd).toBe(2)
    expect(SessionBtw.spentOn(second)).toBeCloseTo(0.3)
    expect(SessionBtw.spentOn(undefined)).toBe(0)
    expect(SessionBtw.spentOn({ btw_spend: "junk" })).toBe(0)
  })

  test("asks for approval when recorded cost plus earlier /btw cost crosses the session limit", () => {
    const priced = {
      ...model,
      limit: { context: 10_000, output: 2_000 },
      cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
    } as unknown as Provider.Model
    const history = [{ info: { role: "assistant", agent: "build", cost: 0.04 } }]
    const under = SessionBtw.budget({
      session: { metadata: { cost_limit_usd: 1 } },
      root: { id: "ses_1" as never, metadata: { cost_limit_usd: 1 } },
      rootHistory: history,
      sameRoot: true,
      model: priced,
      content: "short",
    })
    expect(under.needsApproval).toBe(false)
    const over = SessionBtw.budget({
      session: { metadata: SessionBtw.withSpend({ cost_limit_usd: 1 }, 0.99, 1) },
      root: { id: "ses_1" as never, metadata: SessionBtw.withSpend({ cost_limit_usd: 1 }, 0.99, 1) },
      rootHistory: history,
      sameRoot: true,
      model: priced,
      content: "short",
    })
    expect(over.spent).toBeCloseTo(1.03)
    expect(over.needsApproval).toBe(true)
  })
})

describe("SessionBtw.ask", () => {
  const run = (stream: LLM.Interface["stream"], recorded: number[] = []) =>
    Effect.runPromise(
      SessionBtw.ask({
        session: { id: "ses_1" as never, title: "Goal" },
        messages: [user([{ type: "text", text: "hello" }])],
        question: "what?",
        model,
        stream,
        record: (usd) => Effect.sync(() => void recorded.push(usd)),
      }),
    )

  test("sends no tools on a separate session, caps the output and records the cost", async () => {
    const seen: Parameters<LLM.Interface["stream"]>[0][] = []
    const recorded: number[] = []
    const result = await run((input) => {
      seen.push(input)
      return Stream.fromIterable([
        LLMEvent.textDelta({ id: "t", text: "<think>x</think>  answer " }),
        LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 1_000_000, outputTokens: 500_000 } }),
      ])
    }, recorded)
    expect(result).toMatchObject({ text: "answer", modelID: "small", providerID: "p", cost: 2 })
    expect(result.error).toBeUndefined()
    expect(recorded).toEqual([2])
    expect(seen[0]!.tools).toEqual({})
    expect(seen[0]!.toolChoice).toBe("none")
    expect(seen[0]!.maxOutputTokens).toBe(SessionBtw.MAX_OUTPUT_TOKENS)
    expect(seen[0]!.agent.name).toBe("btw")
    expect(seen[0]!.sessionID).not.toBe("ses_1")
  })

  test("a failed stream keeps the text that already arrived and the cost already reported", async () => {
    const recorded: number[] = []
    const result = await run(
      () =>
        Stream.fromIterable([
          LLMEvent.textDelta({ id: "t", text: "partial " }),
          LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 1_000_000, outputTokens: 0 } }),
        ]).pipe(Stream.concat(Stream.fail(new Error("Insufficient credits")))),
      recorded,
    )
    expect(result).toMatchObject({ text: "partial", cost: 1, error: "Insufficient credits" })
    expect(recorded).toEqual([1])
  })

  test("a provider error event is reported", async () => {
    const result = await run(() => Stream.fromIterable([LLMEvent.providerError({ message: "rate limited" })]))
    expect(result).toMatchObject({ text: "", error: "rate limited" })
  })

  test("interrupting (panel closed) stops the stream and still records an estimate of what was spent", async () => {
    const recorded: number[] = []
    let finalized = false
    let started!: () => void
    const ready = new Promise<void>((resolve) => (started = resolve))
    const fiber = Effect.runFork(
      SessionBtw.ask({
        session: { id: "ses_1" as never, title: "Goal" },
        messages: [user([{ type: "text", text: "hello ".repeat(1000) }])],
        question: "what?",
        model,
        stream: () =>
          Stream.fromIterable([LLMEvent.textDelta({ id: "t", text: "partial answer" })]).pipe(
            Stream.concat(Stream.fromEffect(Effect.sync(() => started())).pipe(Stream.drain)),
            Stream.concat(Stream.never),
            Stream.ensuring(Effect.sync(() => (finalized = true))),
          ),
        record: (usd) => Effect.sync(() => void recorded.push(usd)),
      }),
    )
    await ready
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(finalized).toBe(true)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toBeGreaterThan(0)
  })
})

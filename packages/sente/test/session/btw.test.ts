import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@sente-ai/core/v1/session"
import { Effect, Stream } from "effect"
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
    expect(
      SessionBtw.mainModel([user([], { providerID: "a", modelID: "1" }), assistant([]), user([], { providerID: "b", modelID: "2" })]),
    ).toEqual({ providerID: "b", modelID: "2" })
    expect(SessionBtw.mainModel([])).toBeUndefined()
  })

  test("the side agent is read-only", () => {
    expect(SessionBtw.AGENT.permission).toEqual([{ permission: "*", pattern: "*", action: "deny" }])
    expect(SessionBtw.AGENT.prompt).toContain("cannot call tools")
  })
})

describe("SessionBtw.ask", () => {
  const run = (stream: LLM.Interface["stream"]) =>
    Effect.runPromise(
      SessionBtw.ask({
        session: { id: "ses_1" as never, title: "Goal" },
        messages: [user([{ type: "text", text: "hello" }])],
        question: "what?",
        model,
        stream,
      }),
    )

  test("sends no tools on a separate session and sums usage into cost", async () => {
    const seen: Parameters<LLM.Interface["stream"]>[0][] = []
    const result = await run((input) => {
      seen.push(input)
      return Stream.fromIterable([
        LLMEvent.textDelta({ id: "t", text: "<think>x</think>  answer " }),
        LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 1_000_000, outputTokens: 500_000 } }),
      ])
    })
    expect(result).toMatchObject({ text: "answer", modelID: "small", providerID: "p", cost: 2 })
    expect(result.error).toBeUndefined()
    expect(seen[0]!.tools).toEqual({})
    expect(seen[0]!.toolChoice).toBe("none")
    expect(seen[0]!.agent.name).toBe("btw")
    expect(seen[0]!.sessionID).not.toBe("ses_1")
  })

  test("a failed stream becomes an error with no answer", async () => {
    const result = await run(() => Stream.fail(new Error("Insufficient credits")))
    expect(result).toMatchObject({ text: "", cost: 0, error: "Insufficient credits" })
  })

  test("a provider error event is reported", async () => {
    const result = await run(() => Stream.fromIterable([LLMEvent.providerError({ message: "rate limited" })]))
    expect(result).toMatchObject({ text: "", error: "rate limited" })
  })
})

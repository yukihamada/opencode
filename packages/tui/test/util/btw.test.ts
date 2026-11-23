import { describe, expect, test } from "bun:test"
import { askBtw, btwText, parseBtwCommand, recordSpend, spendSince } from "../../src/util/btw"

describe("parseBtwCommand", () => {
  test("reads the question after /btw or /side, keeping newlines", () => {
    expect(parseBtwCommand("/btw 今なにしてる?")).toEqual({ type: "ask", question: "今なにしてる?" })
    expect(parseBtwCommand("  /side what is left?  ")).toEqual({ type: "ask", question: "what is left?" })
    expect(parseBtwCommand("/btw line one\nline two")).toEqual({ type: "ask", question: "line one\nline two" })
  })

  test("no question is the usage case; other commands are not /btw", () => {
    expect(parseBtwCommand("/btw")).toEqual({ type: "empty" })
    expect(parseBtwCommand("/btw    ")).toEqual({ type: "empty" })
    expect(parseBtwCommand("/btwx hi")).toBeUndefined()
    expect(parseBtwCommand("btw hi")).toBeUndefined()
    expect(parseBtwCommand("/help")).toBeUndefined()
  })
})

describe("side spend", () => {
  test("records positive costs, prunes entries older than two days and ignores junk", () => {
    const now = 10 * 24 * 60 * 60 * 1000
    const old = { session: "a", usd: 1, time: now - 3 * 24 * 60 * 60 * 1000 }
    const list = recordSpend([old, { bad: true }, { session: "a", usd: -1, time: now }], { session: "a", usd: 0.002, time: now })
    expect(list).toEqual([{ session: "a", usd: 0.002, time: now }])
    expect(recordSpend(list, { session: "a", usd: 0, time: now })).toEqual(list)
    expect(recordSpend(undefined, { session: "b", usd: 0.5, time: now })).toEqual([{ session: "b", usd: 0.5, time: now }])
  })

  test("sums since a time, optionally for one session", () => {
    const list = [
      { session: "a", usd: 0.1, time: 100 },
      { session: "b", usd: 0.2, time: 200 },
      { session: "a", usd: 0.3, time: 300 },
    ]
    expect(spendSince(list, { since: 150 })).toBeCloseTo(0.5)
    expect(spendSince(list, { since: 0, session: "a" })).toBeCloseTo(0.4)
    expect(spendSince("garbage", { since: 0 })).toBe(0)
  })
})

describe("askBtw", () => {
  type Reply = Awaited<ReturnType<Parameters<typeof askBtw>[0]["session"]["btw"]>>
  const client = (reply: () => Promise<Reply>) => {
    const calls: unknown[] = []
    return {
      calls,
      session: {
        btw: (input: { sessionID: string; question: string }) => {
          calls.push(input)
          return reply()
        },
      },
    }
  }

  test("returns the trimmed answer with model and cost", async () => {
    const fake = client(async () => ({
      data: { text: "  done  ", providerID: "sente", modelID: "gpt-nano", cost: 0.0004 },
    }))
    expect(await askBtw(fake, { sessionID: "ses_1", question: "q" })).toEqual({
      type: "answer",
      text: "done",
      usd: 0.0004,
      model: "sente/gpt-nano",
    })
    expect(fake.calls).toEqual([{ sessionID: "ses_1", question: "q" }])
  })

  test("an empty answer is reported as empty (still charged)", async () => {
    const fake = client(async () => ({ data: { text: " ", providerID: "p", modelID: "m", cost: 0.001 } }))
    expect(await askBtw(fake, { sessionID: "s", question: "q" })).toEqual({ type: "empty", usd: 0.001, model: "p/m" })
  })

  test("provider, HTTP and transport failures become errors and never throw", async () => {
    expect(
      await askBtw(client(async () => ({ data: { text: "", providerID: "p", modelID: "m", cost: 0, error: "Insufficient credits" } })), {
        sessionID: "s",
        question: "q",
      }),
    ).toEqual({ type: "error", message: "Insufficient credits" })
    expect(
      await askBtw(client(async () => ({ error: { data: { message: "Session not found" } } })), { sessionID: "s", question: "q" }),
    ).toEqual({ type: "error", message: "Session not found" })
    expect(
      await askBtw(client(() => Promise.reject(new Error("socket closed"))), { sessionID: "s", question: "q" }),
    ).toEqual({ type: "error", message: "socket closed" })
  })

  test("texts exist in Japanese and English", () => {
    expect(btwText("ja").title).toContain("/btw")
    expect(btwText("en").usage).toContain("/btw <question>")
  })
})

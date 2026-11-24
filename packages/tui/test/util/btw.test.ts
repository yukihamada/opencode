import { describe, expect, test } from "bun:test"
import { askBtw, btwText, parseBtwCommand, questionPreview } from "../../src/util/btw"

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

describe("questionPreview", () => {
  test("collapses whitespace and cuts to the width with an ellipsis", () => {
    expect(questionPreview("short\n  question", 40)).toBe("short question")
    const cut = questionPreview("あ".repeat(50), 21)
    expect(cut.endsWith("…")).toBe(true)
    expect(Bun.stringWidth(cut)).toBeLessThanOrEqual(21)
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
    expect(
      await askBtw(fake, { sessionID: "ses_1", question: "q", main: { providerID: "sente", modelID: "main" } }),
    ).toEqual({
      type: "answer",
      text: "done",
      usd: 0.0004,
      model: "sente/gpt-nano",
      fallback: false,
    })
    expect(fake.calls).toEqual([{ sessionID: "ses_1", question: "q", main: { providerID: "sente", modelID: "main" } }])
  })

  test("an empty answer is reported as empty (still charged)", async () => {
    const fake = client(async () => ({ data: { text: " ", providerID: "p", modelID: "m", cost: 0.001 } }))
    expect(await askBtw(fake, { sessionID: "s", question: "q" })).toEqual({ type: "empty", usd: 0.001, model: "p/m", fallback: false })
  })

  test("provider, HTTP and transport failures become errors and never throw", async () => {
    expect(
      await askBtw(client(async () => ({ data: { text: "", providerID: "p", modelID: "m", cost: 0, error: "Insufficient credits" } })), {
        sessionID: "s",
        question: "q",
      }),
    ).toEqual({ type: "error", message: "Insufficient credits", text: "", usd: 0, model: "p/m", fallback: false })
    expect(
      await askBtw(client(async () => ({ error: { data: { message: "Session not found" } } })), { sessionID: "s", question: "q" }),
    ).toMatchObject({ type: "error", message: "Session not found" })
    expect(
      await askBtw(client(() => Promise.reject(new Error("socket closed"))), { sessionID: "s", question: "q" }),
    ).toMatchObject({ type: "error", message: "socket closed" })
  })

  test("keeps a partial answer and its cost on error, and passes approval through", async () => {
    expect(
      await askBtw(client(async () => ({ data: { text: " half ", providerID: "p", modelID: "m", cost: 0.002, error: "reset", fallback: true } })), {
        sessionID: "s",
        question: "q",
      }),
    ).toEqual({ type: "error", message: "reset", text: "half", usd: 0.002, model: "p/m", fallback: true })
    const asked = client(async () => ({ data: { text: "", providerID: "p", modelID: "m", cost: 0, approval: { spent: 1, limit: 1 } } }))
    expect(await askBtw(asked, { sessionID: "s", question: "q", approve: true })).toEqual({
      type: "approval",
      spent: 1,
      limit: 1,
      model: "p/m",
      fallback: false,
    })
    expect(asked.calls).toEqual([{ sessionID: "s", question: "q", approve: true }])
  })

  test("texts exist in Japanese and English", () => {
    expect(btwText("ja").title).toContain("/btw")
    expect(btwText("en").usage).toContain("/btw <question>")
  })
})

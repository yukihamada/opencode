import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@sente-ai/core/v1/session"
import { SessionDegrade } from "../../src/session/degrade"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const sessionID = SessionID.make("ses_degrade")

function user(id: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.make(id),
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "build",
      model: { providerID: "teai", modelID: "glm" },
    } as unknown as SessionV1.User,
    parts: [],
  }
}

function assistant(
  id: string,
  parentID: string,
  parts: SessionV1.Part[],
  extra: Partial<SessionV1.Assistant> = {},
): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.make(id),
      sessionID,
      role: "assistant",
      parentID: MessageID.make(parentID),
      time: { created: 0 },
      modelID: "glm",
      providerID: "teai",
      mode: "build",
      agent: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...extra,
    } as unknown as SessionV1.Assistant,
    parts,
  }
}

let seq = 0
function text(messageID: string, value: string, synthetic?: boolean): SessionV1.Part {
  return {
    id: PartID.make(`prt_${++seq}`),
    sessionID,
    messageID: MessageID.make(messageID),
    type: "text",
    text: value,
    synthetic,
  } as SessionV1.Part
}

function tool(messageID: string, name: string, input: Record<string, unknown>, status: "completed" | "error" | "pending" = "completed"): SessionV1.Part {
  const state =
    status === "pending"
      ? { status, input: JSON.stringify(input) }
      : status === "error"
        ? { status, input, error: "boom", metadata: {}, time: { start: 0, end: 0 } }
        : { status, input, output: "ok", title: name, metadata: {}, time: { start: 0, end: 0 } }
  return {
    id: PartID.make(`prt_${++seq}`),
    sessionID,
    messageID: MessageID.make(messageID),
    type: "tool",
    callID: `call_${seq}`,
    tool: name,
    state,
  } as unknown as SessionV1.Part
}

const turn = MessageID.make("msg_u1")

describe("SessionDegrade.detect", () => {
  test("clean turn is not flagged", () => {
    const msgs = [user("msg_u1"), assistant("msg_a1", "msg_u1", [text("msg_a1", "Done. The tests pass.")])]
    expect(SessionDegrade.detect(msgs, turn)).toBeUndefined()
  })

  test("garbage control tokens in the last reply", () => {
    const msgs = [user("msg_u1"), assistant("msg_a1", "msg_u1", [text("msg_a1", "Sure<ctrl46><ctrl46> here")])]
    expect(SessionDegrade.detect(msgs, turn)?.reason).toBe("garbage")
    const im = [user("msg_u1"), assistant("msg_a1", "msg_u1", [text("msg_a1", "ok<|im_end|><|im_start|>assistant")])]
    expect(SessionDegrade.detect(im, turn)?.reason).toBe("garbage")
  })

  test("garbage in an earlier, already superseded step is ignored", () => {
    const msgs = [
      user("msg_u1"),
      assistant("msg_a1", "msg_u1", [text("msg_a1", "<ctrl46>")]),
      assistant("msg_a2", "msg_u1", [text("msg_a2", "Recovered and finished the task.")]),
    ]
    expect(SessionDegrade.detect(msgs, turn)).toBeUndefined()
  })

  test("model repeating the same long reply twice", () => {
    const line = "I will now read the file and then apply the change you asked for."
    const msgs = [
      user("msg_u1"),
      assistant("msg_a1", "msg_u1", [text("msg_a1", line)]),
      assistant("msg_a2", "msg_u1", [text("msg_a2", `  ${line}\n`)]),
    ]
    expect(SessionDegrade.detect(msgs, turn)?.reason).toBe("repeat")
  })

  test("short identical replies are not a loop", () => {
    const msgs = [
      user("msg_u1"),
      assistant("msg_a1", "msg_u1", [text("msg_a1", "OK")]),
      assistant("msg_a2", "msg_u1", [text("msg_a2", "OK")]),
    ]
    expect(SessionDegrade.detect(msgs, turn)).toBeUndefined()
  })

  test("same tool call three times in a row", () => {
    const msgs = [
      user("msg_u1"),
      assistant("msg_a1", "msg_u1", [tool("msg_a1", "read", { filePath: "a.ts" })]),
      assistant("msg_a2", "msg_u1", [tool("msg_a2", "read", { filePath: "a.ts" }, "error")]),
      assistant("msg_a3", "msg_u1", [tool("msg_a3", "read", { filePath: "a.ts" })]),
    ]
    expect(SessionDegrade.detect(msgs, turn)?.reason).toBe("tool_loop")
  })

  test("different tool inputs are progress, not a loop", () => {
    const msgs = [
      user("msg_u1"),
      assistant("msg_a1", "msg_u1", [tool("msg_a1", "read", { filePath: "a.ts" })]),
      assistant("msg_a2", "msg_u1", [tool("msg_a2", "read", { filePath: "b.ts" })]),
      assistant("msg_a3", "msg_u1", [tool("msg_a3", "read", { filePath: "a.ts" })]),
    ]
    expect(SessionDegrade.detect(msgs, turn)).toBeUndefined()
  })

  test("pending tool calls never count", () => {
    const msgs = [
      user("msg_u1"),
      assistant("msg_a1", "msg_u1", [
        tool("msg_a1", "read", { filePath: "a.ts" }, "pending"),
        tool("msg_a1", "read", { filePath: "a.ts" }, "pending"),
        tool("msg_a1", "read", { filePath: "a.ts" }, "pending"),
      ]),
    ]
    expect(SessionDegrade.detect(msgs, turn)).toBeUndefined()
  })

  test("only the current turn is inspected; summaries are skipped", () => {
    const msgs = [
      user("msg_u0"),
      assistant("msg_a0", "msg_u0", [text("msg_a0", "<ctrl46>")]),
      user("msg_u1"),
      assistant("msg_s1", "msg_u1", [text("msg_s1", "<ctrl46> summary")], { summary: true }),
    ]
    expect(SessionDegrade.detect(msgs, turn)).toBeUndefined()
  })
})

describe("SessionDegrade.Budget", () => {
  test("compact, then restart, then ignore within the window", () => {
    let now = 1_000
    const budget = new SessionDegrade.Budget(() => now)
    expect(budget.record(sessionID)).toBe("compact")
    now += 1_000
    expect(budget.record(sessionID)).toBe("restart")
    now += 1_000
    expect(budget.record(sessionID)).toBe("ignore")
  })

  test("budget refills after the window and is per session", () => {
    let now = 1_000
    const budget = new SessionDegrade.Budget(() => now)
    budget.record(sessionID)
    budget.record(sessionID)
    expect(budget.record(SessionID.make("ses_other"))).toBe("compact")
    now += SessionDegrade.RESCUE_WINDOW_MS + 1
    expect(budget.record(sessionID)).toBe("compact")
  })

  test("ref and describe are stable strings the client can match on", () => {
    expect(SessionDegrade.ref("compact", "repeat")).toBe("sente.degraded:compact:repeat")
    expect(SessionDegrade.describe({ reason: "garbage", detail: "" }, "restart")).toContain("restarting Sente")
  })
})

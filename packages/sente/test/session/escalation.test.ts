import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@sente-ai/core/v1/session"
import { ModelV2 } from "@sente-ai/core/model"
import { ProviderV2 } from "@sente-ai/core/provider"
import type { Provider } from "../../src/provider/provider"
import { SessionEscalation } from "../../src/session/escalation"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const sessionID = SessionID.make("ses_test")

describe("execution finishing allowance", () => {
  test("reserves twenty calls and the last report without raising either ceiling", () => {
    expect(SessionEscalation.MAX_REQUEST_ATTEMPTS).toBe(100)
    expect(SessionEscalation.MAX_TURNS).toBe(100)
    expect(SessionEscalation.executionPhase(79, 79)).toBe("work")
    expect(SessionEscalation.executionPhase(80)).toBe("finish")
    expect(SessionEscalation.executionPhase(0, 80)).toBe("finish")
    expect(SessionEscalation.executionPhase(98, 98)).toBe("finish")
    expect(SessionEscalation.executionPhase(99)).toBe("report")
    expect(SessionEscalation.executionPhase(0, 99)).toBe("report")
  })

  test("both locales distinguish evidence from unverified work and require explicit resume", () => {
    for (const phase of ["finish", "report"] as const) {
      expect(SessionEscalation.finishingNote(phase, "ja")).toContain("未検証")
      expect(SessionEscalation.finishingNote(phase, "en")).toContain("unverified")
      expect(SessionEscalation.finishingNote(phase, "en")).toContain("approvals remain unchanged")
    }
    expect(SessionEscalation.limitNote("attempts", "ja")).toContain("残件から再開")
    expect(SessionEscalation.limitNote("attempts", "en")).toContain("Completion is unverified")
  })

  test("handoff stores bounded references, never tool inputs or outputs or a completion claim", () => {
    const messages = Array.from({ length: 12 }, (_, index) => {
      const id = MessageID.make(`msg_${index}`)
      return assistant(id, [toolPart({ messageID: id, state: completed({ secret: "sensitive-input" }, "sensitive-output") })])
    })
    const handoff = SessionEscalation.handoffReferences(messages)
    expect(handoff.tools).toHaveLength(8)
    expect(handoff.latestMessageID).toBe(MessageID.make("msg_11"))
    expect(handoff.completion).toBe("unverified")
    expect(handoff.resume).toBe("explicit_user_request")
    expect(JSON.stringify(handoff)).not.toContain("sensitive")
  })
})

function toolPart(input: {
  messageID: MessageID
  tool?: string
  state: SessionV1.ToolState
}): SessionV1.ToolPart {
  return {
    id: PartID.ascending(),
    messageID: input.messageID,
    sessionID,
    type: "tool",
    callID: "call_1",
    tool: input.tool ?? "bash",
    state: input.state,
  }
}

function textPart(messageID: MessageID, text: string): SessionV1.TextPart {
  return { id: PartID.ascending(), messageID, sessionID, type: "text", text }
}

function completed(
  args: Record<string, unknown>,
  output = "ok",
  metadata: Record<string, unknown> = {},
): SessionV1.ToolState {
  return {
    status: "completed",
    input: args,
    output,
    title: "t",
    metadata,
    time: { start: 1, end: 2 },
  }
}

function errored(args: Record<string, unknown>, error = "boom", metadata?: Record<string, unknown>): SessionV1.ToolState {
  return {
    status: "error",
    input: args,
    error,
    ...(metadata ? { metadata } : {}),
    time: { start: 1, end: 2 },
  }
}

function user(id: string, text = "do it"): SessionV1.WithParts {
  const messageID = MessageID.make(id)
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      agent: "build",
      model: { providerID: "teai" as never, modelID: "auto" as never },
      time: { created: 1 },
    },
    parts: [textPart(messageID, text)],
  }
}

function assistant(
  id: string,
  parts: SessionV1.Part[],
  model: { providerID: string; modelID: string } = { providerID: "teai", modelID: "auto" },
): SessionV1.WithParts {
  const messageID = MessageID.make(id)
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      parentID: MessageID.make("msg_parent"),
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: model.modelID as never,
      providerID: model.providerID as never,
      time: { created: 2 },
    },
    parts,
  }
}

function stepFinish(messageID: MessageID, actualModel?: string): SessionV1.StepFinishPart {
  return {
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(actualModel ? { metadata: { actualModel } } : {}),
  }
}

describe("workflowLoop", () => {
  const error = "Sente: five identical results without progress. Change the hypothesis or target."
  const blocked = (index: number, args = { pattern: "needle", path: "/source" }) => {
    const id = MessageID.make(`msg_${index}`)
    return assistant(id, [toolPart({ messageID: id, tool: "grep", state: errored(args, error) })])
  }

  test("stops three identical rejections across provider turns, ignoring argument key order", () => {
    expect(SessionEscalation.workflowLoop([blocked(1), blocked(2)])).toBe(false)
    expect(SessionEscalation.workflowLoop([blocked(1), blocked(2), blocked(3, { path: "/source", pattern: "needle" })])).toBe(true)
  })

  test("a different target, successful tool, ordinary failure or new user request breaks the streak", () => {
    const id = MessageID.make("msg_middle")
    for (const middle of [
      blocked(3, { pattern: "other", path: "/source" }),
      assistant(id, [toolPart({ messageID: id, state: completed({ command: "true" }) })]),
      assistant(id, [toolPart({ messageID: id, tool: "grep", state: errored({ pattern: "needle", path: "/source" }) })]),
      user("msg_new"),
    ]) expect(SessionEscalation.workflowLoop([blocked(1), blocked(2), middle, blocked(4)])).toBe(false)
  })

  test("synthetic continuation and summary do not reset the streak", () => {
    const continuation = user("msg_continuation")
    continuation.parts = continuation.parts.map((part) => ({ ...part, synthetic: true }))
    const summary = assistant("msg_summary", [])
    if (summary.info.role === "assistant") summary.info.summary = true
    expect(SessionEscalation.workflowLoop([blocked(1), blocked(2), continuation, summary, blocked(3)])).toBe(true)
  })

  test("stop note reports incomplete work in both supported languages", () => {
    expect(SessionEscalation.workflowLoopNote("en")).toContain("incomplete")
    expect(SessionEscalation.workflowLoopNote("ja")).toContain("未完了")
  })
})

describe("evaluate", () => {
  test("shell timeout is a failure even without an exit code", () => {
    const outcome = SessionEscalation.evaluate(toolPart({
      messageID: MessageID.make("msg_a"),
      state: completed({ command: "sleep 60" }, "timeout", { exit: null, timedOut: true }),
    }))
    expect(outcome?.kind).toBe("failure")
    if (outcome?.kind === "failure") expect(outcome.failure).toBe("timeout")
  })

  test("completed shell and code-mode cancellations are excluded", () => {
    for (const tool of ["bash", "execute"]) {
      expect(SessionEscalation.evaluate(toolPart({
        messageID: MessageID.make("msg_a"),
        tool,
        state: completed({}, "cancelled", { exit: null, interrupted: true }),
      }))).toEqual({ kind: "excluded", failure: "aborted" })
    }
  })

  test("timeout words in successful output do not imply a failure", () => {
    expect(SessionEscalation.evaluate(toolPart({
      messageID: MessageID.make("msg_a"),
      state: completed({ command: "read logs" }, "User aborted the command; timeout", { exit: 0 }),
    }))?.kind).toBe("success")
  })

  test("bash exit nonzero is a failure", () => {
    const part = toolPart({
      messageID: MessageID.make("msg_a"),
      state: completed({ command: "false" }, "out", { exit: 1 }),
    })
    const outcome = SessionEscalation.evaluate(part)
    expect(outcome?.kind).toBe("failure")
    if (outcome?.kind === "failure") expect(outcome.failure).toBe("exit")
  })

  test("fingerprint changes when output changes", () => {
    const make = (output: string) =>
      toolPart({
        messageID: MessageID.make("msg_a"),
        state: completed({ command: "grep foo ." }, output, { exit: 0 }),
      })
    const a = SessionEscalation.evaluate(make("match-a"))
    const b = SessionEscalation.evaluate(make("match-b"))
    if (a?.kind === "success" && b?.kind === "success") expect(a.signature).not.toBe(b.signature)
  })

  test("fingerprint is stable for identical input and output", () => {
    const make = () =>
      toolPart({
        messageID: MessageID.make("msg_a"),
        state: completed({ command: "grep foo ." }, "same", { exit: 0 }),
      })
    const a = SessionEscalation.evaluate(make())
    const b = SessionEscalation.evaluate(make())
    if (a?.kind === "success" && b?.kind === "success") expect(a.signature).toBe(b.signature)
  })

  test("tool error fingerprint includes the error text", () => {
    const make = (error: string) =>
      toolPart({
        messageID: MessageID.make("msg_a"),
        tool: "edit",
        state: errored({ filePath: "a.ts" }, error),
      })
    const a = SessionEscalation.evaluate(make("edit conflict"))
    const b = SessionEscalation.evaluate(make("different error"))
    if (a?.kind === "failure" && b?.kind === "failure") expect(a.signature).not.toBe(b.signature)
  })

  test("permission denials are excluded", () => {
    for (const error of [
      "PermissionRejectedError: The user rejected permission to use this specific tool call.",
      "PermissionDeniedError: rule prevents this",
      "PermissionCorrectedError: no",
    ]) {
      const part = toolPart({
        messageID: MessageID.make("msg_a"),
        state: errored({}, error),
      })
      expect(SessionEscalation.evaluate(part)).toEqual({ kind: "excluded", failure: "denied" })
    }
  })

  test("interrupted aborts are excluded", () => {
    const part = toolPart({
      messageID: MessageID.make("msg_a"),
      state: errored({}, "Tool execution aborted", { interrupted: true }),
    })
    expect(SessionEscalation.evaluate(part)).toEqual({ kind: "excluded", failure: "aborted" })
  })

  test("pending and running parts are ignored", () => {
    const part = toolPart({
      messageID: MessageID.make("msg_a"),
      state: { status: "running", input: {}, time: { start: 1 } },
    })
    expect(SessionEscalation.evaluate(part)).toBeUndefined()
  })
})

describe("detect", () => {
  test("repeated timeouts trigger recovery but cancellation resets the streak", () => {
    const timeout = (id: string) => assistant(id, [toolPart({
      messageID: MessageID.make(id),
      state: completed({ command: "sleep 60" }, "timeout", { exit: null, timedOut: true }),
    })])
    const history = [user("msg_u1"), timeout("msg_a1"), timeout("msg_a2")]
    expect(SessionEscalation.detect(SessionEscalation.collect(history))?.reason).toBe("failed_turns")
    history.push(assistant("msg_a3", [toolPart({
      messageID: MessageID.make("msg_a3"),
      state: completed({}, "cancelled", { interrupted: true }),
    })]), timeout("msg_a4"))
    expect(SessionEscalation.detect(SessionEscalation.collect(history))).toBeUndefined()
  })

  test("triggers after two consecutive turns with failures", () => {
    const turns = SessionEscalation.collect([
      user("msg_u1"),
      assistant("msg_a1", [toolPart({ messageID: MessageID.make("msg_a1"), state: errored({ command: "x" }) })]),
      assistant("msg_a2", [
        toolPart({
          messageID: MessageID.make("msg_a2"),
          state: completed({ command: "false" }, "out", { exit: 2 }),
        }),
      ]),
    ])
    expect(SessionEscalation.detect(turns)).toEqual({
      reason: "failed_turns",
      model: { providerID: "teai", modelID: "auto" },
    })
  })

  test("two failures in a single turn do not trigger", () => {
    const turns = SessionEscalation.collect([
      user("msg_u1"),
      assistant("msg_a1", [
        toolPart({ messageID: MessageID.make("msg_a1"), state: errored({ command: "x" }) }),
        toolPart({ messageID: MessageID.make("msg_a1"), state: errored({ command: "y" }) }),
      ]),
    ])
    expect(SessionEscalation.detect(turns)).toBeUndefined()
  })

  test("narration text does not count as progress and does not reset the streak", () => {
    const turns = SessionEscalation.collect([
      user("msg_u1"),
      assistant("msg_a1", [
        textPart(MessageID.make("msg_a1"), "let me test this"),
        toolPart({ messageID: MessageID.make("msg_a1"), state: errored({ command: "x" }) }),
      ]),
      assistant("msg_a2", [
        textPart(MessageID.make("msg_a2"), "trying again"),
        toolPart({ messageID: MessageID.make("msg_a2"), state: errored({ command: "y" }) }),
      ]),
    ])
    expect(SessionEscalation.detect(turns)?.reason).toBe("failed_turns")
  })

  test("a successful turn between failures resets the streak", () => {
    const turns = SessionEscalation.collect([
      user("msg_u1"),
      assistant("msg_a1", [toolPart({ messageID: MessageID.make("msg_a1"), state: errored({ command: "x" }) })]),
      assistant("msg_a2", [toolPart({ messageID: MessageID.make("msg_a2"), state: completed({ command: "y" }) })]),
      assistant("msg_a3", [toolPart({ messageID: MessageID.make("msg_a3"), state: errored({ command: "z" }) })]),
    ])
    expect(SessionEscalation.detect(turns)).toBeUndefined()
  })

  test("a success inside the same turn clears the failure evidence", () => {
    const turns = SessionEscalation.collect([
      user("msg_u1"),
      assistant("msg_a1", [toolPart({ messageID: MessageID.make("msg_a1"), state: errored({ command: "x" }) })]),
      assistant("msg_a2", [
        toolPart({ messageID: MessageID.make("msg_a2"), state: errored({ command: "y" }) }),
        toolPart({ messageID: MessageID.make("msg_a2"), state: completed({ command: "z" }) }),
      ]),
      assistant("msg_a3", [toolPart({ messageID: MessageID.make("msg_a3"), state: errored({ command: "w" }) })]),
    ])
    expect(SessionEscalation.detect(turns)).toBeUndefined()
  })

  test("triggers on three identical successful read-only attempts across messages", () => {
    const polling = (id: string) =>
      assistant(id, [
        toolPart({
          messageID: MessageID.make(id),
          tool: "grep",
          state: completed({ pattern: "foo" }, "no matches", { exit: 1 }),
        }),
      ])
    const turns = SessionEscalation.collect([user("msg_u1"), polling("msg_a1"), polling("msg_a2"), polling("msg_a3")])
    expect(SessionEscalation.detect(turns)?.reason).toBe("identical_turns")
  })

  test("identical input with changing output does not trigger", () => {
    const attempt = (id: string, output: string) =>
      assistant(id, [
        toolPart({
          messageID: MessageID.make(id),
          tool: "grep",
          state: completed({ pattern: "foo" }, output),
        }),
      ])
    const turns = SessionEscalation.collect([
      user("msg_u1"),
      attempt("msg_a1", "a"),
      attempt("msg_a2", "b"),
      attempt("msg_a3", "c"),
    ])
    expect(SessionEscalation.detect(turns)).toBeUndefined()
  })

  test("permission denials clear evidence and never trigger", () => {
    const turns = SessionEscalation.collect([
      user("msg_u1"),
      assistant("msg_a1", [toolPart({ messageID: MessageID.make("msg_a1"), state: errored({ command: "x" }) })]),
      assistant("msg_a2", [
        toolPart({
          messageID: MessageID.make("msg_a2"),
          state: errored({ command: "rm x" }, "PermissionRejectedError: The user rejected permission"),
        }),
      ]),
      assistant("msg_a3", [toolPart({ messageID: MessageID.make("msg_a3"), state: errored({ command: "y" }) })]),
    ])
    expect(SessionEscalation.detect(turns)).toBeUndefined()
  })

  test("aborts clear evidence and never trigger", () => {
    const turns = SessionEscalation.collect([
      user("msg_u1"),
      assistant("msg_a1", [toolPart({ messageID: MessageID.make("msg_a1"), state: errored({ command: "x" }) })]),
      assistant("msg_a2", [
        toolPart({
          messageID: MessageID.make("msg_a2"),
          state: errored({ command: "rm x" }, "Tool execution aborted", { interrupted: true }),
        }),
      ]),
      assistant("msg_a3", [toolPart({ messageID: MessageID.make("msg_a3"), state: errored({ command: "y" }) })]),
    ])
    expect(SessionEscalation.detect(turns)).toBeUndefined()
  })

  test("a new user message resets the window", () => {
    const turns = SessionEscalation.collect([
      user("msg_u1"),
      assistant("msg_a1", [toolPart({ messageID: MessageID.make("msg_a1"), state: errored({ command: "x" }) })]),
      user("msg_u2", "again"),
      assistant("msg_a2", [toolPart({ messageID: MessageID.make("msg_a2"), state: errored({ command: "y" }) })]),
    ])
    expect(SessionEscalation.detect(turns)).toBeUndefined()
  })

  test("collect keeps one turn per assistant message", () => {
    const turns = SessionEscalation.collect([
      user("msg_u1"),
      assistant("msg_a1", [toolPart({ messageID: MessageID.make("msg_a1"), state: errored({ command: "x" }) })]),
      assistant("msg_a2", [toolPart({ messageID: MessageID.make("msg_a2"), state: errored({ command: "y" }) })]),
    ])
    expect(turns.turns).toHaveLength(2)
    expect(turns.turns.every((turn) => turn.tools)).toBe(true)
  })
})

describe("pick", () => {
  const providers = {
    teai: {
      models: {
        auto: { capabilities: { toolcall: true } },
        "kimi-k3": { capabilities: { toolcall: true } },
        "gpt-6.1-sol": { capabilities: { toolcall: true } },
        "gpt-5": { capabilities: { toolcall: true } },
        "gpt-4o": { capabilities: { toolcall: true } },
        "gpt-3.5-turbo": { capabilities: { toolcall: true } },
        "gpt-6.1-mini": { capabilities: { toolcall: true } },
        "text-only": { capabilities: { toolcall: false } },
      },
    },
    other: {
      models: {
        "claude-opus-4.5": { capabilities: { toolcall: true } },
      },
    },
  }

  test("prefers the strongest same-provider tool model", () => {
    expect(SessionEscalation.pick(providers, { providerID: "teai", modelID: "auto" }, undefined)).toEqual({
      providerID: "teai",
      modelID: "kimi-k3",
    })
  })

  test("never picks a model from another provider", () => {
    const only = { other: providers.other }
    expect(SessionEscalation.pick(only, { providerID: "teai", modelID: "auto" }, undefined)).toBeUndefined()
  })

  test("honours a preferred strong model on the same provider", () => {
    expect(
      SessionEscalation.pick(providers, { providerID: "teai", modelID: "auto" }, { providerID: "teai", modelID: "gpt-6.1-sol" }),
    ).toEqual({ providerID: "teai", modelID: "gpt-6.1-sol" })
  })

  test("rejects a preferred weak model", () => {
    expect(
      SessionEscalation.pick(providers, { providerID: "teai", modelID: "auto" }, { providerID: "teai", modelID: "gpt-6.1-mini" }),
    ).toEqual({ providerID: "teai", modelID: "kimi-k3" })
  })

  test("rejects legacy gpt models", () => {
    const only = {
      teai: {
        models: {
          auto: { capabilities: { toolcall: true } },
          "gpt-4o": { capabilities: { toolcall: true } },
          "gpt-3.5-turbo": { capabilities: { toolcall: true } },
        },
      },
    }
    expect(SessionEscalation.pick(only, { providerID: "teai", modelID: "auto" }, undefined)).toBeUndefined()
  })

  test("ranks newer gpt versions above older ones", () => {
    const only = {
      teai: {
        models: {
          auto: { capabilities: { toolcall: true } },
          "gpt-5": { capabilities: { toolcall: true } },
          "gpt-6.1-sol": { capabilities: { toolcall: true } },
        },
      },
    }
    expect(SessionEscalation.pick(only, { providerID: "teai", modelID: "auto" }, undefined)).toEqual({
      providerID: "teai",
      modelID: "gpt-6.1-sol",
    })
  })

  test("skips the current actual model", () => {
    const only = {
      teai: {
        models: {
          "kimi-k3": { capabilities: { toolcall: true } },
          "gpt-6.1-sol": { capabilities: { toolcall: true } },
        },
      },
    }
    expect(SessionEscalation.pick(only, { providerID: "teai", modelID: "kimi-k3" }, undefined)).toEqual({
      providerID: "teai",
      modelID: "gpt-6.1-sol",
    })
  })

  test("returns undefined when no strong same-provider model exists", () => {
    const only = {
      teai: {
        models: {
          auto: { capabilities: { toolcall: true } },
          "text-only": { capabilities: { toolcall: false } },
        },
      },
    }
    expect(SessionEscalation.pick(only, { providerID: "teai", modelID: "auto" }, undefined)).toBeUndefined()
  })
})

describe("actualModel", () => {
  test("reads the routed model from the latest step-finish part", () => {
    const msgs = [
      user("msg_u1"),
      assistant("msg_a1", [stepFinish(MessageID.make("msg_a1"), "moonshotai/kimi-k3")]),
    ]
    expect(SessionEscalation.actualModel(msgs)).toEqual({ providerID: "teai", modelID: "kimi-k3" })
  })

  test("does not reuse route metadata from a previous user request", () => {
    const msgs = [
      user("msg_u1"),
      assistant("msg_a1", [stepFinish(MessageID.make("msg_a1"), "moonshotai/kimi-k3")]),
      user("msg_u2"),
      assistant("msg_a2", [stepFinish(MessageID.make("msg_a2"))]),
    ]
    expect(SessionEscalation.actualModel(msgs)).toBeUndefined()
  })

  test("does not reuse route metadata after the requested model changes", () => {
    const msgs = [
      user("msg_u1"),
      assistant("msg_a1", [stepFinish(MessageID.make("msg_a1"), "moonshotai/kimi-k3")]),
      assistant("msg_a2", [stepFinish(MessageID.make("msg_a2"))], { providerID: "teai", modelID: "gpt-5" }),
    ]
    expect(SessionEscalation.actualModel(msgs)).toBeUndefined()
  })

  test("returns undefined when no route metadata exists", () => {
    const msgs = [user("msg_u1"), assistant("msg_a1", [stepFinish(MessageID.make("msg_a1"))])]
    expect(SessionEscalation.actualModel(msgs)).toBeUndefined()
  })
})

describe("note", () => {
  test("names both models in english", () => {
    const text = SessionEscalation.note(
      { reason: "failed_turns", model: { providerID: "teai", modelID: "auto" } },
      { providerID: "teai" as never, modelID: "kimi-k3" as never },
      "en",
    )
    expect(text).toContain("teai/auto → teai/kimi-k3")
    expect(text).toContain("consecutive turns with tool failures")
    expect(text).not.toContain("モデル")
  })

  test("names both models in japanese", () => {
    const text = SessionEscalation.note(
      { reason: "failed_turns", model: { providerID: "teai", modelID: "auto" } },
      { providerID: "teai" as never, modelID: "kimi-k3" as never },
      "ja",
    )
    expect(text).toContain("自動モデル切り替え先を選択しました")
    expect(text).toContain("応答はまだ未確認")
    expect(text).not.toContain("切り替えました")
    expect(text).toContain("teai/auto → teai/kimi-k3")
    expect(text).not.toContain("consecutive turns")
  })
})

describe("stuckNote", () => {
  test("explains the stop and names the escalated model", () => {
    const text = SessionEscalation.stuckNote(
      { reason: "identical_turns", model: { providerID: "teai", modelID: "auto" } },
      { providerID: "teai" as never, modelID: "kimi-k3" as never },
      "en",
    )
    expect(text).toContain("teai/kimi-k3")
    expect(text).toContain("no progress was detected")
    expect(text).toContain("does not establish that the model caused the failure")
    expect(text).toContain("Review the tool errors")
    expect(text).not.toContain("自動")
  })
})

describe("execution safety", () => {
  const model = {
    id: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test"),
    name: "test",
    api: { id: "test-model", url: "http://localhost", npm: "@ai-sdk/openai-compatible" },
    cost: { input: 2, output: 10, cache: { read: 1, write: 3 } },
    limit: { context: 100000, output: 10000 },
    status: "active",
    capabilities: { interleaved: false, temperature: false, reasoning: false, attachment: false, toolcall: true, input: { text: true, image: false, audio: false, video: false, pdf: false }, output: { text: true, image: false, audio: false, video: false, pdf: false } },
    options: {},
    headers: {},
    release_date: "2025-01-01",
  } satisfies Provider.Model

  test("reserves the full input and output ceiling including cache writes", () => {
    expect(SessionEscalation.requestEstimate(model)).toBe(0.4)
  })

  test("automatic resume backs off and stops after the limit", () => {
    expect([1, 2, 3, 4, 5].map((count) => SessionEscalation.resumeDelay(count, 10_000))).toEqual([10_000, 20_000, 40_000, 60_000, 60_000])
    for (const count of [0, -1, 6, 1.5, NaN]) expect(SessionEscalation.resumeDelay(count, 10_000)).toBeUndefined()
    expect(SessionEscalation.resumeNote(2, "ja")).toContain("2/5")
    expect(SessionEscalation.resumeNote(2, "en")).toContain("2/5")
  })

  test("request size gives a token ceiling for both Japanese and English", () => {
    expect(SessionEscalation.requestTokens("あ".repeat(300))).toBeGreaterThanOrEqual(300)
    expect(SessionEscalation.requestTokens("word ".repeat(300))).toBeGreaterThanOrEqual(300)
    expect(SessionEscalation.requestTokens(undefined)).toBeUndefined()
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(SessionEscalation.requestTokens(loop)).toBeUndefined()
  })

  test("cost limit defaults to $5 and only 'none' turns it off", () => {
    for (const value of [undefined, "", " ", "0", "-1", "abc", "Infinity"]) {
      expect(SessionEscalation.costLimit(value)).toBe(5)
    }
    expect(SessionEscalation.costLimit("none")).toBe(Number.POSITIVE_INFINITY)
    expect(SessionEscalation.costLimit("NONE")).toBe(Number.POSITIVE_INFINITY)
    expect(SessionEscalation.costLimit("20")).toBe(20)
    expect(SessionEscalation.costLimit("0.5")).toBe(0.5)
  })

  test("observed input narrows the estimate but never exceeds the context ceiling", () => {
    const full = SessionEscalation.requestEstimate(model)!
    const narrowed = SessionEscalation.requestEstimate(model, model.limit.output, 1000)!
    expect(narrowed).toBeLessThan(full)
    expect(SessionEscalation.inputBudget(1_000_000, 100_000)).toBe(170_000)
    expect(SessionEscalation.inputBudget(100_000, 90_000)).toBe(100_000)
    expect(SessionEscalation.requestEstimate(model, model.limit.output, model.limit.context * 10)).toBe(full)
    for (const observed of [undefined, 0, -5, NaN]) {
      expect(SessionEscalation.requestEstimate(model, model.limit.output, observed)).toBe(full)
    }
  })

  test("uses the prepared output cap without weakening the input ceiling", () => {
    expect(SessionEscalation.requestEstimate(model, 2000)).toBe(0.32)
    expect(SessionEscalation.requestEstimate(model, 20000)).toBe(0.4)
    for (const cap of [0, -1, NaN, Infinity, 1.5]) {
      expect(SessionEscalation.requestEstimate(model, cap)).toBeUndefined()
    }
  })

  test("budget notices distinguish recorded cost from the conservative ceiling", () => {
    expect(SessionEscalation.COST_LIMIT_USD).toBe(5)
    const ja = SessionEscalation.budgetNote(114.6, "ja", 0.42)
    expect(ja).toContain("$0.42")
    expect(ja).toContain("$114.60")
    expect(ja).toContain("請求額ではありません")
    expect(ja).toContain("1回だけ")
    const en = SessionEscalation.budgetNote(114.6, "en", 0.42)
    expect(en).toContain("not a billed amount")
    expect(en).toContain("only the next model call")
    expect(SessionEscalation.budgetNote(undefined, "ja", 0.42)).toContain("未確認")
    expect(SessionEscalation.budgetNote(undefined, "en", 0.42)).toContain("unknown")
  })

  test("uses the most expensive context tier", () => {
    expect(SessionEscalation.requestEstimate({ ...model, cost: { ...model.cost, experimentalOver200K: { input: 20, output: 100, cache: { read: 0, write: 0 } } } })).toBe(3)
  })

  test("unknown auto pricing and invalid limits require approval", () => {
    expect(SessionEscalation.requestEstimate({ ...model, id: ModelV2.ID.make("auto"), providerID: ProviderV2.ID.make("teai"), cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } })).toBeUndefined()
    expect(SessionEscalation.requestEstimate({ ...model, limit: { context: 0, output: 100 } })).toBeUndefined()
  })

  test("recovers transient provider errors but never authentication or payment errors", () => {
    const error = (statusCode: number) => new SessionV1.APIError({ message: "service unavailable", isRetryable: true, statusCode }).toObject()
    expect(SessionEscalation.recoverable(error(503), "test")).toBe(true)
    for (const status of [401, 402, 403, 429]) expect(SessionEscalation.recoverable(error(status), "test")).toBe(false)
    expect(SessionEscalation.recoverable(new SessionV1.AbortedError({ message: "aborted" }).toObject(), "test")).toBe(false)
    expect(SessionEscalation.recoverable(new SessionV1.OutputLengthError({}).toObject(), "test")).toBe(true)
  })

  test.each([
    { message: "Rate limit exceeded, please try again later" },
    { message: "HTTP 429: service unavailable" },
    { message: "Request failed", responseBody: '{"error":{"type":"too_many_requests"}}' },
  ])("never escalates rate limits to another model: %j", (data) => {
    const error = new SessionV1.APIError({ ...data, isRetryable: true, statusCode: 503 }).toObject()
    expect(SessionEscalation.recoverable(error, "test")).toBe(false)
  })
})

describe("instruction", () => {
  test("tells the model to change approach without claiming success", () => {
    const text = SessionEscalation.instruction("en")
    expect(text).toContain("Change approach")
    expect(text).toContain("do not repeat identical tool calls")
    expect(text).toContain("preserve existing permissions")
    expect(text).toContain("report blocked external dependencies")
    expect(text).not.toContain("succeeded")
  })

  test("has a japanese variant", () => {
    const text = SessionEscalation.instruction("ja")
    expect(text).toContain("方針を変えてください")
  })
})

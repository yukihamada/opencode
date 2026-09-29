import { describe, expect, test } from "bun:test"
import { Economy } from "../../src/session/economy"
import type { SessionV1 } from "@sente-ai/core/v1/session"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { ProviderV2 } from "@sente-ai/core/provider"
import { ModelV2 } from "@sente-ai/core/model"
import { LayerNode } from "@sente-ai/core/effect/layer-node"
import { Global } from "@sente-ai/core/global"
import { FSUtil } from "@sente-ai/core/fs-util"
import { Effect, Exit } from "effect"
import path from "path"
import { Storage } from "../../src/storage/storage"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, FSUtil.node])))

const ledger = Effect.fnUntraced(function* () {
  const sessionID = crypto.randomUUID()
  const userID = "msg_user"
  const storage = yield* Storage.Service
  const fs = yield* FSUtil.Service
  yield* Effect.addFinalizer(() =>
    fs
      .remove(path.join(Global.Path.data, "storage", ...Economy.ledgerKey(sessionID, userID)), {
        recursive: true,
        force: true,
      })
      .pipe(Effect.ignore),
  )
  return { sessionID, userID, storage }
})

describe("economy ledger", () => {
  it.live("refuses an unsettled reservation even before the assistant was persisted", () =>
    Effect.gen(function* () {
      const { sessionID, userID } = yield* ledger()
      expect(yield* Economy.load(sessionID, userID, config, [])).toEqual([])
      yield* Economy.admit(sessionID, userID, 0, { id: "msg_economy", reserve: 0.2 })
      expect(Exit.isFailure(yield* Effect.exit(Economy.load(sessionID, userID, config, [])))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(Economy.load(sessionID, userID, config, [message([])])))).toBe(true)
    }),
  )

  it.live("replays server evidence without trusting edited message cost or tool results", () =>
    Effect.gen(function* () {
      const { sessionID, userID } = yield* ledger()
      yield* Economy.load(sessionID, userID, config, [])
      yield* Economy.admit(sessionID, userID, 0, { id: "msg_economy", reserve: 0.2 })
      yield* Economy.settle(sessionID, userID, 0, failure())
      const edited = message([{ exit: 0, end: 2 }])
      if (edited.info.role !== "assistant") throw new Error("invalid fixture")
      edited.info.cost = 0
      expect(yield* Economy.load(sessionID, userID, config, [edited])).toEqual([failure()])
      expect(Exit.isFailure(yield* Effect.exit(Economy.load(sessionID, userID, undefined, [edited])))).toBe(true)
      expect(
        Exit.isFailure(yield* Effect.exit(Economy.load(sessionID, userID, { ...config, maxUsd: 20 }, [edited]))),
      ).toBe(true)
    }),
  )

  it.live("admits only one concurrent turn and never overwrites its completion", () =>
    Effect.gen(function* () {
      const { sessionID, userID } = yield* ledger()
      yield* Economy.load(sessionID, userID, config, [])
      const results = yield* Effect.all(
        Array.from({ length: 20 }, () =>
          Effect.exit(Economy.admit(sessionID, userID, 0, { id: "msg_economy", reserve: 0.2 })),
        ),
        { concurrency: "unbounded" },
      )
      expect(results.filter(Exit.isSuccess)).toHaveLength(1)
      yield* Economy.settle(sessionID, userID, 0, failure())
      expect(Exit.isFailure(yield* Effect.exit(Economy.settle(sessionID, userID, 0, turn())))).toBe(true)
      expect(yield* Economy.load(sessionID, userID, config, [message([])])).toEqual([failure()])
    }),
  )

  it.live("rejects missing, malformed and inconsistent historical records", () =>
    Effect.gen(function* () {
      const { sessionID, userID, storage } = yield* ledger()
      expect(Exit.isFailure(yield* Effect.exit(Economy.load(sessionID, userID, config, [message([])])))).toBe(true)
      yield* Economy.load(sessionID, userID, config, [])
      yield* Economy.admit(sessionID, userID, 0, { id: "msg_economy", reserve: 0.2 })
      yield* storage.write([...Economy.ledgerKey(sessionID, userID), "0", "completion"], { reserve: 0 })
      expect(Exit.isFailure(yield* Effect.exit(Economy.load(sessionID, userID, config, [message([])])))).toBe(true)
      yield* storage.write([...Economy.ledgerKey(sessionID, userID), "0", "completion"], turn({ reserve: 0 }))
      expect(Exit.isFailure(yield* Effect.exit(Economy.load(sessionID, userID, config, [message([])])))).toBe(true)
    }),
  )
})

const config: Economy.Config = {
  verification: [{ command: "npm test", cwd: "/fixture" }],
  models: ["test/economy", "test/standard", "test/advanced"],
  maxUsd: 10,
  maxTurns: 8,
  maxEscalations: 2,
}

function turn(input: Partial<Economy.Turn> = {}): Economy.Turn {
  return {
    model: config.models[0],
    cost: 0.1,
    reserve: 0.2,
    complete: true,
    stopped: false,
    failures: [],
    ...input,
  }
}

function message(checks: { command?: string; cwd?: string; exit: number; end: number }[]): SessionV1.WithParts {
  const sessionID = SessionID.make("ses_economy")
  const messageID = MessageID.make("msg_economy")
  return {
    info: {
      id: messageID,
      sessionID,
      parentID: MessageID.make("msg_user"),
      role: "assistant",
      mode: "build",
      agent: "build",
      modelID: ModelV2.ID.make("economy"),
      providerID: ProviderV2.ID.make("test"),
      path: { cwd: "/fixture", root: "/fixture" },
      cost: 0.1,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, completed: 100 },
      finish: "tool-calls",
    },
    parts: checks.map((check, index) => ({
      id: PartID.make(`prt_check${index}`),
      sessionID,
      messageID,
      type: "tool",
      tool: "bash",
      callID: `check${index}`,
      state: {
        status: "completed",
        input: { command: check.command ?? "npm test", workdir: check.cwd ?? "/fixture" },
        output: "verification result",
        title: "verification",
        metadata: { exit: check.exit },
        time: { start: 1, end: check.end },
      },
    })),
  }
}

const failure = () => turn({ failures: ["bash:npm test"] })

describe("economy evidence", () => {
  test("requires an approved command and cwd", () => {
    for (const check of [
      { command: "cat missing", exit: 1, end: 2 },
      { command: "npm test --extra", exit: 1, end: 2 },
      { cwd: "/other", exit: 1, end: 2 },
    ]) {
      const result = Economy.evidence(message([check]), 0.2, config.verification)
      expect(result.failures).toEqual([])
      expect(result.stopped).toBe(false)
    }
    expect(Economy.evidence(message([{ exit: 1, end: 2 }]), 0.2, config.verification).failures).toEqual([
      JSON.stringify(["npm test", "/fixture"]),
    ])
  })

  test("uses the last completed result rather than the part array order", () => {
    for (const checks of [
      [
        { exit: 1, end: 2 },
        { exit: 0, end: 3 },
      ],
      [
        { exit: 0, end: 3 },
        { exit: 1, end: 2 },
      ],
    ]) {
      const result = Economy.evidence(message(checks), 0.2, config.verification)
      expect(result.failures).toEqual([])
      expect(Economy.next(config, [failure(), result], () => 0.2).tier).toBe(0)
    }
    expect(
      Economy.evidence(
        message([
          { exit: 0, end: 2 },
          { exit: 1, end: 3 },
        ]),
        0.2,
        config.verification,
      ).failures,
    ).toHaveLength(1)
  })

  test("stops on ambiguous completion order and interrupted tools", () => {
    expect(
      Economy.evidence(
        message([
          { exit: 0, end: 2 },
          { exit: 1, end: 2 },
        ]),
        0.2,
        config.verification,
      ).stopped,
    ).toBe(true)
    const interrupted = message([{ exit: 1, end: 2 }])
    const part = interrupted.parts[0]
    if (part.type !== "tool") throw new Error("invalid fixture")
    part.state = { status: "error", input: part.state.input, error: "Permission denied", time: { start: 1, end: 2 } }
    expect(Economy.evidence(interrupted, 0.2, config.verification).stopped).toBe(true)
  })
})

describe("economy policy", () => {
  test("starts at the first approved model", () => {
    expect(Economy.next(config, [], () => 0.2)).toEqual({ tier: 0, reserve: 0.2 })
  })

  test("escalates after the same failure in two consecutive turns", () => {
    expect(Economy.next(config, [failure()], () => 0.2).tier).toBe(0)
    expect(Economy.next(config, [failure(), failure()], (tier) => tier + 1)).toEqual({ tier: 1, reserve: 2 })
  })

  test("duplicate failures in one turn do not escalate", () => {
    expect(Economy.next(config, [turn({ failures: ["bash:npm test", "bash:npm test"] })], () => 0.2).tier).toBe(0)
  })

  test("successful turns and different failures break the streak", () => {
    for (const middle of [turn(), turn({ failures: ["bash:npm run lint"] })]) {
      expect(Economy.next(config, [failure(), middle, failure()], () => 0.2).tier).toBe(0)
    }
    expect(Economy.next(config, [turn(), turn(), turn()], () => 0.2).tier).toBe(0)
  })

  test("keeps the upgraded model and requires new evidence before escalating again", () => {
    const upgraded = turn({ model: config.models[1], failures: ["bash:npm test"] })
    expect(Economy.next(config, [failure(), failure(), upgraded], () => 0.2).tier).toBe(1)
    expect(Economy.next(config, [failure(), failure(), upgraded, upgraded], () => 0.2).tier).toBe(2)
  })

  test("rejects skipped, downgraded, unapproved and unjustified model histories", () => {
    const upgraded = turn({ model: config.models[1] })
    for (const turns of [
      [upgraded],
      [turn(), upgraded],
      [turn({ model: "test/unapproved" })],
      [failure(), failure(), turn()],
      [failure(), failure(), turn({ model: config.models[2] })],
      [failure(), failure(), upgraded, turn()],
    ]) {
      expect(() => Economy.next(config, turns, () => 0.2)).toThrow("inconsistent model history")
    }
  })

  test("stops at the escalation and ladder limits", () => {
    for (const limits of [
      { ...config, maxEscalations: 0 },
      { ...config, models: [config.models[0]] },
    ]) {
      expect(() => Economy.next(limits, [failure(), failure()], () => 0.2)).toThrow("escalation limit")
    }
  })

  test("stops before requesting another reservation at the turn limit", () => {
    let called = false
    expect(() =>
      Economy.next({ ...config, maxTurns: 1 }, [turn()], () => {
        called = true
        return 0
      }),
    ).toThrow("provider turn limit")
    expect(called).toBe(false)
  })

  test("accounts conservatively for every historical reservation and actual cost", () => {
    const turns = [turn({ cost: 0.5, reserve: 0.25 }), turn({ cost: 0.1, reserve: 0.25 })]
    expect(Economy.next({ ...config, maxUsd: 1 }, turns, () => 0.25).tier).toBe(0)
    expect(() => Economy.next({ ...config, maxUsd: 1 }, turns, () => 0.26)).toThrow("budget exhausted")
    expect(() => Economy.next({ ...config, maxUsd: 1 }, [], () => 1.01)).toThrow("budget exhausted")
  })

  test("checks the upgraded model reservation against the remaining budget", () => {
    expect(() => Economy.next({ ...config, maxUsd: 1 }, [failure(), failure()], (tier) => tier)).toThrow(
      "budget exhausted",
    )
  })

  test("rejects interrupted or stopped histories instead of escalating", () => {
    for (const stopped of [{ complete: false }, { stopped: true }]) {
      expect(() =>
        Economy.next(config, [failure(), turn({ ...stopped, failures: ["bash:npm test"] })], () => 0),
      ).toThrow("resume refused")
    }
  })

  test("fails closed on unknown, negative or overflowing costs", () => {
    for (const value of [NaN, Infinity, -1]) {
      expect(() => Economy.next(config, [turn({ cost: value })], () => 0)).toThrow("unknown cost")
      expect(() => Economy.next(config, [turn({ reserve: value })], () => 0)).toThrow("unknown cost")
      expect(() => Economy.next(config, [], () => value)).toThrow("unknown model price")
    }
    expect(() =>
      Economy.next(config, [turn({ cost: Number.MAX_VALUE }), turn({ cost: Number.MAX_VALUE })], () => 0),
    ).toThrow("budget exhausted")
  })

  test("rejects invalid limits, ladders and failure evidence", () => {
    for (const limits of [
      { models: [] },
      { models: ["test/a", "test/a"] },
      { models: [" "] },
      { models: [" test/a"] },
      { maxUsd: NaN },
      { maxUsd: Infinity },
      { maxUsd: 0 },
      { maxTurns: 0 },
      { maxTurns: 1.5 },
      { maxTurns: Number.MAX_SAFE_INTEGER + 1 },
      { maxEscalations: -1 },
      { maxEscalations: 0.5 },
    ]) {
      expect(() => Economy.next({ ...config, ...limits }, [], () => 0)).toThrow("invalid limits")
    }
    expect(() => Economy.next(config, [turn({ failures: [""] })], () => 0)).toThrow("invalid failure evidence")
  })

  test("is deterministic across replay and independent between caller histories", () => {
    const turns = [failure(), failure()]
    const snapshot = structuredClone(turns)
    expect(Economy.next(config, turns, () => 0.2).tier).toBe(1)
    expect(Economy.next(config, [], () => 0.2).tier).toBe(0)
    expect(Economy.next(config, structuredClone(turns), () => 0.2).tier).toBe(1)
    expect(turns).toEqual(snapshot)
  })
})

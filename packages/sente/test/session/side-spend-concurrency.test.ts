import { describe, expect } from "bun:test"
import { SessionProjector } from "@sente-ai/core/session/projector"
import { Effect, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageID, PartID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@sente-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { AppNodeBuilder } from "@sente-ai/core/effect/app-node-builder"
import { LayerNode } from "@sente-ai/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { SideSpend } from "@/session/side-spend"
import { ModelV2 } from "@sente-ai/core/model"
import { ProviderV2 } from "@sente-ai/core/provider"
import { Database } from "@sente-ai/core/database/database"
import { EventTable } from "@sente-ai/core/event/sql"
import { SessionTable } from "@sente-ai/core/session/sql"
import { asc, eq } from "drizzle-orm"
import { EventV2 } from "@sente-ai/core/event"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([SessionNs.node, EventV2Bridge.node, SessionProjector.node, CrossSpawnSpawner.node, InstanceStore.node, Database.node]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [InstanceBootstrap.node, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))],
    ],
  ),
)

describe("/btw spend vs other session writes", () => {
  it.instance("concurrent /btw records, title/touch/metadata writes and step costs all survive", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* session.create({ title: "race" })
      const user = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: info.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        time: { created: Date.now() },
      })
      const assistant = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: user.id,
        sessionID: info.id,
        mode: "build",
        agent: "build",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: Date.now() },
      })
      const n = 25
      const stepCost = (i: number) =>
        session.updatePart({
          id: PartID.ascending(),
          messageID: assistant.id,
          sessionID: info.id,
          type: "step-finish",
          reason: "stop",
          cost: 0.01,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        }).pipe(Effect.asVoid, Effect.withSpan(`step-${i}`))
      yield* Effect.all(
        Array.from({ length: n }, (_, i) => [
          session.addSideSpend({ sessionID: info.id, usd: 0.001, time: Date.now() }),
          session.setTitle({ sessionID: info.id, title: `t${i}` }),
          session.touch(info.id),
          session.setMetadata({ sessionID: info.id, metadata: { cost_limit_usd: i + 1 } }),
          stepCost(i),
        ]).flat(),
        { concurrency: "unbounded" },
      )
      const after = yield* session.get(info.id)
      expect(SideSpend.spentOn(after.metadata)).toBeCloseTo(n * 0.001, 10)
      expect(after.cost).toBeCloseTo(n * 0.01, 10)
      expect(typeof after.metadata?.cost_limit_usd).toBe("number")
    }),
  )

  it.instance("a /btw cost is a durable event: other clients are told, and rebuilding from the event log keeps it", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const { db } = yield* Database.Service
      const seen: unknown[] = []
      const unsub = yield* events.listen((event) => {
        if (event.type === "session.side_spent") seen.push(event.data)
        return Effect.void
      })
      const info = yield* session.create({ title: "replay" })
      yield* session.setTitle({ sessionID: info.id, title: "renamed" })
      yield* session.addSideSpend({ sessionID: info.id, usd: 0.25, time: 1000 })
      yield* session.addSideSpend({ sessionID: info.id, usd: 0.5, time: 2000 })
      yield* unsub
      expect(seen).toEqual([
        { sessionID: info.id, usd: 0.25, time: 1000 },
        { sessionID: info.id, usd: 0.5, time: 2000 },
      ])
      const before = yield* session.get(info.id)
      expect(SideSpend.spentOn(before.metadata)).toBeCloseTo(0.75, 10)

      // Rebuild: drop the projected row and the log, then replay the log.
      const log = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, info.id)).orderBy(asc(EventTable.seq)).all().pipe(Effect.orDie)
      expect(log.map((row) => row.type)).toContain(EventV2.versionedType("session.side_spent", 1))
      yield* db.delete(SessionTable).where(eq(SessionTable.id, info.id)).run().pipe(Effect.orDie)
      yield* events.remove(info.id)
      yield* events.replayAll(log.map((row) => ({ id: row.id, aggregateID: row.aggregate_id, seq: row.seq, type: row.type, data: row.data })))

      const rebuilt = yield* session.get(info.id)
      expect(rebuilt.title).toBe("renamed")
      expect(SideSpend.spentOn(rebuilt.metadata)).toBeCloseTo(0.75, 10)
      expect(rebuilt.time.updated).toBe(before.time.updated)
    }),
  )

  it.instance("older-message search looks only at visible text and tool output, ranked by matched words before the limit", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* session.create({ title: "search" })
      const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }
      const message = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: info.id,
        agent: "build",
        model,
        time: { created: Date.now() },
      })
      const text = (value: string, extra: Record<string, unknown> = {}) =>
        session.updatePart({ id: PartID.ascending(), messageID: message.id, sessionID: info.id, type: "text", text: value, ...extra })
      const tool = (input: Record<string, unknown>, output: string) =>
        session.updatePart({
          id: PartID.ascending(),
          messageID: message.id,
          sessionID: info.id,
          type: "tool",
          callID: PartID.ascending(),
          tool: "bash",
          state: { status: "completed", input, output, title: "t", metadata: {}, time: { start: 1, end: 2 } },
        })
      // Would match only through keys/ids/input or hidden text: must not be found.
      yield* tool({ filePath: "test/build.ts", command: "test" }, "ok")
      yield* text("test build hidden", { ignored: true })
      yield* text("test build injected", { synthetic: true })
      // Real matches: one word, then both words.
      yield* tool({ command: "bun test" }, "Ran 14 tests")
      yield* text("the build and test plan")
      yield* Effect.sleep("20 millis")
      const before = Date.now()

      const all = yield* session.searchParts({ sessionID: info.id, before, terms: ["test", "build"], limit: 10 })
      expect(all.map((item) => (item.part.type === "text" ? item.part.text : item.part.type === "tool" && item.part.state.status === "completed" ? item.part.state.output : ""))).toEqual([
        "the build and test plan",
        "Ran 14 tests",
      ])
      const top = yield* session.searchParts({ sessionID: info.id, before, terms: ["test", "build"], limit: 1 })
      expect(top).toHaveLength(1)
      expect(top[0]!.part.type).toBe("text")
      expect(yield* session.searchParts({ sessionID: info.id, before: 0, terms: ["test"], limit: 10 })).toEqual([])
    }),
  )
})

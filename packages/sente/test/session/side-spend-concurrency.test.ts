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

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([SessionNs.node, EventV2Bridge.node, SessionProjector.node, CrossSpawnSpawner.node, InstanceStore.node]),
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
})

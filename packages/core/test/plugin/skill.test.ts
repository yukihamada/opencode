import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@sente-ai/core/effect/app-node-builder"
import { LayerNode } from "@sente-ai/core/effect/layer-node"
import { EventV2 } from "@sente-ai/core/event"
import { Database } from "@sente-ai/core/database/database"
import { Watcher } from "@sente-ai/core/filesystem/watcher"
import { SkillPlugin } from "@sente-ai/core/plugin/skill"
import { SkillV2 } from "@sente-ai/core/skill"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const watcher = Layer.succeed(
  Watcher.Service,
  Watcher.Service.of({ watch: () => Effect.succeed(Effect.void) }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SkillV2.node, Database.node, EventV2.node]), [[Watcher.node, watcher]]),
)

describe("SkillPlugin.Plugin", () => {
  it.effect("registers the built-in customize-sente skill", () =>
    Effect.gen(function* () {
      const skill = yield* SkillV2.Service
      yield* SkillPlugin.Plugin.effect(host({ skill: { ...skill, reload: skill.reload } }))

      expect(yield* skill.list()).toContainEqual(
        expect.objectContaining({
          name: "customize-sente",
          description: expect.stringContaining("sente's own configuration"),
        }),
      )
    }),
  )
})

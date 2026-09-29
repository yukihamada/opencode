import { describe, expect, test } from "bun:test"
import { LayerNode } from "@sente-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@sente-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Command } from "../../src/command"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(Command.node), LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer),
)

const emptyDir = () => fs.mkdtemp(path.join(os.tmpdir(), "sente-guide-"))

describe("guide command", () => {
  test("bundles the ja and en guides when the user has none", async () => {
    const template = await Command.guideTemplate(await emptyDir())
    expect(template).toContain('<guide lang="ja">\n# Sente かんたんガイド')
    expect(template).toContain('<guide lang="en">\n# Sente quick guide')
    expect(template).toContain("/mode 節約|標準|たっぷり")
    expect(template).toContain("te resume")
    expect(template).toContain("$ARGUMENTS")
  })

  test("prefers the user's guide file for that language only", async () => {
    const dir = await emptyDir()
    await Bun.write(path.join(dir, "guide.ja.md"), "# 自分用ガイド\n")
    const template = await Command.guideTemplate(dir)
    expect(template).toContain('<guide lang="ja">\n# 自分用ガイド\n</guide>')
    expect(template).not.toContain("# Sente かんたんガイド")
    expect(template).toContain('<guide lang="en">\n# Sente quick guide')
  })

  it.live("is a built-in command", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const command = yield* Command.Service
        const guide = yield* command.get("guide")
        expect(guide?.source).toBe("command")
        expect(guide?.hints).toEqual(["$ARGUMENTS"])
        expect(yield* Effect.promise(async () => String(await guide?.template))).toContain("# Sente quick guide")
      }),
    ),
  )

  it.live("a user's own guide command replaces the built-in", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const command = yield* Command.Service
          const guide = yield* command.get("guide")
          expect(yield* Effect.promise(async () => String(await guide?.template))).toBe("read my guide $ARGUMENTS")
        }),
      { config: { command: { guide: { template: "read my guide $ARGUMENTS" } } } },
    ),
  )
})

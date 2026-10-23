import { describe, expect } from "bun:test"
import path from "path"
import { Cause, Effect, Exit, Schema } from "effect"
import { LayerNode } from "@sente-ai/core/effect/layer-node"
import { FSUtil } from "@sente-ai/core/fs-util"
import { CrossSpawnSpawner } from "@sente-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@sente-ai/core/ripgrep"
import { Agent } from "@/agent/agent"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "@/session/instruction"
import { MessageID, SessionID } from "@/session/schema"
import { InvestigateTool, Parameters, mergeRanges } from "@/tool/investigate"
import { GrepTool } from "@/tool/grep"
import { ReadTool } from "@/tool/read"
import { Truncate } from "@/tool/truncate"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      Instruction.node,
      LSP.node,
      Ripgrep.node,
      Truncate.node,
    ]),
  ),
)
const ctx = {
  sessionID: SessionID.make("ses_investigate"),
  messageID: MessageID.make("msg_investigate"),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("tool.investigate", () => {
  it.instance("merging preserves both hits with less output than grep plus overlapping reads", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* FSUtil.Service
      const file = path.join(test.directory, "sample.ts")
      yield* fs.writeFileString(
        file,
        Array.from(
          { length: 120 },
          (_, i) => `${i === 49 || i === 51 ? "needle" : "context"} ${i + 1}: ${"x".repeat(70)}`,
        ).join("\n"),
      )
      const investigator = yield* InvestigateTool
      const investigate = yield* investigator.init()
      const searcher = yield* GrepTool
      const grep = yield* searcher.init()
      const reader = yield* ReadTool
      const read = yield* reader.init()
      const result = yield* investigate.execute({ pattern: "needle", path: file }, ctx)
      const baseline = [
        (yield* grep.execute({ pattern: "needle", path: file }, ctx)).output,
        (yield* read.execute({ filePath: file, offset: 35, limit: 31 }, ctx)).output,
        (yield* read.execute({ filePath: file, offset: 37, limit: 31 }, ctx)).output,
      ].join("\n")
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).toContain("50: needle 50:")
      expect(result.output).toContain("52: needle 52:")
      expect(result.output.match(/^\d+: /gm)).toHaveLength(33)
      expect(baseline.match(/^\d+: /gm)).toHaveLength(62)
      expect(Buffer.byteLength(result.output)).toBeLessThan(Buffer.byteLength(baseline) * 0.65)
    }),
  )

  it.effect("merges only adjacent or overlapping ranges in the same file", () =>
    Effect.sync(() => {
      expect(
        mergeRanges(
          [
            { file: "b", line: 2 },
            { file: "a", line: 10 },
            { file: "a", line: 2 },
            { file: "a", line: 4 },
          ],
          1,
        ),
      ).toEqual([
        { file: "a", start: 1, end: 5 },
        { file: "a", start: 9, end: 11 },
        { file: "b", start: 1, end: 3 },
      ])
      const decode = Schema.decodeUnknownSync(Parameters)
      for (const args of [{ pattern: "" }, { pattern: "a", limit: 21 }, { pattern: "a", context: -1 }]) {
        expect(() => decode(args)).toThrow()
      }
    }),
  )

  it.instance("searches one file, reads merged context once, and preserves instructions", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* FSUtil.Service
      yield* fs.ensureDir(path.join(test.directory, "src"))
      yield* fs.writeFileString(path.join(test.directory, "src/AGENTS.md"), "Follow the nested rules")
      const file = path.join(test.directory, "src/a.ts")
      yield* fs.writeFileString(file, "before\nneedle\nbetween\nneedle\nafter\n")
      yield* fs.writeFileString(path.join(test.directory, "src/b.ts"), "needle sibling")
      const tool = yield* InvestigateTool
      const def = yield* tool.init()
      const result = yield* def.execute({ pattern: "needle", path: file, context: 1 }, ctx)
      expect(result.metadata.matches).toBe(2)
      expect(result.metadata.ranges).toBe(1)
      expect(result.metadata.truncated).toBe(false)
      expect(result.output.match(/3: between/g)).toHaveLength(1)
      expect(result.output).toContain("1: before")
      expect(result.output).toContain("5: after")
      expect(result.output).not.toContain("sibling")
      expect(result.output).toContain("Follow the nested rules")
      expect(result.metadata.loaded).toContain(path.join(test.directory, "src/AGENTS.md"))
    }),
  )

  it.instance("honors read denial instead of exposing grep text", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* FSUtil.Service
      const file = path.join(test.directory, "private.txt")
      yield* fs.writeFileString(file, "needle confidential")
      const tool = yield* InvestigateTool
      const def = yield* tool.init()
      const exit = yield* def
        .execute(
          { pattern: "needle", path: file },
          {
            ...ctx,
            ask: (req) => (req.permission === "read" ? Effect.die(new Error("read denied")) : Effect.void),
          },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("read denied")
    }),
  )

  it.instance("bounds snippets and reports omitted results", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* FSUtil.Service
      const file = path.join(test.directory, "many.ts")
      yield* fs.writeFileString(file, Array.from({ length: 30 }, (_, i) => (i % 2 ? "gap" : "needle")).join("\n"))
      const tool = yield* InvestigateTool
      const def = yield* tool.init()
      const result = yield* def.execute({ pattern: "needle", path: file, context: 0 }, ctx)
      expect(result.metadata.ranges).toBe(4)
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Investigation truncated")
      expect(result.output.match(/<path>/g)).toHaveLength(4)
      const empty = yield* def.execute({ pattern: "absent", path: file }, ctx)
      expect(empty.output).toBe("No matches found")
    }),
  )
})

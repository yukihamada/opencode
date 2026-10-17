import path from "path"
import { Effect, Schema } from "effect"
import { FSUtil } from "@sente-ai/core/fs-util"
import { Ripgrep } from "@sente-ai/core/ripgrep"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "./tool"
import { ReadTool } from "./read"
import { assertExternalDirectoryEffect } from "./external-directory"

export const Parameters = Schema.Struct({
  pattern: Schema.String.check(Schema.isMinLength(1)).annotate({ description: "Regex to search for" }),
  path: Schema.optional(Schema.String).annotate({ description: "File or directory; defaults to the working directory" }),
  include: Schema.optional(Schema.String).annotate({ description: "File glob, e.g. *.{ts,tsx}" }),
  context: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 }))).annotate({
    description: "Lines before and after each match (default 15)",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))).annotate({
    description: "Matching lines to investigate (default 8, maximum 20)",
  }),
})

export function mergeRanges(matches: readonly { file: string; line: number }[], context: number) {
  const ranges: { file: string; start: number; end: number }[] = []
  for (const match of matches.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    const start = Math.max(1, match.line - context)
    const end = match.line + context
    const last = ranges.at(-1)
    if (last?.file === match.file && start <= last.end + 1) {
      last.end = Math.max(last.end, end)
      continue
    }
    ranges.push({ file: match.file, start, end })
  }
  return ranges
}

export const InvestigateTool = Tool.define(
  "investigate",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    const reader = yield* ReadTool
    const read = yield* reader.init()
    return {
      description:
        "Search code and read surrounding lines in one call, merging overlapping ranges. Prefer this over grep followed by several reads when you need local code context. Returns at most four merged snippets, each capped at 8 KiB of text, plus applicable instructions. More results and omitted ranges are explicitly marked; narrow the query or use read to continue. No model calls or subagents are used.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "investigate", patterns: [params.pattern], always: ["*"], metadata: params })
          yield* ctx.ask({ permission: "grep", patterns: [params.pattern], always: ["*"], metadata: params })
          const instance = yield* InstanceState.context
          const requested = path.resolve(instance.directory, params.path ?? ".")
          const stat = yield* fs.stat(requested)
          yield* assertExternalDirectoryEffect(ctx, requested, {
            kind: stat.type === "Directory" ? "directory" : "file",
          })
          const cwd = stat.type === "Directory" ? requested : path.dirname(requested)
          const limit = params.limit ?? 8
          const matches = yield* ripgrep.grep({
            cwd,
            file: stat.type === "Directory" ? undefined : path.basename(requested),
            pattern: params.pattern,
            include: params.include,
            limit: limit + 1,
          })
          const ranges = mergeRanges(
            matches.slice(0, limit).map((match) => ({ file: path.resolve(cwd, match.entry.path), line: match.line })),
            params.context ?? 15,
          )
          const output: string[] = []
          const loaded = new Set<string>()
          let truncated = matches.length > limit || ranges.length > 4
          for (const range of ranges.slice(0, 4)) {
            const result = yield* read.execute(
              { filePath: range.file, offset: range.start, limit: range.end - range.start + 1 },
              ctx,
            )
            output.push(result.output)
            for (const file of result.metadata.loaded) loaded.add(file)
            const display = result.metadata.display
            if (display?.type === "file" && display.truncated && display.lineEnd < range.end) truncated = true
          }
          return {
            title: params.pattern,
            metadata: {
              matches: Math.min(matches.length, limit),
              ranges: Math.min(ranges.length, 4),
              truncated,
              loaded: [...loaded],
            },
            output:
              output.length === 0
                ? "No matches found"
                : output.join("\n\n") +
                  (truncated
                    ? "\n\n(Investigation truncated. Narrow path/pattern or read the shown file and line ranges to continue.)"
                    : ""),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

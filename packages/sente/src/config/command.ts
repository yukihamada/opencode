export * as ConfigCommand from "./command"

import path from "path"
import { Cause, Exit, Schema } from "effect"
import { Glob } from "@sente-ai/core/util/glob"
import { ConfigCommandV1 } from "@sente-ai/core/v1/config/command"
import { configEntryNameFromPath } from "./entry-name"
import { InvalidError } from "@sente-ai/core/v1/config/error"
import * as ConfigMarkdown from "./markdown"

const decodeInfo = Schema.decodeUnknownExit(ConfigCommandV1.Info)

export async function load(dir: string) {
  const result: Record<string, ConfigCommandV1.Info> = {}
  // 🚀 perf: this recursive ** glob used to walk the whole tree looking for any
  // command/commands directory, including node_modules/.git — multi-second on a
  // real project with a few GB of node_modules (measured 3.6s on a repo with a
  // 5GB node_modules). Those directories never legitimately contain user command
  // definitions, so skip them outright.
  for (const item of await Glob.scan("{command,commands}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
    ignore: ["**/node_modules/**", "**/.git/**"],
  })) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const name = configEntryNameFromPath(path.relative(dir, item), ["command/", "commands/"])

    const config = {
      name,
      ...md.data,
      template: md.content.trim(),
    }
    const parsed = decodeInfo(config, { errors: "all", propertyOrder: "original" })
    if (Exit.isSuccess(parsed)) {
      result[config.name] = parsed.value
      continue
    }
    throw new InvalidError({ path: item, message: Cause.pretty(parsed.cause) }, { cause: Cause.squash(parsed.cause) })
  }
  return result
}

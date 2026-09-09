/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeSenteContent from "./skill/customize-sente.md" with { type: "text" }

export const CustomizeSenteContent = customizeSenteContent

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-sente",
            description:
              "Use ONLY when the user is editing or creating sente's own configuration: sente.json, sente.jsonc, files under .sente/, or files under ~/.config/sente/. Also use when creating or fixing sente agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring sente itself.",
            location: AbsolutePath.make("/builtin/customize-sente.md"),
            content: CustomizeSenteContent,
          }),
        }),
      )
    })
  }),
})

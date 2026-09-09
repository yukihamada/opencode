import { run as runTui, type TuiInput } from "@sente-ai/tui"
import { Global } from "@sente-ai/core/global"
import { AppNodeBuilder } from "@sente-ai/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}

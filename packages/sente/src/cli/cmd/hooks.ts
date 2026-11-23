import { EOL } from "os"
import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { cmd } from "./cmd"

const load = Effect.fn("Cli.hooks.load")(function* () {
  const { Config } = yield* Effect.promise(() => import("@/config/config"))
  const { ConfigHooks } = yield* Effect.promise(() => import("@/config/hooks"))
  const config = yield* Config.Service.use((cfg) => cfg.get())
  const trust = yield* Effect.promise(() => ConfigHooks.readTrust())
  return { ConfigHooks, trust, statuses: ConfigHooks.status(config.hook_origins ?? [], trust) }
})

const ListCommand = effectCmd({
  command: "list",
  describe: "show configured hooks and whether they run",
  handler: Effect.fn("Cli.hooks.list")(function* () {
    const { statuses } = yield* load()
    if (!statuses.length) {
      process.stdout.write("no hooks configured" + EOL)
      return
    }
    for (const item of statuses) {
      process.stdout.write(`${item.trusted ? "on " : "OFF"} ${item.source} (${item.reason})${EOL}`)
      for (const hook of item.hooks)
        process.stdout.write(`    ${hook.event}${hook.matcher ? ` [${hook.matcher}]` : ""}: ${hook.command}${EOL}`)
    }
  }),
})

const TrustCommand = effectCmd({
  command: "trust",
  describe: "allow this project's own hooks to run (until they change)",
  handler: Effect.fn("Cli.hooks.trust")(function* () {
    const { ConfigHooks, trust, statuses } = yield* load()
    const pending = statuses.filter((item) => !item.trusted)
    if (!pending.length) {
      process.stdout.write("nothing to trust: no untrusted project hooks" + EOL)
      return
    }
    for (const item of pending) {
      process.stdout.write(`trusting ${item.source}:${EOL}`)
      for (const hook of item.hooks)
        process.stdout.write(`    ${hook.event}${hook.matcher ? ` [${hook.matcher}]` : ""}: ${hook.command}${EOL}`)
    }
    yield* Effect.promise(() =>
      ConfigHooks.writeTrust({
        ...trust,
        ...Object.fromEntries(pending.map((item) => [item.source, item.fingerprint])),
      }),
    )
    process.stdout.write(`saved to ${ConfigHooks.trustFile()}${EOL}`)
  }),
})

const UntrustCommand = effectCmd({
  command: "untrust",
  describe: "stop running this project's own hooks",
  handler: Effect.fn("Cli.hooks.untrust")(function* () {
    const { ConfigHooks, trust, statuses } = yield* load()
    const sources = new Set(statuses.map((item) => item.source))
    const next = Object.fromEntries(Object.entries(trust).filter((entry) => !sources.has(entry[0])))
    yield* Effect.promise(() => ConfigHooks.writeTrust(next))
    process.stdout.write(`removed ${Object.keys(trust).length - Object.keys(next).length} trusted file(s)${EOL}`)
  }),
})

export const HooksCommand = cmd({
  command: "hooks",
  describe: "manage shell-command hooks from the config",
  builder: (yargs) => yargs.command(ListCommand).command(TrustCommand).command(UntrustCommand).demandCommand(),
  async handler() {},
})

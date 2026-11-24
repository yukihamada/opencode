import { EOL } from "os"
import path from "path"
import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { cmd } from "./cmd"

const load = Effect.fn("Cli.hooks.load")(function* () {
  const { Config } = yield* Effect.promise(() => import("@/config/config"))
  const { ConfigHooks } = yield* Effect.promise(() => import("@/config/hooks"))
  const { InstanceState } = yield* Effect.promise(() => import("@/effect/instance-state"))
  const ctx = yield* InstanceState.context
  const config = yield* Config.Service.use((cfg) => cfg.get())
  const trust = yield* Effect.promise(() => ConfigHooks.readTrust())
  const scope = ConfigHooks.scopeOf(ctx)
  const statuses = ConfigHooks.status(config.hook_origins ?? [], trust, scope)
  const describe = (item: (typeof statuses)[number]) => {
    const where =
      item.kind === "project" ? item.source : item.kind === "user" ? `user config: ${item.source}` : item.label
    const lines = [`${item.trusted ? "on " : "OFF"} ${where} (${item.reason})`]
    for (const hook of item.hooks)
      lines.push(`    ${hook.event}${hook.matcher ? ` [${hook.matcher}]` : ""}: ${hook.command}`)
    if (item.kind === "user") return lines.join(EOL)
    lines.push(
      item.files.length
        ? `    fingerprint covers: ${item.files.join(", ")}`
        : "    fingerprint covers: the commands only (no script file named in them)",
    )
    const unresolved = [...new Set(item.hooks.flatMap((hook) => ConfigHooks.unresolved(hook.command, scope)))]
    if (unresolved.length) lines.push(`    warning: not resolved to files, so not covered: ${unresolved.join(" ")}`)
    lines.push(
      "    note: files those scripts load in turn (sourced scripts, npm scripts, imports) are not covered; review them too.",
      "    trust is checked again right before each run; any change stops these hooks until trusted again.",
    )
    return lines.join(EOL)
  }
  return { ConfigHooks, ctx, trust, statuses, describe }
})

const ListCommand = effectCmd({
  command: "list",
  describe: "show configured hooks and whether they run",
  handler: Effect.fn("Cli.hooks.list")(function* () {
    const { statuses, describe } = yield* load()
    if (!statuses.length) {
      process.stdout.write("no hooks configured" + EOL)
      return
    }
    process.stdout.write(statuses.map((item) => describe(item)).join(EOL) + EOL)
  }),
})

const TrustCommand = effectCmd({
  command: "trust [file]",
  describe: "allow hooks from this project's config (or a remote config) to run, until they change",
  builder: (yargs) =>
    yargs
      .positional("file", { type: "string", describe: "only this config file (or remote URL)" })
      .option("yes", { alias: "y", type: "boolean", default: false, describe: "trust without asking" }),
  handler: Effect.fn("Cli.hooks.trust")(function* (args) {
    const { ConfigHooks, ctx, trust, statuses, describe } = yield* load()
    const wanted = args.file
      ? /^https?:\/\//.test(args.file)
        ? args.file
        : path.resolve(ctx.directory, args.file)
      : undefined
    const untrusted = statuses.filter((item) => !item.trusted && (!wanted || item.source === wanted))
    // A parent directory's config (picked up when there is no git repository) is not trusted from here.
    const outside = untrusted.filter((item) => item.kind === "project" && !ConfigHooks.inProject(item.source, ctx))
    for (const item of outside)
      process.stdout.write(
        `skipped ${item.source}: outside this project; run \`sente hooks trust\` in its directory${EOL}`,
      )
    const candidates = untrusted.filter((item) => !outside.includes(item))
    if (!candidates.length) {
      process.stdout.write(
        (wanted ? `no untrusted hooks in ${wanted}` : "nothing to trust: no untrusted project or remote hooks") + EOL,
      )
      return
    }
    if (!args.yes && !process.stdin.isTTY)
      return yield* fail(
        "refusing to trust hooks without a terminal to ask on; review `sente hooks list` and pass --yes",
      )
    const { confirm, isCancel } = yield* Effect.promise(() => import("@clack/prompts"))
    const chosen: typeof candidates = []
    for (const item of candidates) {
      process.stdout.write(describe(item) + EOL)
      if (args.yes) {
        chosen.push(item)
        continue
      }
      const answer = yield* Effect.promise(() =>
        confirm({
          message: `Trust and run these hooks${item.kind === "remote" ? " from a remote server" : ""}? They run with your permissions and environment.`,
          initialValue: false,
        }),
      )
      if (isCancel(answer)) return yield* fail("cancelled")
      if (answer === true) chosen.push(item)
    }
    if (!chosen.length) {
      process.stdout.write("nothing trusted" + EOL)
      return
    }
    yield* Effect.promise(() =>
      ConfigHooks.writeTrust({
        ...trust,
        ...Object.fromEntries(chosen.map((item) => [item.source, item.fingerprint])),
      }),
    )
    process.stdout.write(
      `trusted ${chosen.map((item) => item.source).join(", ")}${EOL}saved to ${ConfigHooks.trustFile()}${EOL}`,
    )
  }),
})

const UntrustCommand = effectCmd({
  command: "untrust [file]",
  describe: "stop running hooks from this project's config (or one file / remote URL)",
  builder: (yargs) => yargs.positional("file", { type: "string", describe: "only this config file (or remote URL)" }),
  handler: Effect.fn("Cli.hooks.untrust")(function* (args) {
    const { ConfigHooks, ctx, trust, statuses } = yield* load()
    const wanted = args.file
      ? /^https?:\/\//.test(args.file)
        ? args.file
        : path.resolve(ctx.directory, args.file)
      : undefined
    const sources = new Set(
      wanted ? [wanted] : statuses.filter((item) => item.kind !== "user").map((item) => item.source),
    )
    const next = Object.fromEntries(Object.entries(trust).filter((entry) => !sources.has(entry[0])))
    yield* Effect.promise(() => ConfigHooks.writeTrust(next))
    process.stdout.write(`removed ${Object.keys(trust).length - Object.keys(next).length} trusted source(s)${EOL}`)
  }),
})

export const HooksCommand = cmd({
  command: "hooks",
  describe: "manage shell-command hooks from the config",
  builder: (yargs) => {
    // Tells the plugin loader not to print its "hooks not run" warning on top of this command's own output.
    process.env.SENTE_HOOKS_COMMAND = "1"
    return yargs.command(ListCommand).command(TrustCommand).command(UntrustCommand).demandCommand()
  },
  async handler() {},
})

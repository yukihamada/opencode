import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import type { Argv, CommandModule } from "yargs"
import { UI } from "./cli/ui"
import { InstallationDev, InstallationVersion } from "@sente-ai/core/installation/version"
import { FormatError } from "./cli/error"
import { EOL } from "os"
import { errorMessage } from "./util/error"
import { Heap } from "./cli/heap"
// yargs always runs the default command's builder (even for --version or a bare --help)
// to assemble its own command/option list, so making this one lazy buys nothing and
// trips a yargs limitation where an async default-command builder leaves showHelp()'s
// internal `out` buffer empty. Keep it a static import; every other subcommand builder
// below stays lazy since yargs only invokes those when that specific command is selected.
import { TuiThreadCommand } from "./cli/cmd/tui"

const args = hideBin(process.argv)

function lazyCommand(
  command: string,
  describe: string | false | undefined,
  load: () => Promise<CommandModule>,
  aliases?: string[],
): CommandModule {
  return {
    command,
    describe,
    aliases,
    builder: async (yargs: Argv) => {
      const definition = await load()
      if (typeof definition.builder !== "function") return yargs
      return definition.builder(yargs)
    },
    handler: async (args) => {
      const definition = await load()
      await definition.handler?.(args as never)
    },
  }
}

const commands = [
  lazyCommand("acp", "start ACP (Agent Client Protocol) server", async () => (await import("./cli/cmd/acp")).AcpCommand as CommandModule),
  lazyCommand("mcp", "manage MCP (Model Context Protocol) servers", async () => (await import("./cli/cmd/mcp")).McpCommand as CommandModule),
  TuiThreadCommand as CommandModule,
  lazyCommand("attach <url>", "attach to a running sente server", async () => (await import("./cli/cmd/attach")).AttachCommand as CommandModule),
  lazyCommand("run [message..]", "run sente with a message", async () => (await import("./cli/cmd/run")).RunCommand as CommandModule),
  lazyCommand("generate", undefined, async () => (await import("./cli/cmd/generate")).GenerateCommand as CommandModule),
  lazyCommand("debug", "debugging and troubleshooting tools", async () => (await import("./cli/cmd/debug")).DebugCommand as CommandModule),
  lazyCommand("console", false, async () => (await import("./cli/cmd/account")).ConsoleCommand as CommandModule),
  lazyCommand("providers", "manage AI providers and credentials", async () => (await import("./cli/cmd/providers")).ProvidersCommand as CommandModule, ["auth"]),
  lazyCommand("agent", "manage agents", async () => (await import("./cli/cmd/agent")).AgentCommand as CommandModule),
  lazyCommand("upgrade [target]", "upgrade sente to the latest or a specific version", async () => (await import("./cli/cmd/upgrade")).UpgradeCommand as CommandModule),
  lazyCommand(
    "uninstall",
    "uninstall sente and remove all related files",
    async () => (await import("./cli/cmd/uninstall")).UninstallCommand as unknown as CommandModule,
  ),
  lazyCommand("serve", "starts a headless sente server", async () => (await import("./cli/cmd/serve")).ServeCommand as CommandModule),
  lazyCommand("web", "start sente server and open web interface", async () => (await import("./cli/cmd/web")).WebCommand as CommandModule),
  lazyCommand("models [provider]", "list all available models", async () => (await import("./cli/cmd/models")).ModelsCommand as CommandModule),
  lazyCommand("stats", "show token usage and cost statistics", async () => (await import("./cli/cmd/stats")).StatsCommand as CommandModule),
  lazyCommand("export [sessionID]", "export session data as JSON", async () => (await import("./cli/cmd/export")).ExportCommand as CommandModule),
  lazyCommand("import <file>", "import session data from JSON file or URL", async () => (await import("./cli/cmd/import")).ImportCommand as CommandModule),
  lazyCommand("github", "manage GitHub agent", async () => (await import("./cli/cmd/github")).GithubCommand as CommandModule),
  lazyCommand("pr <number>", "fetch and checkout a GitHub PR branch, then run sente", async () => (await import("./cli/cmd/pr")).PrCommand as CommandModule),
  lazyCommand("session", "manage sessions", async () => (await import("./cli/cmd/session")).SessionCommand as CommandModule),
  lazyCommand("plugin <module>", "install plugin and update config", async () => (await import("./cli/cmd/plug")).PluginCommand as CommandModule, ["plug"]),
  lazyCommand("db", "database tools", async () => (await import("./cli/cmd/db")).DbCommand as CommandModule),
]

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("sente ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

// Developer builds only: refuse to apply new migrations to a database that already holds
// conversations (see @sente-ai/core/database/guard). Release builds return immediately.
// Runs before any command opens the database, so the TUI never starts on a blocked build.
async function guardDatabase(json: boolean) {
  if (!InstallationDev) return
  if (args[0] === "db" && args[1] === "path") return
  const { Database } = await import("@sente-ai/core/database/database")
  const { DatabaseGuard } = await import("@sente-ai/core/database/guard")
  const { DatabaseSibling } = await import("@sente-ai/core/database/sibling")
  const { ExitCode } = await import("./cli/exit-code")
  const blocked = await DatabaseGuard.startup(Database.path()).catch((error) => {
    // Cannot tell what would be applied, so a developer build does not guess.
    UI.error(
      `could not check pending migrations for ${Database.path()}: ${errorMessage(error)}${EOL}` +
        `Start anyway with ${DatabaseGuard.ALLOW}=1, or use another database with SENTE_DB=<other>.db`,
    )
    return process.exit(ExitCode.User)
  })
  if (!blocked) return
  const message = DatabaseGuard.message(blocked, DatabaseSibling.japanese())
  if (json)
    process.stderr.write(
      JSON.stringify({
        type: "error",
        level: "fatal",
        timestamp: Date.now(),
        exitCode: ExitCode.User,
        code: "database_migration_blocked",
        message,
        database: blocked.database,
        sessions: blocked.sessions,
        migrations: blocked.migrations,
        allow: `${DatabaseGuard.ALLOW}=1`,
      }) + EOL,
    )
  else UI.error(message)
  process.exit(ExitCode.User)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("sente")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    const { loadCredentials } = await import("@sente-ai/tui/util/teai")
    // Before loadCredentials fills the env: remember whether the key was an explicit override.
    const { ProviderKeyReload } = await import("@/provider/key-reload")
    await ProviderKeyReload.markSource()
    await loadCredentials()
    if (opts.printLogs) process.env.SENTE_PRINT_LOGS = "1"
    if (opts.logLevel) process.env.SENTE_LOG_LEVEL = opts.logLevel
    if (opts.pure) {
      process.env.SENTE_PURE = "1"
    }

    await guardDatabase(opts.format === "json")

    Heap.start()

    process.env.AGENT = "1"
    process.env.SENTE = "1"
    process.env.SENTE_PID = String(process.pid)
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(commands)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}

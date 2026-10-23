import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { UI } from "./cli/ui"
import { InstallationVersion } from "@sente-ai/core/installation/version"
import { FormatError } from "./cli/error"
import { EOL } from "os"
import { errorMessage } from "./util/error"
import { Heap } from "./cli/heap"

const args = hideBin(process.argv)

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("sente ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
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
    if (opts.printLogs) process.env.SENTE_PRINT_LOGS = "1"
    if (opts.logLevel) process.env.SENTE_LOG_LEVEL = opts.logLevel
    if (opts.pure) {
      process.env.SENTE_PURE = "1"
    }

    Heap.start()

    process.env.AGENT = "1"
    process.env.SENTE = "1"
    process.env.SENTE_PID = String(process.pid)
  })
  .usage("")
  .completion("completion", "generate shell completion script")

// Register commands lazily so `--version` and `--help` don't pay the import
// cost of every command module. yargs only invokes a command's builder when
// the command is actually used, but static imports are evaluated eagerly.
const wantsHelp = args.includes("-h") || args.includes("--help")
const wantsVersion = args.includes("-v") || args.includes("--version")
const wantsCompletion = args[0] === "completion"

if (!wantsVersion && !wantsCompletion) {
  const [
    { AcpCommand },
    { McpCommand },
    { TuiThreadCommand },
    { AttachCommand },
    { RunCommand },
    { GenerateCommand },
    { DebugCommand },
    { ConsoleCommand },
    { ProvidersCommand },
    { AgentCommand },
    { UpgradeCommand },
    { UninstallCommand },
    { ServeCommand },
    { WebCommand },
    { ModelsCommand },
    { StatsCommand },
    { ExportCommand },
    { ImportCommand },
    { GithubCommand },
    { PrCommand },
    { SessionCommand },
    { PluginCommand },
    { DbCommand },
  ] = await Promise.all([
    import("./cli/cmd/acp"),
    import("./cli/cmd/mcp"),
    import("./cli/cmd/tui"),
    import("./cli/cmd/attach"),
    import("./cli/cmd/run"),
    import("./cli/cmd/generate"),
    import("./cli/cmd/debug"),
    import("./cli/cmd/account"),
    import("./cli/cmd/providers"),
    import("./cli/cmd/agent"),
    import("./cli/cmd/upgrade"),
    import("./cli/cmd/uninstall"),
    import("./cli/cmd/serve"),
    import("./cli/cmd/web"),
    import("./cli/cmd/models"),
    import("./cli/cmd/stats"),
    import("./cli/cmd/export"),
    import("./cli/cmd/import"),
    import("./cli/cmd/github"),
    import("./cli/cmd/pr"),
    import("./cli/cmd/session"),
    import("./cli/cmd/plug"),
    import("./cli/cmd/db"),
  ])
  cli
    .command(AcpCommand)
    .command(McpCommand)
    .command(TuiThreadCommand)
    .command(AttachCommand)
    .command(RunCommand)
    .command(GenerateCommand)
    .command(DebugCommand)
    .command(ConsoleCommand)
    .command(ProvidersCommand)
    .command(AgentCommand)
    .command(UpgradeCommand)
    .command(UninstallCommand)
    .command(ServeCommand)
    .command(WebCommand)
    .command(ModelsCommand)
    .command(StatsCommand)
    .command(ExportCommand)
    .command(ImportCommand)
    .command(GithubCommand)
    .command(PrCommand)
    .command(SessionCommand)
    .command(PluginCommand)
    .command(DbCommand)
}

cli
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
  if (wantsHelp) {
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

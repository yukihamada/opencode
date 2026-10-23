import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { UI } from "./cli/ui"
import { InstallationDev, InstallationVersion } from "@sente-ai/core/installation/version"
import { FormatError } from "./cli/error"
import { EOL } from "os"
import { errorMessage } from "./util/error"
import { Heap } from "./cli/heap"
import { CliCommands } from "./cli/commands"

const args = hideBin(process.argv)
// 対話画面だけで起動する時は、他のコマンド(run/serve 等)のモジュールを画面側で読み込まない。
// 画面側の実行環境にサーバー一式の読み込みが二重に乗るのを避ける(サーバーは worker 側で読み込む)。
const commands = await CliCommands.load(args)

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

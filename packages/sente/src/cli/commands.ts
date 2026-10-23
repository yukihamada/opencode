import type { CommandModule } from "yargs"

/**
 * Top-level command names and aliases other than the default `$0` (the TUI).
 * `test/cli/commands.test.ts` checks this list against every registered command.
 */
export const NAMES = new Set([
  "acp",
  "mcp",
  "attach",
  "run",
  "generate",
  "debug",
  "console",
  "providers",
  "auth",
  "agent",
  "upgrade",
  "uninstall",
  "serve",
  "web",
  "models",
  "stats",
  "export",
  "import",
  "github",
  "pr",
  "session",
  "plugin",
  "plug",
  "db",
  "completion",
  "help",
])

const FULL_FLAGS = new Set(["-h", "--help", "-v", "--version", "--get-yargs-completions"])

/**
 * True when the arguments can only mean the default TUI command. Any argument that names a
 * command (even as an option value) falls back to loading every command, which is the old behavior.
 */
export function tuiOnly(args: readonly string[]) {
  for (const arg of args) {
    if (arg === "--") break
    if (FULL_FLAGS.has(arg) || NAMES.has(arg)) return false
  }
  return true
}

export async function all(): Promise<CommandModule<any, any>[]> {
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
    import("./cmd/acp"),
    import("./cmd/mcp"),
    import("./cmd/tui"),
    import("./cmd/attach"),
    import("./cmd/run"),
    import("./cmd/generate"),
    import("./cmd/debug"),
    import("./cmd/account"),
    import("./cmd/providers"),
    import("./cmd/agent"),
    import("./cmd/upgrade"),
    import("./cmd/uninstall"),
    import("./cmd/serve"),
    import("./cmd/web"),
    import("./cmd/models"),
    import("./cmd/stats"),
    import("./cmd/export"),
    import("./cmd/import"),
    import("./cmd/github"),
    import("./cmd/pr"),
    import("./cmd/session"),
    import("./cmd/plug"),
    import("./cmd/db"),
  ])
  return [
    AcpCommand,
    McpCommand,
    TuiThreadCommand,
    AttachCommand,
    RunCommand,
    GenerateCommand,
    DebugCommand,
    ConsoleCommand,
    ProvidersCommand,
    AgentCommand,
    UpgradeCommand,
    UninstallCommand,
    ServeCommand,
    WebCommand,
    ModelsCommand,
    StatsCommand,
    ExportCommand,
    ImportCommand,
    GithubCommand,
    PrCommand,
    SessionCommand,
    PluginCommand,
    DbCommand,
  ] as CommandModule<any, any>[]
}

export async function load(args: readonly string[]) {
  if (process.env.SENTE_EAGER_COMMANDS === "1" || !tuiOnly(args)) return all()
  const { TuiThreadCommand } = await import("./cmd/tui")
  return [TuiThreadCommand] as CommandModule<any, any>[]
}

export * as CliCommands from "./commands"

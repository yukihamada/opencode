import { describe, expect, test } from "bun:test"
import { CliCommands } from "../../src/cli/commands"

function names(command: { command?: string | readonly string[]; aliases?: string | readonly string[] }) {
  const list = [command.command ?? [], command.aliases ?? []].flat()
  return list.map((item) => item.split(" ")[0]!).filter((item) => item !== "$0")
}

describe("CliCommands", () => {
  test("NAMES covers every registered top-level command and alias", async () => {
    const all = await CliCommands.all()
    const registered = all.flatMap((command) => names(command as never))
    for (const name of registered) expect(CliCommands.NAMES.has(name)).toBe(true)
    expect(all.length).toBe(23)
  })

  test("only the plain TUI invocation skips the other commands", () => {
    expect(CliCommands.tuiOnly([])).toBe(true)
    expect(CliCommands.tuiOnly(["some/project"])).toBe(true)
    expect(CliCommands.tuiOnly(["-m", "teai/auto", "--prompt", "hello"])).toBe(true)
    expect(CliCommands.tuiOnly(["run", "hi"])).toBe(false)
    expect(CliCommands.tuiOnly(["--log-level", "DEBUG", "serve"])).toBe(false)
    expect(CliCommands.tuiOnly(["--help"])).toBe(false)
    expect(CliCommands.tuiOnly(["-v"])).toBe(false)
    expect(CliCommands.tuiOnly(["--prompt", "run"])).toBe(false)
    expect(CliCommands.tuiOnly(["--", "run"])).toBe(true)
  })

  test("the TUI-only path registers just the default command", async () => {
    const commands = await CliCommands.load(["some/project"])
    expect(commands.map((command) => command.command)).toEqual(["$0 [project]"])
  })
})

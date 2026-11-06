import { describe, expect, test } from "bun:test"
import { Readable } from "node:stream"
import { INTERACTIVE_INPUT_ERROR, readRunStdin, resolveInteractiveStdin } from "@/cli/cmd/run/runtime.stdin"

function stream(isTTY: boolean) {
  return Object.assign(new Readable({ read() {} }), { isTTY }) as NodeJS.ReadStream
}

describe("run interactive stdin", () => {
  test("reuses stdin when it is already a tty", () => {
    const stdin = stream(true)
    const seen: string[] = []
    const result = resolveInteractiveStdin(
      stdin,
      (path) => {
        seen.push(path)
        return stream(true)
      },
      "linux",
    )

    expect(result.stdin).toBe(stdin)
    expect(result.cleanup).toBeUndefined()
    expect(seen).toEqual([])
  })

  test("opens the controlling terminal when stdin is piped", () => {
    const tty = stream(true)
    const seen: string[] = []
    const result = resolveInteractiveStdin(
      stream(false),
      (path) => {
        seen.push(path)
        return tty
      },
      "linux",
    )

    expect(result.stdin).toBe(tty)
    expect(seen).toEqual(["/dev/tty"])

    result.cleanup?.()
    expect(tty.destroyed).toBe(true)
  })

  test("uses CONIN$ on windows", () => {
    const seen: string[] = []
    resolveInteractiveStdin(
      stream(false),
      (path) => {
        seen.push(path)
        return stream(true)
      },
      "win32",
    )

    expect(seen).toEqual(["CONIN$"])
  })

  test("throws a clear error when no controlling terminal is available", () => {
    expect(() =>
      resolveInteractiveStdin(
        stream(false),
        () => {
          throw new Error("open failed")
        },
        "linux",
      ),
    ).toThrow(INTERACTIVE_INPUT_ERROR)
  })
})

describe("run piped stdin", () => {
  const socket = () => ({ isFIFO: () => false, isFile: () => false })
  const fifo = () => ({ isFIFO: () => true, isFile: () => false })
  const never = () => new Promise<string>(() => {})

  test("does not wait forever on an idle socket when a message is given", async () => {
    const started = Date.now()
    const result = await readRunStdin({ hasMessage: true, stdin: stream(false), stat: socket, readAll: never, graceMs: 50 })
    expect(result).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test("still reads data that arrives on a socket", async () => {
    const stdin = stream(false)
    setTimeout(() => {
      stdin.push("piped text")
      stdin.push(null)
    }, 10)
    expect(await readRunStdin({ hasMessage: true, stdin, stat: socket, readAll: never, graceMs: 50 })).toBe("piped text")
  })

  test("keeps reading a pipe to the end when a message is given", async () => {
    expect(await readRunStdin({ hasMessage: true, stdin: stream(false), stat: fifo, readAll: async () => "from pipe" })).toBe(
      "from pipe",
    )
  })

  test("reads stdin when no message is given", async () => {
    expect(await readRunStdin({ hasMessage: false, stdin: stream(false), stat: socket, readAll: async () => "only stdin" })).toBe(
      "only stdin",
    )
  })

  test("ignores stdin on a tty", async () => {
    expect(await readRunStdin({ hasMessage: false, stdin: stream(true), readAll: never })).toBeUndefined()
  })
})

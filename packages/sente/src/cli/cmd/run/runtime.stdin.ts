import fs from "fs"
import * as tty from "node:tty"

export const INTERACTIVE_INPUT_ERROR = "--mini requires a controlling terminal for input"

type InteractiveStdin = {
  stdin: NodeJS.ReadStream
  cleanup?: () => void
}

function openTerminalStdin(path: string): NodeJS.ReadStream {
  return new tty.ReadStream(fs.openSync(path, "r"))
}

export function resolveInteractiveStdin(
  stdin: NodeJS.ReadStream = process.stdin,
  open: (path: string) => NodeJS.ReadStream = openTerminalStdin,
  platform = process.platform,
): InteractiveStdin {
  if (stdin.isTTY) {
    return { stdin }
  }

  const file = platform === "win32" ? "CONIN$" : "/dev/tty"

  try {
    const stream = open(file)
    return {
      stdin: stream,
      cleanup: () => {
        stream.destroy()
      },
    }
  } catch (error) {
    throw new Error(INTERACTIVE_INPUT_ERROR, { cause: error })
  }
}

type RunStdin = Pick<NodeJS.ReadStream, "isTTY" | "on" | "off" | "pause" | "resume">

type ReadRunStdinOptions = {
  hasMessage: boolean
  stdin?: RunStdin
  stat?: () => Pick<fs.Stats, "isFIFO" | "isFile">
  readAll?: () => Promise<string>
  graceMs?: number
}

// `sente run "依頼"` を呼び出し元が閉じない標準入力(ソケット等)つきで起動すると、
// EOF を待って永久に止まっていた。依頼が引数にあり、標準入力がパイプでもファイルでもない時は、
// 短い猶予内にデータが来た場合だけ読み、来なければ読まずに進む。
export async function readRunStdin(options: ReadRunStdinOptions): Promise<string | undefined> {
  const stdin = options.stdin ?? process.stdin
  const readAll = options.readAll ?? (() => Bun.stdin.text())
  if (stdin.isTTY) return undefined
  if (!options.hasMessage) return readAll()

  let stat: Pick<fs.Stats, "isFIFO" | "isFile">
  try {
    stat = (options.stat ?? (() => fs.fstatSync(0)))()
  } catch {
    return readAll()
  }
  if (stat.isFIFO() || stat.isFile()) return readAll()

  const graceMs = options.graceMs ?? 300
  return new Promise<string | undefined>((resolve) => {
    const chunks: Buffer[] = []
    let done = false
    const finish = (value: string | undefined) => {
      if (done) return
      done = true
      clearTimeout(timer)
      stdin.off("data", onData)
      stdin.off("end", onEnd)
      stdin.off("error", onError)
      stdin.pause()
      resolve(value)
    }
    const onData = (chunk: Buffer | string) => {
      clearTimeout(timer)
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
    }
    const onEnd = () => finish(chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined)
    const onError = () => finish(chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined)
    const timer = setTimeout(() => {
      if (chunks.length === 0) finish(undefined)
    }, graceMs)
    stdin.on("data", onData)
    stdin.on("end", onEnd)
    stdin.on("error", onError)
    stdin.resume()
  })
}

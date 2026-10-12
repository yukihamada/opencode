/// <reference path="./swift.d.ts" />
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtemp, rm, mkdir, rename } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { createInterface } from "node:readline"
import source from "./voice-capture.swift" with { type: "text" }
import type { HoldRecording } from "./space-hold"

let prepared: Promise<string> | undefined
let blockedUntil = 0
async function captureBinary() {
  if (process.platform !== "darwin") throw new Error("Hold-to-talk currently requires macOS")
  if (prepared) return prepared
  prepared = (async () => {
    const hash = createHash("sha256").update(source).digest("hex").slice(0, 16)
    const directory = path.join(homedir(), ".cache", "sente", "voice-hold")
    const binary = path.join(directory, `capture-${process.arch}-${hash}`)
    if (await Bun.file(binary).exists()) return binary
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const scratch = await mkdtemp(path.join(directory, "build-"))
    try {
      const file = path.join(scratch, "capture.swift")
      await Bun.write(file, source)
      await run("swiftc", ["-O", file, "-o", path.join(scratch, "capture")])
      await rename(path.join(scratch, "capture"), binary)
      return binary
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })()
  try { return await prepared }
  catch (error) { prepared = undefined; throw error }
}

function run(command: string, args: string[], signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", signal, timeout: 60_000 })
    child.once("error", reject)
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)))
  })
}

export function usableTranscript(value: unknown): string {
  if (typeof value !== "string") throw new Error("STT returned invalid text")
  const text = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").trim()
  const normalized = text.replace(/[\s。、.!！?？]/g, "").toLowerCase()
  if (!normalized || /^(ご視聴ありがとうございました|ご清聴ありがとうございました|チャンネル登録お願いします|ご視聴ありがとうございます|thankyouforwatching|thanksforwatching)$/.test(normalized)) return ""
  return text
}

export function startHoldRecording(options: {
  ready(): void
  level(value: number): void
  language: string
  // Process/network seams permit tests without microphone access or uploads.
  capture?: () => Promise<string[]>
  convert?: (input: string, output: string, signal: AbortSignal) => Promise<void>
  request?: (url: string, init: RequestInit) => Promise<Response>
}): HoldRecording {
  if (Date.now() < blockedUntil) throw new Error("STT rate limited; wait for the server cooldown (unknown duration requires checking the service)")
  const abort = new AbortController()
  let released = false
  let child: ChildProcessWithoutNullStreams | undefined
  let kill: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    child.stdin.end()
    kill ??= setTimeout(() => child?.kill("SIGKILL"), 2000)
  }
  const result = (async () => {
    const command = await (options.capture?.() ?? captureBinary().then((file) => [file]))
    if (released || abort.signal.aborted) return ""
    const directory = await mkdtemp(path.join(tmpdir(), "sente-hold-"))
    try {
      if (released || abort.signal.aborted) return ""
      const audio = path.join(directory, "input.wav")
      const converted = path.join(directory, "input.16k.wav")
      child = spawn(command[0], [...command.slice(1), audio], { stdio: "pipe" })
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") abort.abort(error)
      })
      child.stderr.resume()
      let segment: { duration: number; peak: number } | undefined
      let failure: Error | undefined
      const lines = createInterface({ input: child.stdout })
      lines.on("line", (line) => {
        try {
          const event = JSON.parse(line)
          if (event.type === "ready" && !released && !abort.signal.aborted) options.ready()
          if (event.type === "level" && Number.isFinite(event.value) && !released && !abort.signal.aborted) options.level(event.value)
          if (event.type === "segment" && Number.isFinite(event.duration) && Number.isFinite(event.peak)) segment = event
          if (event.type === "error") throw new Error(String(event.message))
        } catch (error) {
          failure = error instanceof Error ? error : new Error("Invalid capture event")
          stop()
        }
      })
      const code = await new Promise<number | null>((resolve, reject) => {
        child!.once("error", reject)
        child!.once("close", resolve)
      })
      clearTimeout(kill)
      lines.close()
      if (abort.signal.aborted) return ""
      if (failure) throw failure
      if (code !== 0) throw new Error("Microphone capture failed")
      if (!released) throw new Error("Microphone stopped before key release")
      if (!segment) throw new Error("Microphone did not finalize audio")
      if (segment.duration < 0.6 || segment.peak <= -35) return ""
      await (options.convert ?? ((input, output, signal) => run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-ac", "1", "-ar", "16000", output], signal)))(audio, converted, abort.signal)
      abort.signal.throwIfAborted()
      const lang = options.language.startsWith("en") ? "en" : "ja"
      const response = await (options.request ?? fetch)(`https://koe.live/api/stt?lang=${lang}`, {
        method: "POST", headers: { "Content-Type": "audio/wav" },
        body: await Bun.file(converted).arrayBuffer(),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]),
      })
      // No retries. Subsequent holds must also respect the service cooldown.
      if (response.status === 429) {
        const retry = response.headers.get("retry-after")
        const until = retry && /^\d+(\.\d+)?$/.test(retry)
          ? Date.now() + Number(retry) * 1000
          : retry ? Date.parse(retry) : NaN
        blockedUntil = Number.isFinite(until) ? Math.max(Date.now(), until) : Infinity
      }
      if (!response.ok) throw new Error(`STT HTTP ${response.status}`)
      const result = await response.json()
      if (!result.ok) throw new Error("STT rejected audio")
      abort.signal.throwIfAborted()
      return usableTranscript(result.text)
    } finally {
      clearTimeout(kill)
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await rm(directory, { recursive: true, force: true })
    }
  })()
  // Retain early failures until release without an unhandled rejection.
  const settled = result.then((text) => ({ text, error: undefined }), (error: unknown) => ({ text: "", error }))
  return {
    async finish() {
      released = true
      stop()
      const outcome = await settled
      if (outcome.error) throw outcome.error
      return outcome.text
    },
    cancel() {
      released = true
      abort.abort()
      stop()
    },
  }
}

import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, readFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

export type RecordingState = "idle" | "recording" | "transcribing"

export interface RecordingResult {
  text: string
  durationSec: number
}

function platformRecorder(outputPath: string): [string, string[]] {
  const platform = process.platform
  if (platform === "darwin") {
    return ["ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", ":default", "-ac", "1", "-ar", "16000", "-y", outputPath]]
  }
  if (platform === "linux") {
    return ["ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "alsa", "-i", "default", "-ac", "1", "-ar", "16000", "-y", outputPath]]
  }
  return ["rec", ["-q", "-c", "1", "-r", "16000", outputPath]]
}

export class VoiceRecorder {
  private proc: ChildProcess | null = null
  private outputPath: string | null = null
  private tmpDir: string | null = null

  get isRecording() {
    return this.proc !== null && this.proc.exitCode === null
  }

  async start() {
    if (this.proc) return
    this.tmpDir = await mkdtemp(path.join(tmpdir(), "sente-voice-"))
    this.outputPath = path.join(this.tmpDir, "rec.wav")
    const [cmd, args] = platformRecorder(this.outputPath)
    this.proc = spawn(cmd, args, { stdio: "ignore" })
    this.proc.on("error", () => {
      this.proc = null
    })
  }

  async stop(): Promise<RecordingResult | null> {
    const proc = this.proc
    const outputPath = this.outputPath
    if (!proc || !outputPath) return null
    this.proc = null
    this.outputPath = null

    await new Promise<void>((resolve) => {
      proc.once("exit", () => resolve())
      proc.kill("SIGINT")
    })

    try {
      const wav = await readFile(outputPath)
      if (wav.length < 1000) return null

      const text = await transcribe(wav)
      if (!text || text.length < 2) return null

      return { text, durationSec: wav.length / 32000 }
    } catch {
      return null
    } finally {
      if (this.tmpDir) {
        unlink(outputPath).catch(() => {})
      }
    }
  }

  async cancel() {
    const proc = this.proc
    this.proc = null
    this.outputPath = null
    if (proc) {
      proc.kill("SIGKILL")
      await new Promise<void>((resolve) => proc.once("exit", () => resolve()))
    }
  }
}

async function transcribe(wav: Buffer): Promise<string | null> {
  const sttBase = process.env.KOE_BASE || "https://koe.live"
  const lang = process.env.KOE_STT_LANG || "ja"
  const url = `${sttBase}/api/stt?lang=${lang}`
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: new Uint8Array(wav),
      signal: AbortSignal.timeout(30000),
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as { text?: string }
    return data.text?.trim() || null
  } catch {
    return null
  }
}

let recorder: VoiceRecorder | null = null

export function getRecorder() {
  if (!recorder) recorder = new VoiceRecorder()
  return recorder
}

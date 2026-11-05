import { spawn as nodeSpawn, spawnSync, type ChildProcess } from "node:child_process"
import path from "node:path"

// 音声入力(話した言葉を入力欄に入れる機能)。録音・無音検出・文字起こしを TUI の
// 中だけで行い、サーバーのセッションやモデルには何も送らない(送信は本人の Enter か
// 自動送信の設定だけ)。マイクは手元の端末のものを使う。

export type VoiceMode = "hold" | "tap"
export type VoiceSettings = { enabled: boolean; mode: VoiceMode; autoSubmit: boolean; language?: string }

export const MAX_RECORDING_MS = 120_000
export const SILENCE_STOP_MS = 15_000
const SAMPLE_RATE = 16_000
// この音量(dBFS)を超えた音が合計 VOICED_MS 以上あれば「声がある」とみなす。
// 実測(MacBook Pro 内蔵マイク): 静かな部屋は中央値 -62dB・最大 -49dB、スピーカー越しの声は上位10%で -37dB。
const SPEECH_DB = -45
const VOICED_MS = 150
const STT_URL = "https://koe.live/api/stt"
// 文字起こし側は1回3MBまで。16kHz・16bit なら約98秒なので、85秒を超えたら静かな所で分けて送る。
const CHUNK_MAX_MS = 85_000
const CHUNK_MIN_MS = 55_000

export type VoiceCommand =
  | { type: "start" }
  | { type: "status" }
  | { type: "stop" }
  | { type: "set"; settings: Partial<VoiceSettings> }
  | { type: "invalid"; value: string }

/// `/v`・`/v hold`・`/v tap`・`/v on`・`/v off`・`/v stop`・`/v auto on|off`・`/v status`。
/// `/v` 以外(例: `/voice`)は undefined。
export function parseVoiceCommand(input: string): VoiceCommand | undefined {
  const match = /^\/v(?:\s+(.*))?$/s.exec(input.trim())
  if (!match) return undefined
  const arg = (match[1] ?? "").trim().toLowerCase().replace(/\s+/g, " ")
  if (!arg || arg === "start" || arg === "開始") return { type: "start" }
  if (arg === "status" || arg === "状態") return { type: "status" }
  if (arg === "stop" || arg === "停止" || arg === "cancel") return { type: "stop" }
  if (arg === "on" || arg === "enable") return { type: "set", settings: { enabled: true } }
  if (arg === "off" || arg === "disable") return { type: "set", settings: { enabled: false } }
  if (arg === "hold" || arg === "長押し") return { type: "set", settings: { enabled: true, mode: "hold" } }
  if (arg === "tap" || arg === "タップ") return { type: "set", settings: { enabled: true, mode: "tap" } }
  if (arg === "auto" || arg === "auto on" || arg === "自動送信") return { type: "set", settings: { autoSubmit: true } }
  if (arg === "auto off" || arg === "manual") return { type: "set", settings: { autoSubmit: false } }
  return { type: "invalid", value: match[1]!.trim() }
}

/// 自動送信してよい長さか。英語などは3語以上、日本語・中国語・タイ語など語を空白で
/// 区切らない言語は文字があれば送る(Claude Code と同じ基準)。
export function longEnoughToSubmit(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Hangul}]/u.test(trimmed))
    return true
  return trimmed.split(/\s+/).filter(Boolean).length >= 3
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}ー、。「」！？]/u

/// 前の文に続けて入れる時の区切り。日本語など空白で区切らない言語の前後には空白を入れない。
export function joinTranscript(before: string, text: string) {
  if (!before || /\s$/.test(before)) return text
  if (CJK.test(before.slice(-1)) || CJK.test(text.slice(0, 1))) return text
  return " " + text
}

/// 無音や雑音から生まれやすい定型の幻聴を捨てる(従来の /v と同じ判定)。
export function usableTranscript(text: unknown): text is string {
  if (typeof text !== "string") return false
  const normalized = text.trim().replace(/[\s。、.!！?？]/g, "").toLowerCase()
  if (!normalized || !/[\p{L}]/u.test(text)) return false
  return !/^(ご視聴ありがとうございました|ご清聴ありがとうございました|チャンネル登録お願いします|ご視聴ありがとうございます|thankyouforwatching|thanksforwatching|どうぞお話しください|pleasegoahead)$/.test(
    normalized,
  )
}

// 開発でよく出る語。プロジェクト名とブランチ名と合わせて文字起こしの語彙ヒントにする。
const CODING_TERMS = ["Sente", "teai", "KOE", "GitHub", "PR", "commit", "deploy", "API", "JSON", "OAuth", "regex", "localhost", "TypeScript"]

/// 語彙ヒント(最大200文字)。記号は文字起こし側で弾かれることがあるので語に分ける。
export function buildLexicon(input: { directory?: string; branch?: string }) {
  const words: string[] = []
  const add = (value?: string) => {
    for (const word of (value ?? "").split(/[^\p{L}\p{N}]+/u)) {
      if (word.length < 2 || /^\d+$/.test(word)) continue
      if (!words.some((item) => item.toLowerCase() === word.toLowerCase())) words.push(word)
    }
  }
  add(input.directory ? path.basename(input.directory) : undefined)
  add(input.branch)
  for (const term of CODING_TERMS) add(term)
  let out = ""
  for (const word of words) {
    const next = out ? `${out},${word}` : word
    if (next.length > 200) break
    out = next
  }
  return out
}

// 文字起こしが対応する20言語(Claude Code と同じ)。言語名でも BCP 47 でも指定できる。
const LANGUAGES: Record<string, string[]> = {
  cs: ["czech", "čeština"], da: ["danish", "dansk"], nl: ["dutch", "nederlands"], en: ["english"],
  fr: ["french", "français"], de: ["german", "deutsch"], el: ["greek"], hi: ["hindi"],
  id: ["indonesian"], it: ["italian", "italiano"], ja: ["japanese", "日本語"], ko: ["korean", "한국어"],
  no: ["norwegian", "nb", "nn"], pl: ["polish", "polski"], pt: ["portuguese", "português"],
  ru: ["russian"], es: ["spanish", "español"], sv: ["swedish", "svenska"], tr: ["turkish", "türkçe"],
  uk: ["ukrainian"],
}

/// 設定の言語(未設定なら画面の言語)を文字起こし用の2文字コードにする。対応外は undefined。
export function sttLanguage(value: string | undefined) {
  const raw = (value ?? "").trim().toLowerCase()
  if (!raw) return undefined
  const code = raw.split(/[-_]/)[0]!
  if (LANGUAGES[code]) return code
  return Object.entries(LANGUAGES).find(([, names]) => names.includes(raw))?.[0]
}

export type Recorder = { command: string; args: string[]; name: string }

/// 使える録音プログラムを選ぶ。どれも 16kHz・モノラル・16bit の生データを標準出力に流す。
export function findRecorder(
  platform: NodeJS.Platform = process.platform,
  which: (name: string) => boolean = commandExists,
): Recorder | undefined {
  const raw = ["-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-"]
  const ffmpeg = ["-hide_banner", "-loglevel", "error", "-nostdin"]
  const sox: Recorder = {
    name: "sox",
    command: "rec",
    args: ["-q", "-t", "raw", "-r", String(SAMPLE_RATE), "-c", "1", "-b", "16", "-e", "signed-integer", "-"],
  }
  if (platform === "darwin") {
    if (which("ffmpeg")) return { name: "ffmpeg", command: "ffmpeg", args: [...ffmpeg, "-f", "avfoundation", "-i", ":default", ...raw] }
    if (which("rec")) return sox
    return undefined
  }
  if (platform === "linux") {
    if (which("arecord"))
      return { name: "arecord", command: "arecord", args: ["-q", "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1", "-t", "raw"] }
    if (which("rec")) return sox
    if (which("ffmpeg")) return { name: "ffmpeg", command: "ffmpeg", args: [...ffmpeg, "-f", "pulse", "-i", "default", ...raw] }
  }
  return undefined
}

function commandExists(name: string) {
  try {
    return spawnSync("/bin/sh", ["-c", `command -v ${name}`], { stdio: "ignore", timeout: 2000 }).status === 0
  } catch {
    return false
  }
}

/// 録音できない理由(SSH・未対応OS・録音プログラムなし)。録音できるなら undefined。
export function unavailableReason(
  english: boolean,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  given?: Recorder | null,
) {
  const recorder = given === undefined ? backend.findRecorder(platform) : (given ?? undefined)
  const text = (ja: string, en: string) => (english ? en : ja)
  if ((env.SSH_CONNECTION || env.SSH_TTY) && env.SENTE_VOICE_LOCAL !== "1")
    return text(
      "SSH 越しでは音声入力を使えません(マイクは手元の端末にあります)。SSH でないのに出る時は SENTE_VOICE_LOCAL=1 を設定してください",
      "Voice input is not available over SSH (the microphone is on your local machine). If this is not SSH, set SENTE_VOICE_LOCAL=1",
    )
  if (platform === "darwin" && !recorder)
    return text("音声入力には ffmpeg が必要です: brew install ffmpeg", "Voice input needs ffmpeg: brew install ffmpeg")
  if (platform === "linux" && !recorder)
    return text(
      "音声入力には録音プログラムが必要です: sudo apt install alsa-utils(または sox)",
      "Voice input needs a recorder: sudo apt install alsa-utils (or sox)",
    )
  if (!recorder)
    return text("この OS ではまだ音声入力を使えません(macOS・Linux に対応)", "Voice input supports macOS and Linux only")
  return undefined
}

let recorderCache: { done: boolean; value?: Recorder } = { done: false }
let repeatCache: { done: boolean; value?: number } = { done: false }

/// テストで録音と通信を差し替えるための入口。
export const backend = {
  /// 自動停止の時間(テストで短くする)。
  limits: { silenceMs: SILENCE_STOP_MS, maxMs: MAX_RECORDING_MS },
  spawn: (command: string, args: string[]): ChildProcess => nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }),
  fetch: (input: string, init: RequestInit) => globalThis.fetch(input, init),
  findRecorder: (platform?: NodeJS.Platform) => {
    if (platform && platform !== process.platform) return findRecorder(platform)
    if (!recorderCache.done) recorderCache = { done: true, value: findRecorder() }
    return recorderCache.value
  },
  /// macOS の「リピート入力認識までの時間」(ミリ秒)。読めなければ undefined。
  keyRepeatDelayMs: () => {
    if (process.platform !== "darwin") return undefined
    if (repeatCache.done) return repeatCache.value
    let value: number | undefined
    try {
      const out = spawnSync("defaults", ["read", "-g", "InitialKeyRepeat"], { encoding: "utf8", timeout: 1000 })
      const n = Number(out.stdout.trim())
      if (out.status === 0 && Number.isFinite(n) && n > 0) value = n * 15
    } catch {}
    repeatCache = { done: true, value }
    return value
  },
  gitBranch: (directory: string) => {
    try {
      const out = spawnSync("git", ["-C", directory, "branch", "--show-current"], { encoding: "utf8", timeout: 2000 })
      return out.status === 0 ? out.stdout.trim() : undefined
    } catch {
      return undefined
    }
  },
}

export function levelDb(chunk: Buffer) {
  let sum = 0
  const n = Math.floor(chunk.length / 2)
  if (!n) return -120
  for (let i = 0; i < n; i++) {
    const v = chunk.readInt16LE(i * 2) / 32768
    sum += v * v
  }
  const rms = Math.sqrt(sum / n)
  return rms > 0 ? 20 * Math.log10(rms) : -120
}

export function wav(pcm: Buffer) {
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/// 長い録音を、85秒以内ごとに一番静かな所で分ける(言葉の途中で切らないため)。
export function splitPcm(pcm: Buffer, maxMs = CHUNK_MAX_MS, minMs = CHUNK_MIN_MS) {
  const bytesPerMs = (SAMPLE_RATE * 2) / 1000
  const window = Math.round(100 * bytesPerMs) & ~1
  const chunks: Buffer[] = []
  let rest = pcm
  while (rest.length > maxMs * bytesPerMs) {
    const from = Math.round(minMs * bytesPerMs) & ~1
    const to = Math.round(maxMs * bytesPerMs) & ~1
    let best = to
    let quietest = Infinity
    for (let at = from; at + window <= to; at += window) {
      const db = levelDb(rest.subarray(at, at + window))
      if (db < quietest) {
        quietest = db
        best = at + window / 2
      }
    }
    best = best & ~1
    chunks.push(rest.subarray(0, best))
    rest = rest.subarray(best)
  }
  chunks.push(rest)
  return chunks
}

export type RecordingResult = { type: "text"; text: string } | { type: "empty" } | { type: "cancelled" } | { type: "error"; message: string }

export type RecordingEvents = {
  /// 0〜1 の音量と経過ミリ秒。画面表示用。
  onLevel?: (level: number, elapsedMs: number) => void
  /// 自動停止(15秒無音・2分)で録音が終わり文字起こしに入った時。
  onAutoStop?: (reason: "silence" | "limit") => void
  onTranscribing?: () => void
}

/// 1回分の録音。finish() で文字起こし、cancel() で破棄。result はどちらでも1回だけ決まる。
export class Recording {
  readonly result: Promise<RecordingResult>
  private resolve!: (value: RecordingResult) => void
  private proc?: ChildProcess
  private chunks: Buffer[] = []
  private bytes = 0
  private heardVoice = false
  private voicedMs = 0
  private peakDb = -120
  private lastVoiceAt: number
  private readonly startedAt = Date.now()
  private timer?: ReturnType<typeof setInterval>
  private done = false
  private abort = new AbortController()

  constructor(
    private readonly options: { recorder: Recorder; language?: string; lexicon?: string; english: boolean } & RecordingEvents,
  ) {
    this.lastVoiceAt = this.startedAt
    this.result = new Promise((resolve) => (this.resolve = resolve))
    const text = (ja: string, en: string) => (options.english ? en : ja)
    try {
      this.proc = backend.spawn(options.recorder.command, options.recorder.args)
    } catch (error) {
      this.settle({ type: "error", message: text("マイクを開けませんでした", "Could not open the microphone") })
      return
    }
    let stderr = ""
    this.proc.stderr?.on("data", (data: Buffer) => (stderr = (stderr + data.toString()).slice(-400)))
    this.proc.stdout?.on("data", (chunk: Buffer) => this.onAudio(chunk))
    this.proc.on("error", () =>
      this.settle({ type: "error", message: text("マイクを開けませんでした", "Could not open the microphone") }),
    )
    this.proc.on("close", (code) => {
      if (this.done || this.finishing) return
      // 途中で録音が終わっても(マイクが外れた等)、声を録れていればそこまでを文字起こしする。
      if (this.heardVoice) {
        void this.finish()
        return
      }
      // 録音プログラムが自分から終わった(マイク権限なし・機器なし等)。
      const denied = /permission|not authorized|denied|Input\/output error|No such/i.test(stderr)
      this.settle({
        type: "error",
        message: denied
          ? text(
              "マイクを使えません。システム設定 → プライバシーとセキュリティ → マイク で、このターミナルを許可してください",
              "Microphone unavailable. Allow this terminal in System Settings → Privacy & Security → Microphone",
            )
          : text(`録音が止まりました(${options.recorder.name} code ${code})`, `Recording stopped (${options.recorder.name} code ${code})`),
      })
    })
    this.timer = setInterval(() => this.tick(), 250)
  }

  private finishing = false

  get elapsedMs() {
    return Date.now() - this.startedAt
  }

  private tailUntil = 0

  private onAudio(chunk: Buffer) {
    if (this.done || (this.finishing && Date.now() > this.tailUntil)) return
    this.chunks.push(chunk)
    this.bytes += chunk.length
    const db = levelDb(chunk)
    this.peakDb = Math.max(this.peakDb, db)
    if (db >= SPEECH_DB) {
      this.voicedMs += (chunk.length / 2 / SAMPLE_RATE) * 1000
      if (this.voicedMs >= VOICED_MS) this.heardVoice = true
      this.lastVoiceAt = Date.now()
    }
    this.options.onLevel?.(Math.max(0, Math.min(1, (db + 60) / 50)), this.elapsedMs)
  }

  private tick() {
    if (this.done || this.finishing) return
    const now = Date.now()
    if (now - this.startedAt >= backend.limits.maxMs) {
      this.options.onAutoStop?.("limit")
      void this.finish()
      return
    }
    if (now - this.lastVoiceAt >= backend.limits.silenceMs) {
      this.options.onAutoStop?.("silence")
      void this.finish()
    }
  }

  private stopProcess() {
    clearInterval(this.timer)
    // ffmpeg(avfoundation)は SIGTERM/SIGINT では止まらない(実測)。生データは受け取り済みなので強制終了でよい。
    try {
      this.proc?.kill("SIGKILL")
    } catch {}
  }

  private settle(value: RecordingResult) {
    if (this.done) return
    this.done = true
    this.stopProcess()
    this.chunks = []
    this.resolve(value)
  }

  /// 1区切りを文字にする。聞き取れなければ ""。結果が決まった(429 等)なら undefined。
  private async transcribe(pcm: Buffer): Promise<string | undefined> {
    const text = (ja: string, en: string) => (this.options.english ? en : ja)
    const url = new URL(STT_URL)
    if (this.options.language) url.searchParams.set("lang", this.options.language)
    if (this.options.lexicon) url.searchParams.set("lex", this.options.lexicon)
    const response = await backend.fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: new Uint8Array(wav(pcm)),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]),
    })
    if (response.status === 422) return ""
    if (response.status === 429) {
      this.settle({
        type: "error",
        message: text(
          "文字起こしの回数上限(10分に20回)に達しました。数分おいてからどうぞ",
          "Transcription limit reached (20 per 10 minutes). Try again in a few minutes",
        ),
      })
      return undefined
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = (await response.json()) as { ok?: boolean; text?: unknown }
    return body.ok && usableTranscript(body.text) ? body.text.trim() : ""
  }

  cancel() {
    this.abort.abort()
    this.settle({ type: "cancelled" })
  }

  /// 録音を止めて文字起こしする。tailMs だけ録り続けてから止める(語尾の欠け防止)。
  async finish(tailMs = 0) {
    if (this.done || this.finishing) return this.result
    this.finishing = true
    if (tailMs > 0) {
      this.tailUntil = Date.now() + tailMs
      await new Promise((resolve) => setTimeout(resolve, tailMs))
      if (this.done) return this.result
    }
    this.tailUntil = 0
    this.stopProcess()
    const pcm = Buffer.concat(this.chunks, this.bytes)
    this.chunks = []
    const seconds = pcm.length / (SAMPLE_RATE * 2)
    // 声らしい音がない録音は送らない(文字起こしの費用と幻聴を避ける)。
    if (!this.heardVoice || seconds < 0.4) {
      this.settle({ type: "empty" })
      return this.result
    }
    this.options.onTranscribing?.()
    const text = (ja: string, en: string) => (this.options.english ? en : ja)
    let joined = ""
    try {
      for (const piece of splitPcm(pcm)) {
        const heard = await this.transcribe(piece)
        if (heard === undefined) return this.result
        if (heard) joined = joined ? joined + joinTranscript(joined, heard) : heard
      }
      this.settle(joined ? { type: "text", text: joined } : { type: "empty" })
    } catch (error) {
      if (this.abort.signal.aborted) return this.settle({ type: "cancelled" }), this.result
      this.settle({
        type: "error",
        message: text(
          `文字起こしに失敗しました(${error instanceof Error ? error.message : String(error)})。もう一度どうぞ`,
          `Transcription failed (${error instanceof Error ? error.message : String(error)}). Try again`,
        ),
      })
    }
    return this.result
  }
}

/// `/v status` の表示。
export function describeVoice(settings: VoiceSettings, english: boolean, keyLabel: string) {
  const text = (ja: string, en: string) => (english ? en : ja)
  const how =
    settings.mode === "hold"
      ? text("空欄で Space を長押しして話し、離すと入力欄に入ります", "Hold Space on an empty prompt, release to insert")
      : text("空欄で Space を1回押して話し、もう1回押すと送信します", "Tap Space on an empty prompt, tap again to send")
  return [
    text(`音声入力: ${settings.enabled ? "ON" : "OFF"}(${settings.mode === "hold" ? "長押し" : "タップ"})`, `Voice input: ${settings.enabled ? "on" : "off"} (${settings.mode})`),
    settings.enabled ? how : text("/v on で有効にできます", "Turn on with /v on"),
    text(`${keyLabel} でも開始・確定できます。Esc で取消`, `${keyLabel} also starts/finishes. Esc cancels`),
    text(`自動送信: ${settings.autoSubmit ? "ON" : "OFF"}(/v auto on|off)`, `Auto-submit: ${settings.autoSubmit ? "on" : "off"} (/v auto on|off)`),
    privacyNotice(english),
  ].join("\n")
}

/// 送信先の説明(初回と /v status で出す)。
export function privacyNotice(english: boolean) {
  return english
    ? "Audio is sent to koe.live and transcribed by ElevenLabs or Cloudflare, with the folder and branch name as vocabulary hints. Nothing is kept on this machine. /v off disables it"
    : "音声は koe.live に送られ、ElevenLabs または Cloudflare が文字にします(フォルダ名・ブランチ名を語彙ヒントに使います)。手元には残しません。/v off で無効"
}

/// 設定を変えた時の1行表示。
export function summarizeVoice(settings: VoiceSettings, english: boolean) {
  if (!settings.enabled) return english ? "Voice input: off (/v on to enable)" : "音声入力: OFF(/v on で有効)"
  const mode = english ? settings.mode : settings.mode === "hold" ? "長押し" : "タップ"
  const auto = settings.autoSubmit ? (english ? "auto-submit on" : "自動送信あり") : english ? "auto-submit off" : "自動送信なし"
  return english ? `Voice input: on · ${mode} · ${auto}` : `音声入力: ON · ${mode} · ${auto}`
}

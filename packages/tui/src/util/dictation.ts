import { spawn as nodeSpawn, spawnSync, type ChildProcess } from "node:child_process"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
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
// 話しながら文字にするための区切り。koe.live は音声入力(src=dictation)に IP ごと10分60回の枠を
// 持つので、5秒以上話した後の1.2秒の間(言い淀みより長い)で区切り、手元でも回数を数える。
const SEGMENT_MIN_MS = 5_000
const SEGMENT_PAUSE_MS = 1_200
const RATE_WINDOW_MS = 600_000
// この回数を超えたら、録音中の区切りをやめて離した時にまとめて送る(上限60回に余裕を残す)。
const RATE_SOFT_LIMIT = 50

/// 直近10分の送信回数。同じ端末の別の Sente の分も数えるため、時刻をファイルに残す(ファイルが正)。
export function recentSends(now = Date.now()) {
  return liveSends(now).length
}

function liveSends(now: number) {
  return (backend.sentFile ? readSentFile() : backend.sent).filter((at) => now - at <= RATE_WINDOW_MS)
}

function recordSend(at = Date.now()) {
  const next = [...liveSends(at), at]
  backend.sent.splice(0, backend.sent.length, ...next)
  if (!backend.sentFile) return
  // 利用者専用のフォルダに、一時ファイルを書いてから名前を変える(途中の状態を他から読ませない)。
  try {
    mkdirSync(path.dirname(backend.sentFile), { recursive: true, mode: 0o700 })
    const temp = `${backend.sentFile}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600 })
    renameSync(temp, backend.sentFile)
  } catch {}
}

function readSentFile(): number[] {
  if (!backend.sentFile) return []
  try {
    const value: unknown = JSON.parse(readFileSync(backend.sentFile, "utf8"))
    return Array.isArray(value) ? value.filter((at): at is number => typeof at === "number") : []
  } catch {
    return []
  }
}

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

export type HoldKey = { name: string; ctrl: boolean; meta: boolean; shift: boolean; option: boolean; label: string }

/// 長押しキーの設定("space"・"f5"・"ctrl+k"・"alt+v" など)。Space(既定)と読めない値は undefined。
export function parseHoldKey(value: string | undefined): HoldKey | undefined {
  const parts = (value ?? "").trim().toLowerCase().split("+").filter(Boolean)
  const name = parts.pop()
  if (!name || name === "space") return undefined
  const mods = new Set(parts.map((part) => ({ alt: "option", opt: "option", cmd: "meta", command: "meta", control: "ctrl" })[part] ?? part))
  if ([...mods].some((mod) => !["ctrl", "meta", "shift", "option"].includes(mod))) return undefined
  return {
    name,
    ctrl: mods.has("ctrl"),
    meta: mods.has("meta"),
    shift: mods.has("shift"),
    option: mods.has("option"),
    label: [...mods, name].join("+"),
  }
}

export type Recorder = { command: string; args: string[]; name: string }

/// 使える録音プログラムを選ぶ。どれも 16kHz・モノラル・16bit の生データを標準出力に流す。
export function findRecorder(
  platform: NodeJS.Platform = process.platform,
  which: (name: string) => boolean = commandExists,
  windowsMic: () => string | undefined = listWindowsMic,
  device?: string,
): Recorder | undefined {
  const raw = ["-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-"]
  const ffmpeg = ["-hide_banner", "-loglevel", "error", "-nostdin"]
  const sox: Recorder = {
    name: "sox",
    command: "rec",
    args: ["-q", "-t", "raw", "-r", String(SAMPLE_RATE), "-c", "1", "-b", "16", "-e", "signed-integer", "-"],
  }
  if (platform === "darwin") {
    if (which("ffmpeg")) return { name: "ffmpeg", command: "ffmpeg", args: [...ffmpeg, "-f", "avfoundation", "-i", `:${device ?? "default"}`, ...raw] }
    if (which("rec")) return sox
    return undefined
  }
  if (platform === "linux") {
    if (which("arecord"))
      return {
        name: "arecord",
        command: "arecord",
        args: ["-q", ...(device ? ["-D", device] : []), "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1", "-t", "raw"],
      }
    if (which("rec")) return sox
    if (which("ffmpeg")) return { name: "ffmpeg", command: "ffmpeg", args: [...ffmpeg, "-f", "pulse", "-i", device ?? "default", ...raw] }
  }
  if (platform === "win32" && which("ffmpeg")) {
    // DirectShow は機器名の指定が必要。設定(voice.device)が無ければ一覧の最初の録音機器を使う。
    const mic = device ?? windowsMic()
    if (mic) return { name: "ffmpeg", command: "ffmpeg", args: [...ffmpeg, "-f", "dshow", "-i", `audio=${mic}`, ...raw] }
  }
  return undefined
}

/// `ffmpeg -list_devices true -f dshow -i dummy` の出力から最初の録音機器名を取り出す。
export function parseDshowAudioDevice(output: string) {
  const lines = output.split(/\r?\n/)
  // 新しい ffmpeg: 行末に (audio) が付く
  const tagged = lines.find((line) => /"[^"]+"\s*\(audio\)/.test(line))
  if (tagged) return /"([^"]+)"/.exec(tagged)?.[1]
  // 古い ffmpeg: 「DirectShow audio devices」見出しの後の最初の名前
  const heading = lines.findIndex((line) => /DirectShow audio devices/i.test(line))
  if (heading < 0) return undefined
  const named = lines.slice(heading + 1).find((line) => /"[^"]+"/.test(line) && !/Alternative name/i.test(line))
  return named ? /"([^"]+)"/.exec(named)?.[1] : undefined
}

function listWindowsMic() {
  try {
    const out = spawnSync("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], {
      encoding: "utf8",
      timeout: 5000,
    })
    return parseDshowAudioDevice(`${out.stdout ?? ""}\n${out.stderr ?? ""}`)
  } catch {
    return undefined
  }
}

function commandExists(name: string) {
  try {
    if (process.platform === "win32") return spawnSync("where", [name], { stdio: "ignore", timeout: 2000 }).status === 0
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
  device?: string,
) {
  const recorder = given === undefined ? backend.findRecorder(platform, device) : (given ?? undefined)
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
  if (platform === "win32" && !recorder)
    return text(
      "音声入力には ffmpeg とマイクが必要です: winget install ffmpeg(入れたら Sente を起動し直してください)",
      "Voice input needs ffmpeg and a microphone: winget install ffmpeg (then restart Sente)",
    )
  if (!recorder)
    return text("この OS ではまだ音声入力を使えません(macOS・Linux・Windows に対応)", "Voice input supports macOS, Linux and Windows")
  return undefined
}

/// OS のキーリピート開始までの時間(ミリ秒)。macOS は InitialKeyRepeat、Linux(X)は xset、
/// Windows は KeyboardDelay(0〜3 = 250〜1000ms)。読めなければ undefined。
export function readKeyRepeatDelay(
  platform: NodeJS.Platform,
  run: (command: string, args: string[]) => string | undefined,
): number | undefined {
  if (platform === "darwin") {
    const n = Number(run("defaults", ["read", "-g", "InitialKeyRepeat"])?.trim())
    return Number.isFinite(n) && n > 0 ? n * 15 : undefined
  }
  if (platform === "linux") {
    const match = /auto repeat delay:\s*(\d+)/.exec(run("xset", ["q"]) ?? "")
    return match ? Number(match[1]) : undefined
  }
  if (platform === "win32") {
    const match = /KeyboardDelay\s+REG_SZ\s+(\d)/.exec(run("reg", ["query", "HKCU\\Control Panel\\Keyboard", "/v", "KeyboardDelay"]) ?? "")
    return match ? (Number(match[1]) + 1) * 250 : undefined
  }
  return undefined
}

let recorderCache: { done: boolean; device?: string; value?: Recorder } = { done: false }
let repeatCache: { done: boolean; value?: number } = { done: false }

/// テストで録音と通信を差し替えるための入口。
export const backend = {
  /// 文字起こしへ送った時刻(直近10分の回数を数える)。
  sent: [] as number[],
  /// 送信時刻を共有するファイル(同じ利用者の Sente 同士で合算する)。共有の /tmp ではなく
  /// 利用者専用の状態フォルダに置く。テストでは undefined。
  sentFile:
    process.env.NODE_ENV === "test"
      ? undefined
      : (path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "sente", "voice-sends.json") as
          | string
          | undefined),
  /// 自動停止の時間(テストで短くする)。
  limits: { silenceMs: SILENCE_STOP_MS, maxMs: MAX_RECORDING_MS },
  spawn: (command: string, args: string[]): ChildProcess => nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }),
  fetch: (input: string, init: RequestInit) => globalThis.fetch(input, init),
  findRecorder: (platform?: NodeJS.Platform, device?: string) => {
    if (platform && platform !== process.platform) return findRecorder(platform, commandExists, listWindowsMic, device)
    if (!recorderCache.done || recorderCache.device !== device)
      recorderCache = { done: true, device, value: findRecorder(process.platform, commandExists, listWindowsMic, device) }
    return recorderCache.value
  },
  /// macOS の「リピート入力認識までの時間」(ミリ秒)。読めなければ undefined。
  keyRepeatDelayMs: () => {
    if (repeatCache.done) return repeatCache.value
    repeatCache = { done: true, value: readKeyRepeatDelay(process.platform, (command, args) => {
      try {
        const out = spawnSync(command, args, { encoding: "utf8", timeout: 1000 })
        return out.status === 0 ? out.stdout : undefined
      } catch {
        return undefined
      }
    }) }
    return repeatCache.value
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

export type RecordingResult = { type: "text"; text: string; warning?: string } | { type: "empty" } | { type: "cancelled" } | { type: "error"; message: string }

export type RecordingEvents = {
  /// 0〜1 の音量と経過ミリ秒。画面表示用。
  onLevel?: (level: number, elapsedMs: number) => void
  /// 自動停止(15秒無音・2分)で録音が終わり文字起こしに入った時。
  onAutoStop?: (reason: "silence" | "limit") => void
  onTranscribing?: () => void
  /// 録音中に先に文字になった分(先頭から続けて決まった所まで)。
  onPartial?: (text: string) => void
}

class RateLimited extends Error {}

/// 1回分の録音。finish() で文字起こし、cancel() で破棄。result はどちらでも1回だけ決まる。
/// 話しながら文字にするため、6秒以上話した後の短い間(0.7秒)で区切り、その区切りを
/// 録音中から順に文字起こしへ送る(onPartial で途中経過を返す)。離した時に残るのは最後の区切りだけ。
export class Recording {
  readonly result: Promise<RecordingResult>
  private resolve!: (value: RecordingResult) => void
  private proc?: ChildProcess
  private chunks: Buffer[] = []
  private bytes = 0
  private heardVoice = false
  private voicedMs = 0
  private segmentVoicedMs = 0
  private quietMs = 0
  private lastVoiceAt: number
  private readonly startedAt = Date.now()
  private timer?: ReturnType<typeof setInterval>
  private done = false
  private finishing = false
  private tailUntil = 0
  private abort = new AbortController()
  private pieces: Array<Promise<Piece>> = []
  private settled: Array<Piece | undefined> = []

  constructor(
    private readonly options: { recorder: Recorder; language?: string; lexicon?: string; english: boolean } & RecordingEvents,
  ) {
    this.lastVoiceAt = this.startedAt
    this.result = new Promise((resolve) => (this.resolve = resolve))
    const text = (ja: string, en: string) => (options.english ? en : ja)
    try {
      this.proc = backend.spawn(options.recorder.command, options.recorder.args)
    } catch {
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
      const denied = /permission|not authorized|denied|Input\/output error|No such|Could not find|I\/O error/i.test(stderr)
      this.settle({
        type: "error",
        message: denied
          ? text(
              "マイクを使えません。OS の設定(macOS はシステム設定 → プライバシーとセキュリティ → マイク)で、このターミナルを許可してください",
              "Microphone unavailable. Allow this terminal in your OS settings (macOS: System Settings → Privacy & Security → Microphone)",
            )
          : text(`録音が止まりました(${options.recorder.name} code ${code})`, `Recording stopped (${options.recorder.name} code ${code})`),
      })
    })
    this.timer = setInterval(() => this.tick(), 250)
  }

  get elapsedMs() {
    return Date.now() - this.startedAt
  }

  private onAudio(chunk: Buffer) {
    if (this.done || (this.finishing && Date.now() > this.tailUntil)) return
    this.chunks.push(chunk)
    this.bytes += chunk.length
    const db = levelDb(chunk)
    const ms = (chunk.length / 2 / SAMPLE_RATE) * 1000
    if (db >= SPEECH_DB) {
      this.voicedMs += ms
      this.segmentVoicedMs += ms
      this.quietMs = 0
      if (this.voicedMs >= VOICED_MS) this.heardVoice = true
      this.lastVoiceAt = Date.now()
    } else this.quietMs += ms
    this.options.onLevel?.(Math.max(0, Math.min(1, (db + 60) / 50)), this.elapsedMs)
    if (this.finishing) return
    const segmentMs = this.bytes / ((SAMPLE_RATE * 2) / 1000)
    // 話の切れ目で区切って先に送る。85秒を超えたら一番静かな所で切る(1回3MBの上限対策)。
    if (
      this.segmentVoicedMs >= VOICED_MS &&
      segmentMs >= SEGMENT_MIN_MS &&
      this.quietMs >= SEGMENT_PAUSE_MS &&
      recentSends() < RATE_SOFT_LIMIT
    )
      return this.cut(false)
    if (segmentMs > CHUNK_MAX_MS) this.cut(true)
  }

  private cut(keepRest: boolean) {
    const pcm = Buffer.concat(this.chunks, this.bytes)
    const parts = keepRest ? splitPcm(pcm) : [pcm]
    const rest = keepRest ? parts.pop()! : undefined
    for (const part of parts) this.send(part)
    this.chunks = rest ? [rest] : []
    this.bytes = rest?.length ?? 0
    this.segmentVoicedMs = rest ? VOICED_MS : 0
  }

  private send(pcm: Buffer) {
    recordSend()
    const index = this.pieces.length
    const piece = this.transcribe(pcm).then(
      (text): Piece => ({ text }),
      (error: unknown): Piece => ({ error }),
    )
    this.pieces.push(piece)
    void piece.then((value) => {
      this.settled[index] = value
      if (this.done) return
      // 先頭から続けて文字になった分を途中経過として返す。
      const ready: string[] = []
      for (const item of this.settled) {
        if (!item || !("text" in item)) break
        ready.push(item.text)
      }
      const partial = ready.filter(Boolean).reduce((joined, text) => (joined ? joined + joinTranscript(joined, text) : text), "")
      if (partial) this.options.onPartial?.(partial)
    })
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

  /// 1区切りを文字にする。聞き取れなければ ""。
  private async transcribe(pcm: Buffer): Promise<string> {
    const text = (ja: string, en: string) => (this.options.english ? en : ja)
    const url = new URL(STT_URL)
    // 音声入力専用の回数枠を使う(記録はしない。src=sente だけが記録対象)。
    url.searchParams.set("src", "dictation")
    if (this.options.language) url.searchParams.set("lang", this.options.language)
    if (this.options.lexicon) url.searchParams.set("lex", this.options.lexicon)
    const response = await backend.fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: new Uint8Array(wav(pcm)),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]),
    })
    if (response.status === 422) return ""
    if (response.status === 429)
      throw new RateLimited(
        text(
          "文字起こしの回数上限(10分に60回)に達しました。数分おいてからどうぞ",
          "Transcription limit reached (60 per 10 minutes). Try again in a few minutes",
        ),
      )
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
    // 声らしい音がない区切りは送らない(文字起こしの費用と幻聴を避ける)。
    if (this.segmentVoicedMs >= VOICED_MS && pcm.length / (SAMPLE_RATE * 2) >= 0.4) for (const part of splitPcm(pcm)) this.send(part)
    if (!this.heardVoice || this.pieces.length === 0) {
      this.settle({ type: "empty" })
      return this.result
    }
    this.options.onTranscribing?.()
    const results = await Promise.all(this.pieces)
    if (this.abort.signal.aborted) return this.settle({ type: "cancelled" }), this.result
    const joined = results
      .flatMap((item) => ("text" in item && item.text ? [item.text] : []))
      .reduce((all, text) => (all ? all + joinTranscript(all, text) : text), "")
    const failed = results.find((item): item is { error: unknown } => "error" in item)?.error
    if (!failed) {
      this.settle(joined ? { type: "text", text: joined } : { type: "empty" })
      return this.result
    }
    const text = (ja: string, en: string) => (this.options.english ? en : ja)
    // 一部の区切りで失敗しても、文字になった分は残す。
    if (joined)
      return (
        this.settle({
        type: "text",
        text: joined,
        warning:
          failed instanceof RateLimited
            ? failed.message
            : text("一部を文字にできませんでした。抜けた所をもう一度どうぞ", "Part of it could not be transcribed. Please repeat the missing part"),
        }),
        this.result
      )
    if (failed instanceof RateLimited) return this.settle({ type: "error", message: failed.message }), this.result
    const reason = failed instanceof Error ? failed.message : String(failed)
    this.settle({
      type: "error",
      message: text(`文字起こしに失敗しました(${reason})。もう一度どうぞ`, `Transcription failed (${reason}). Try again`),
    })
    return this.result
  }
}

type Piece = { text: string } | { error: unknown }

/// `/v status` の表示。
export function describeVoice(settings: VoiceSettings, english: boolean, keyLabel: string, holdKey?: HoldKey) {
  const text = (ja: string, en: string) => (english ? en : ja)
  const where = holdKey ? holdKey.label : text("空欄で Space", "Space on an empty prompt")
  const how =
    settings.mode === "hold"
      ? text(`${where} を長押しして話し、離すと入力欄に入ります`, `Hold ${where}, release to insert`)
      : text(`${where} を1回押して話し、もう1回押すと送信します`, `Tap ${where}, tap again to send`)
  return [
    text(`音声入力: ${settings.enabled ? "ON" : "OFF"}(${settings.mode === "hold" ? "長押し" : "タップ"})`, `Voice input: ${settings.enabled ? "on" : "off"} (${settings.mode})`),
    settings.enabled ? how : text("/v on で有効にできます", "Turn on with /v on"),
    text(`${keyLabel} でも開始・確定できます。Esc で取消`, `${keyLabel} also starts/finishes. Esc cancels`),
    ...(process.platform === "darwin"
      ? [text("Ctrl+Space が入力ソースの切り替えに使われている Mac では、もう一方のキーを使ってください", "If macOS uses Ctrl+Space to switch input sources, use the other key")]
      : []),
    text(`自動送信: ${settings.autoSubmit ? "ON" : "OFF"}(/v auto on|off)`, `Auto-submit: ${settings.autoSubmit ? "on" : "off"} (/v auto on|off)`),
    privacyNotice(english),
  ].join("\n")
}

/// 送信先の説明(初回と /v status で出す)。
export function privacyNotice(english: boolean) {
  return english
    ? "Audio is sent to koe.live and transcribed by ElevenLabs or Cloudflare, with the folder and branch name as vocabulary hints. Long dictation is sent in parts while you speak, so parts already sent stay sent even if you cancel. Nothing is kept on this machine. /v off disables it"
    : "音声は koe.live に送られ、ElevenLabs または Cloudflare が文字にします(フォルダ名・ブランチ名を語彙ヒントに使います)。長く話す時は話しながら区切って送るので、取り消す前に送った部分は送信済みです。手元には残しません。/v off で無効"
}

/// 設定を変えた時の1行表示。
export function summarizeVoice(settings: VoiceSettings, english: boolean) {
  if (!settings.enabled) return english ? "Voice input: off (/v on to enable)" : "音声入力: OFF(/v on で有効)"
  const mode = english ? settings.mode : settings.mode === "hold" ? "長押し" : "タップ"
  const auto = settings.autoSubmit ? (english ? "auto-submit on" : "自動送信あり") : english ? "auto-submit off" : "自動送信なし"
  return english ? `Voice input: on · ${mode} · ${auto}` : `音声入力: ON · ${mode} · ${auto}`
}

import { afterEach, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import {
  backend,
  readKeyRepeatDelay,
  recentSends,
  buildLexicon,
  parseDshowAudioDevice,
  parseHoldKey,
  joinTranscript,
  splitPcm,
  findRecorder,
  longEnoughToSubmit,
  parseVoiceCommand,
  Recording,
  sttLanguage,
  unavailableReason,
  usableTranscript,
  wav,
} from "../../src/util/dictation"

const original = { ...backend, limits: { ...backend.limits } }
afterEach(() => {
  Object.assign(backend, { ...original, limits: { ...original.limits } })
  backend.sent.length = 0
  backend.sentFile = undefined
})

export function fakeRecorder() {
  const procs: Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: (s?: string) => void; killed: boolean }> = []
  backend.findRecorder = () => ({ name: "fake", command: "fake", args: [] })
  backend.spawn = () => {
    const proc = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      kill(signal?: string) {
        if (proc.killed) return
        proc.killed = true
        setImmediate(() => proc.emit("close", null, signal ?? "SIGTERM"))
      },
    })
    procs.push(proc)
    return proc as never
  }
  return procs
}

/// 0.5秒ぶんの 16kHz 16bit PCM。loud=true なら声相当の音量。
export function pcm(loud: boolean, seconds = 0.5) {
  const samples = Math.round(16000 * seconds)
  const buffer = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(loud ? Math.round(Math.sin(i / 5) * 8000) : 0, i * 2)
  return buffer
}

test("parses /v commands and leaves other slash commands alone", () => {
  expect(parseVoiceCommand("/v")).toEqual({ type: "start" })
  expect(parseVoiceCommand("  /v  ")).toEqual({ type: "start" })
  expect(parseVoiceCommand("/v hold")).toEqual({ type: "set", settings: { enabled: true, mode: "hold" } })
  expect(parseVoiceCommand("/v TAP")).toEqual({ type: "set", settings: { enabled: true, mode: "tap" } })
  expect(parseVoiceCommand("/v off")).toEqual({ type: "set", settings: { enabled: false } })
  expect(parseVoiceCommand("/v on")).toEqual({ type: "set", settings: { enabled: true } })
  expect(parseVoiceCommand("/v auto on")).toEqual({ type: "set", settings: { autoSubmit: true } })
  expect(parseVoiceCommand("/v auto  off")).toEqual({ type: "set", settings: { autoSubmit: false } })
  expect(parseVoiceCommand("/v stop")).toEqual({ type: "stop" })
  expect(parseVoiceCommand("/v status")).toEqual({ type: "status" })
  expect(parseVoiceCommand("/v loud")).toEqual({ type: "invalid", value: "loud" })
  expect(parseVoiceCommand("/voice")).toBeUndefined()
  expect(parseVoiceCommand("/voice-style")).toBeUndefined()
  expect(parseVoiceCommand("v")).toBeUndefined()
})

test("auto-submit needs three words, or any text in languages without spaces", () => {
  expect(longEnoughToSubmit("fix the bug")).toBe(true)
  expect(longEnoughToSubmit("fix it")).toBe(false)
  expect(longEnoughToSubmit("テスト")).toBe(true)
  expect(longEnoughToSubmit("修正")).toBe(true)
  expect(longEnoughToSubmit("   ")).toBe(false)
})

test("drops known silence hallucinations", () => {
  expect(usableTranscript("ご視聴ありがとうございました。")).toBe(false)
  expect(usableTranscript("Thank you for watching!")).toBe(false)
  expect(usableTranscript("...")).toBe(false)
  expect(usableTranscript("テストを直して")).toBe(true)
  expect(usableTranscript(42)).toBe(false)
})

test("lexicon uses project and branch words without symbols, capped at 200 chars", () => {
  const lex = buildLexicon({ directory: "/Users/me/workspace/koe-edge", branch: "feat/voice-dictation_2" })
  expect(lex.split(",").slice(0, 4)).toEqual(["koe", "edge", "feat", "voice"])
  expect(lex).toContain("dictation")
  expect(lex).not.toMatch(/[/_]/)
  expect(lex.split(",").filter((w) => w.toLowerCase() === "koe")).toHaveLength(1)
  expect(buildLexicon({ branch: "x".repeat(300) }).length).toBeLessThanOrEqual(200)
})

test("maps language names and codes to the 20 supported languages", () => {
  expect(sttLanguage("japanese")).toBe("ja")
  expect(sttLanguage("ja-JP")).toBe("ja")
  expect(sttLanguage("English")).toBe("en")
  expect(sttLanguage("pt-BR")).toBe("pt")
  expect(sttLanguage("日本語")).toBe("ja")
  expect(sttLanguage("klingon")).toBeUndefined()
  expect(sttLanguage(undefined)).toBeUndefined()
})

test("picks a recorder per platform", () => {
  const has = (...names: string[]) => (name: string) => names.includes(name)
  expect(findRecorder("darwin", has("ffmpeg", "rec"))?.name).toBe("ffmpeg")
  expect(findRecorder("darwin", has("rec"))?.name).toBe("sox")
  expect(findRecorder("darwin", has())).toBeUndefined()
  expect(findRecorder("linux", has("arecord", "ffmpeg"))?.name).toBe("arecord")
  expect(findRecorder("linux", has("ffmpeg"))?.args).toContain("pulse")
  expect(findRecorder("win32", has("ffmpeg"), () => "Microphone (Realtek(R) Audio)")?.args).toContain("audio=Microphone (Realtek(R) Audio)")
  expect(findRecorder("win32", has("ffmpeg"), () => undefined)).toBeUndefined()
  expect(findRecorder("win32", has(), () => "Mic")).toBeUndefined()
  expect(findRecorder("freebsd", has("ffmpeg"))).toBeUndefined()
})

test("explains why voice input is unavailable", () => {
  const recorder = { name: "fake", command: "fake", args: [] }
  expect(unavailableReason(false, { SSH_CONNECTION: "1 2 3 4" }, "darwin", recorder)).toContain("SSH")
  expect(unavailableReason(false, {}, "darwin", null)).toContain("brew install ffmpeg")
  expect(unavailableReason(true, {}, "linux", null)).toContain("alsa-utils")
  expect(unavailableReason(true, {}, "win32", null)).toContain("winget install ffmpeg")
  expect(unavailableReason(true, {}, "freebsd", null)).toContain("macOS, Linux and Windows")
  expect(unavailableReason(false, {}, "darwin", recorder)).toBeUndefined()
})

test("wav header describes 16 kHz mono 16-bit audio", () => {
  const file = wav(Buffer.alloc(3200))
  expect(file.subarray(0, 4).toString()).toBe("RIFF")
  expect(file.readUInt32LE(24)).toBe(16000)
  expect(file.readUInt16LE(22)).toBe(1)
  expect(file.readUInt32LE(40)).toBe(3200)
})

test("finish sends the whole recording with language and lexicon and returns the text", async () => {
  const procs = fakeRecorder()
  const requests: Array<{ url: string; bytes: number }> = []
  backend.fetch = async (url, init) => {
    requests.push({ url, bytes: (init.body as Uint8Array).length })
    return Response.json({ ok: true, text: " テストを直して " })
  }
  const recording = new Recording({ recorder: backend.findRecorder()!, english: false, language: "ja", lexicon: "Sente,KOE" })
  procs[0]!.stdout.write(pcm(true))
  procs[0]!.stdout.write(pcm(false))
  await Bun.sleep(10)
  expect(await recording.finish()).toEqual({ type: "text", text: "テストを直して" })
  expect(procs[0]!.killed).toBe(true)
  expect(requests).toHaveLength(1)
  const url = new URL(requests[0]!.url)
  expect(url.origin + url.pathname).toBe("https://koe.live/api/stt")
  expect(url.searchParams.get("lang")).toBe("ja")
  expect(url.searchParams.get("lex")).toBe("Sente,KOE")
  expect(url.searchParams.get("src")).toBe("dictation")
  // 録音した1秒ぶん(32000バイト)+ヘッダ44バイトを丸ごと送る(最後の言葉を落とさない)。
  expect(requests[0]!.bytes).toBe(32044)
})

test("silent recordings are never sent for transcription", async () => {
  const procs = fakeRecorder()
  let calls = 0
  backend.fetch = async () => (calls++, Response.json({ ok: true, text: "幻聴" }))
  const recording = new Recording({ recorder: backend.findRecorder()!, english: false })
  procs[0]!.stdout.write(pcm(false, 2))
  await Bun.sleep(10)
  expect(await recording.finish()).toEqual({ type: "empty" })
  expect(calls).toBe(0)
})

test("cancel discards audio and aborts an in-flight transcription", async () => {
  const procs = fakeRecorder()
  let aborted = false
  backend.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true
        reject(new Error("aborted"))
      })
    })
  const recording = new Recording({ recorder: backend.findRecorder()!, english: true })
  procs[0]!.stdout.write(pcm(true))
  await Bun.sleep(10)
  void recording.finish()
  await Bun.sleep(10)
  recording.cancel()
  expect(await recording.result).toEqual({ type: "cancelled" })
  expect(aborted).toBe(true)
})

test("recorder that exits on its own reports a microphone permission hint", async () => {
  const procs = fakeRecorder()
  const recording = new Recording({ recorder: backend.findRecorder()!, english: false })
  procs[0]!.stderr.write("Input/output error\n")
  await Bun.sleep(5)
  procs[0]!.emit("close", 1, null)
  const result = await recording.result
  expect(result.type).toBe("error")
  expect(result.type === "error" && result.message).toContain("プライバシーとセキュリティ")
})

test("busy and unheard responses are reported distinctly", async () => {
  for (const [status, type] of [
    [429, "error"],
    [422, "empty"],
  ] as const) {
    const procs = fakeRecorder()
    backend.fetch = async () => new Response("{}", { status })
    const recording = new Recording({ recorder: backend.findRecorder()!, english: false })
    procs[0]!.stdout.write(pcm(true))
    await Bun.sleep(5)
    expect((await recording.finish()).type).toBe(type)
  }
})

test("recorder that ends after speech still transcribes what was captured", async () => {
  const procs = fakeRecorder()
  backend.fetch = async () => Response.json({ ok: true, text: "途中まで" })
  const recording = new Recording({ recorder: backend.findRecorder()!, english: false })
  procs[0]!.stdout.write(pcm(true))
  await Bun.sleep(5)
  procs[0]!.emit("close", 0, null)
  expect(await recording.result).toEqual({ type: "text", text: "途中まで" })
})

test("joins Japanese without spaces and other languages with one", () => {
  expect(joinTranscript("この関数を直して", "テストも直して")).toBe("テストも直して")
  expect(joinTranscript("fix this", "and the test")).toBe(" and the test")
  expect(joinTranscript("fix this ", "and")).toBe("and")
  expect(joinTranscript("", "テスト")).toBe("テスト")
  expect(joinTranscript("PRを", "deploy して")).toBe("deploy して")
})

test("long recordings are split at the quietest point under the 3 MB upload limit", () => {
  const second = 32000
  // 0〜70秒は声、70.0〜70.3秒だけ無音、その後も声で合計119秒。
  const pcm = Buffer.concat([
    pcm2(true, 70),
    pcm2(false, 0.3),
    pcm2(true, 48.7),
  ])
  const parts = splitPcm(pcm)
  expect(parts.length).toBe(2)
  expect(parts.every((part) => part.length + 44 < 3 * 1024 * 1024)).toBe(true)
  expect(Math.abs(parts[0]!.length / second - 70.15)).toBeLessThan(0.2)
  expect(parts.reduce((n, p) => n + p.length, 0)).toBe(pcm.length)
  function pcm2(loud: boolean, seconds: number) {
    return pcmOf(loud, seconds)
  }
})

function pcmOf(loud: boolean, seconds: number) {
  const samples = Math.round(16000 * seconds)
  const buffer = Buffer.alloc(samples * 2)
  if (loud) for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(Math.sin(i / 5) * 8000), i * 2)
  return buffer
}

test("a two-minute recording is transcribed in pieces and joined", async () => {
  const procs = fakeRecorder()
  const sizes: number[] = []
  let n = 0
  backend.fetch = async (_url, init) => {
    sizes.push((init.body as Uint8Array).length)
    return Response.json({ ok: true, text: ["前半です", "後半です"][n++] })
  }
  const recording = new Recording({ recorder: backend.findRecorder()!, english: false })
  procs[0]!.stdout.write(pcmOf(true, 60))
  procs[0]!.stdout.write(pcmOf(false, 0.5))
  procs[0]!.stdout.write(pcmOf(true, 59))
  await Bun.sleep(10)
  expect(await recording.finish()).toEqual({ type: "text", text: "前半です後半です" })
  expect(sizes).toHaveLength(2)
  expect(sizes.every((size) => size < 3 * 1024 * 1024)).toBe(true)
})

test("stops by itself after silence and after the time limit", async () => {
  for (const [limits, reason] of [
    [{ silenceMs: 300, maxMs: 60_000 }, "silence"],
    [{ silenceMs: 60_000, maxMs: 300 }, "limit"],
  ] as const) {
    const procs = fakeRecorder()
    backend.limits = { ...limits }
    backend.fetch = async () => Response.json({ ok: true, text: "自動停止" })
    let stopped: string | undefined
    const recording = new Recording({ recorder: backend.findRecorder()!, english: false, onAutoStop: (r) => (stopped = r) })
    procs[0]!.stdout.write(pcm(true))
    expect(await recording.result).toEqual({ type: "text", text: "自動停止" })
    expect(stopped).toBe(reason)
    expect(procs[0]!.killed).toBe(true)
  }
})

test("tail recording keeps the last words that arrive after finish is requested", async () => {
  const procs = fakeRecorder()
  let bytes = 0
  backend.fetch = async (_url, init) => ((bytes = (init.body as Uint8Array).length), Response.json({ ok: true, text: "語尾まで" }))
  const recording = new Recording({ recorder: backend.findRecorder()!, english: false })
  procs[0]!.stdout.write(pcm(true))
  const done = recording.finish(120)
  await Bun.sleep(30)
  procs[0]!.stdout.write(pcm(true))
  expect(await done).toEqual({ type: "text", text: "語尾まで" })
  expect(bytes).toBe(32044)
})

test("rate limit message explains the real limit", async () => {
  const procs = fakeRecorder()
  backend.fetch = async () => new Response("{}", { status: 429 })
  const recording = new Recording({ recorder: backend.findRecorder()!, english: false })
  procs[0]!.stdout.write(pcm(true))
  await Bun.sleep(5)
  const result = await recording.finish()
  expect(result.type === "error" && result.message).toContain("10分に60回")
})

test("SSH check can be overridden for stale tmux variables", () => {
  const recorder = { name: "fake", command: "fake", args: [] }
  expect(unavailableReason(false, { SSH_CONNECTION: "x", SENTE_VOICE_LOCAL: "1" }, "darwin", recorder)).toBeUndefined()
  expect(unavailableReason(false, { SSH_TTY: "/dev/ttys1" }, "darwin", recorder)).toContain("SENTE_VOICE_LOCAL=1")
})

test("a failure on the second piece keeps the first piece's text", async () => {
  const procs = fakeRecorder()
  let n = 0
  backend.fetch = async () => (n++ === 0 ? Response.json({ ok: true, text: "前半です" }) : new Response("{}", { status: 429 }))
  const recording = new Recording({ recorder: backend.findRecorder()!, english: false })
  procs[0]!.stdout.write(pcmOf(true, 60))
  procs[0]!.stdout.write(pcmOf(false, 0.5))
  procs[0]!.stdout.write(pcmOf(true, 59))
  await Bun.sleep(10)
  const result = await recording.finish()
  expect(result.type).toBe("text")
  expect(result.type === "text" && result.text).toBe("前半です")
  expect(result.type === "text" && result.warning).toContain("10分に60回")
})

test("long dictation is transcribed while still talking; release only waits for the last part", async () => {
  const procs = fakeRecorder()
  const requests: number[] = []
  const texts = ["最初の文です", "次の文です", "最後の文です"]
  backend.fetch = async (_url, init) => {
    requests.push((init.body as Uint8Array).length)
    return Response.json({ ok: true, text: texts[requests.length - 1] })
  }
  const partials: string[] = []
  const recording = new Recording({ recorder: backend.findRecorder()!, english: false, onPartial: (text) => partials.push(text) })
  // 16秒話して1.3秒黙る → ここで1つ目を先に送る。
  procs[0]!.stdout.write(pcmOf(true, 16))
  procs[0]!.stdout.write(pcmOf(false, 1.3))
  await Bun.sleep(20)
  expect(requests).toHaveLength(1)
  expect(partials).toEqual(["最初の文です"])
  procs[0]!.stdout.write(pcmOf(true, 15.5))
  procs[0]!.stdout.write(pcmOf(false, 1.3))
  await Bun.sleep(20)
  expect(partials.at(-1)).toBe("最初の文です次の文です")
  // 言い淀み程度の間(0.8秒)では区切らない。
  procs[0]!.stdout.write(pcmOf(true, 2))
  procs[0]!.stdout.write(pcmOf(false, 0.8))
  procs[0]!.stdout.write(pcmOf(true, 1))
  await Bun.sleep(20)
  expect(requests).toHaveLength(2)
  expect(await recording.finish()).toEqual({ type: "text", text: "最初の文です次の文です最後の文です" })
  expect(requests).toHaveLength(3)
})

test("a short dictation stays a single request (keeps within the rate limit)", async () => {
  const procs = fakeRecorder()
  let calls = 0
  backend.fetch = async () => (calls++, Response.json({ ok: true, text: "短い指示" }))
  const recording = new Recording({ recorder: backend.findRecorder()!, english: false })
  procs[0]!.stdout.write(pcmOf(true, 2))
  procs[0]!.stdout.write(pcmOf(false, 1))
  procs[0]!.stdout.write(pcmOf(true, 2))
  await Bun.sleep(10)
  expect(await recording.finish()).toEqual({ type: "text", text: "短い指示" })
  expect(calls).toBe(1)
})

test("finds the first DirectShow microphone in both ffmpeg output styles", () => {
  const modern = `[dshow @ 0001] "Integrated Camera" (video)
[dshow @ 0001]   Alternative name "@device_pnp_x"
[dshow @ 0001] "Microphone Array (Intel Smart Sound)" (audio)
[dshow @ 0001]   Alternative name "@device_cm_y"`
  expect(parseDshowAudioDevice(modern)).toBe("Microphone Array (Intel Smart Sound)")
  const legacy = `[dshow @ 0002] DirectShow video devices
[dshow @ 0002]  "Integrated Camera"
[dshow @ 0002] DirectShow audio devices
[dshow @ 0002]  "マイク (Realtek High Definition Audio)"
[dshow @ 0002]     Alternative name "@device_cm_z"`
  expect(parseDshowAudioDevice(legacy)).toBe("マイク (Realtek High Definition Audio)")
  expect(parseDshowAudioDevice("no devices")).toBeUndefined()
})

test("parses hold key settings", () => {
  expect(parseHoldKey(undefined)).toBeUndefined()
  expect(parseHoldKey("space")).toBeUndefined()
  expect(parseHoldKey("F5")).toMatchObject({ name: "f5", ctrl: false, label: "f5" })
  expect(parseHoldKey("ctrl+k")).toMatchObject({ name: "k", ctrl: true, meta: false, label: "ctrl+k" })
  expect(parseHoldKey("alt+v")).toMatchObject({ name: "v", option: true, label: "option+v" })
  expect(parseHoldKey("hyper+v")).toBeUndefined()
})

test("reads the key repeat delay on each OS", () => {
  const run = (out: string) => () => out
  expect(readKeyRepeatDelay("darwin", run("25\n"))).toBe(375)
  expect(readKeyRepeatDelay("linux", run("Keyboard Control:\n  auto repeat:  on    key click percent:  0\n  auto repeat delay:  660    repeat rate:  25"))).toBe(660)
  expect(readKeyRepeatDelay("win32", run("HKEY_CURRENT_USER\\Control Panel\\Keyboard\n    KeyboardDelay    REG_SZ    0"))).toBe(250)
  expect(readKeyRepeatDelay("linux", () => undefined)).toBeUndefined()
})

test("near the rate limit, a long dictation stops sending parts early and sends once at release", async () => {
  const procs = fakeRecorder()
  // 直近10分で既に50回送っている。
  for (let i = 0; i < 50; i++) backend.sent.push(Date.now())
  let calls = 0
  backend.fetch = async () => (calls++, Response.json({ ok: true, text: "まとめて" }))
  const recording = new Recording({ recorder: backend.findRecorder()!, english: false })
  procs[0]!.stdout.write(pcmOf(true, 16))
  procs[0]!.stdout.write(pcmOf(false, 1.3))
  procs[0]!.stdout.write(pcmOf(true, 16))
  await Bun.sleep(20)
  expect(calls).toBe(0)
  expect(await recording.finish()).toEqual({ type: "text", text: "まとめて" })
  expect(calls).toBe(1)
  expect(recentSends()).toBe(51)
})

test("two 2-minute dictations in 10 minutes stay under the 60-request limit", async () => {
  let calls = 0
  for (let round = 0; round < 2; round++) {
    const procs = fakeRecorder()
    backend.fetch = async () => (calls++, Response.json({ ok: true, text: "文" }))
    const recording = new Recording({ recorder: backend.findRecorder()!, english: false })
    // 8秒話して1.3秒黙る、を約2分くり返す(自然な間が多い口述)
    for (let i = 0; i < 13; i++) {
      procs[0]!.stdout.write(pcmOf(true, 8))
      procs[0]!.stdout.write(pcmOf(false, 1.3))
    }
    await Bun.sleep(20)
    await recording.finish()
  }
  expect(calls).toBeLessThanOrEqual(50)
})

test("a chosen microphone is passed to the recorder", () => {
  const has = (...names: string[]) => (name: string) => names.includes(name)
  expect(findRecorder("darwin", has("ffmpeg"), () => undefined, "1")?.args).toContain(":1")
  expect(findRecorder("linux", has("arecord"), () => undefined, "hw:1,0")?.args).toEqual(expect.arrayContaining(["-D", "hw:1,0"]))
  expect(findRecorder("win32", has("ffmpeg"), () => "First Mic", "USB Mic")?.args).toContain("audio=USB Mic")
})

test("send counts are shared through a file with other Sente processes", async () => {
  const { mkdtemp, writeFile, readFile } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const path = await import("node:path")
  const dir = await mkdtemp(path.join(tmpdir(), "sente-voice-"))
  backend.sentFile = path.join(dir, "sends.json")
  // 別の Sente が直近に50回送った記録。
  const now = Date.now()
  await writeFile(backend.sentFile, JSON.stringify(Array.from({ length: 50 }, (_, i) => now - i * 1000).concat([now - 700_000])))
  expect(recentSends(now)).toBe(50)
  const procs = fakeRecorder()
  let calls = 0
  backend.fetch = async () => (calls++, Response.json({ ok: true, text: "共有" }))
  const recording = new Recording({ recorder: backend.findRecorder()!, english: false })
  procs[0]!.stdout.write(pcmOf(true, 16))
  procs[0]!.stdout.write(pcmOf(false, 1.3))
  procs[0]!.stdout.write(pcmOf(true, 2))
  await Bun.sleep(20)
  expect(calls).toBe(0)
  await recording.finish()
  expect(calls).toBe(1)
  expect(JSON.parse(await readFile(backend.sentFile, "utf8"))).toHaveLength(51)
})

test("the send log lives in a private state folder and is replaced atomically", async () => {
  const { mkdtemp, readFile, stat, readdir } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const path = await import("node:path")
  const dir = await mkdtemp(path.join(tmpdir(), "sente-state-"))
  backend.sentFile = path.join(dir, "sente", "voice-sends.json")
  const procs = fakeRecorder()
  backend.fetch = async () => Response.json({ ok: true, text: "記録" })
  const recording = new Recording({ recorder: backend.findRecorder()!, english: false })
  procs[0]!.stdout.write(pcmOf(true, 1))
  await Bun.sleep(10)
  await recording.finish()
  expect(JSON.parse(await readFile(backend.sentFile, "utf8"))).toHaveLength(1)
  if (process.platform !== "win32") {
    expect((await stat(path.dirname(backend.sentFile))).mode & 0o777).toBe(0o700)
    expect((await stat(backend.sentFile)).mode & 0o777).toBe(0o600)
  }
  // 一時ファイルは残らない。
  expect((await readdir(path.dirname(backend.sentFile))).filter((name) => name.endsWith(".tmp"))).toEqual([])
})

test("with the dictation quota, a pause after about 5 seconds of speech already sends a part", async () => {
  const procs = fakeRecorder()
  let calls = 0
  const partials: string[] = []
  backend.fetch = async () => (calls++, Response.json({ ok: true, text: `文${calls}` }))
  const recording = new Recording({ recorder: backend.findRecorder()!, english: false, onPartial: (text) => partials.push(text) })
  procs[0]!.stdout.write(pcmOf(true, 5.5))
  procs[0]!.stdout.write(pcmOf(false, 1.3))
  await Bun.sleep(20)
  expect(calls).toBe(1)
  expect(partials).toEqual(["文1"])
  // 言い淀み(0.8秒)では区切らない。
  procs[0]!.stdout.write(pcmOf(true, 5.5))
  procs[0]!.stdout.write(pcmOf(false, 0.8))
  procs[0]!.stdout.write(pcmOf(true, 1))
  await Bun.sleep(20)
  expect(calls).toBe(1)
  expect(await recording.finish()).toEqual({ type: "text", text: "文1文2" })
})

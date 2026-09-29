import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

// Sente の声(KOE)のミュート状態は `~/.config/teai/mute` の有無だけで表す。
// `te voice on/off`・Sente.app のワンクリック・声での「静かにして」・
// koe-speak.js プラグインの全てがこの1ファイルを見ているので、TUI からも
// 同じ場所を触れば状態が一元化される(環境変数 AGENT_KOE=0 / NO_KOE は
// 別経路で効くため、ここでは表示にだけ反映する)。
const muteFile = () => path.join(process.env.TEAI_CONFIG_DIR ?? path.join(homedir(), ".config", "teai"), "mute")

export const voiceStyles = ["friendly", "polite", "concise"] as const
export type VoiceStyle = (typeof voiceStyles)[number]
export function voiceStyle(): VoiceStyle {
  const file = path.join(path.dirname(muteFile()), "voice-style")
  if (!existsSync(file)) return "polite"
  const value = readFileSync(file, "utf8").trim()
  return voiceStyles.find((style) => style === value) ?? "polite"
}
export function setVoiceStyle(style: VoiceStyle) {
  const dir = path.dirname(muteFile())
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "voice-style"), style + "\n")
}
export type VoiceState = { muted: boolean; envOff: boolean }

export function voiceState(): VoiceState {
  return {
    muted: existsSync(muteFile()),
    envOff: process.env.AGENT_KOE === "0" || Boolean(process.env.NO_KOE),
  }
}

export function setVoiceMuted(muted: boolean) {
  const file = muteFile()
  if (!muted) {
    rmSync(file, { force: true })
    return
  }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, "")
}

// いま鳴っている読み上げをその場で止める。`te voice off` と同じ手順
// (/tmp/sente_say_stop を置き、再生プロセスとロックを消す)。
export function stopSpeaking() {
  const queue = path.join(path.dirname(muteFile()), "voiceq")
  mkdirSync(queue, { recursive: true })
  writeFileSync(path.join(queue, "stop"), String(Date.now() / 1000))
  const pending = path.join(queue, "pending")
  if (existsSync(pending)) {
    for (const file of readdirSync(pending).filter((name) => name.endsWith(".json"))) {
      rmSync(path.join(pending, file), { force: true })
    }
  }
  try {
    writeFileSync(path.join("/tmp", "sente_say_stop"), "")
  } catch {}
  for (const file of ["sente_speaking.lock", "sente_turn_open"]) {
    try {
      rmSync(path.join("/tmp", file), { force: true })
    } catch {}
  }
}

export function voiceLabel(state: VoiceState) {
  if (state.envOff) return "OFF(環境変数 AGENT_KOE=0 / NO_KOE)"
  return state.muted ? "OFF" : "ON"
}

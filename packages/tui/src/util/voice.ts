import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

// Sente の声(KOE)のミュート状態は `~/.config/teai/mute` の有無だけで表す。
// `te voice on/off`・Sente.app のワンクリック・声での「静かにして」・
// koe-speak.js プラグインの全てがこの1ファイルを見ているので、TUI からも
// 同じ場所を触れば状態が一元化される(環境変数 AGENT_KOE=0 / NO_KOE は
// 別経路で効くため、ここでは表示にだけ反映する)。
const muteFile = () => path.join(process.env.TEAI_CONFIG_DIR ?? path.join(homedir(), ".config", "teai"), "mute")

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

import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { setVoiceMuted, setVoiceStyle, voiceState, voiceStyle, voiceStyles } from "../src/util/voice"

test("desktop style file reloads external changes and does not alter mute", () => {
  const previous = process.env.TEAI_CONFIG_DIR
  const dir = mkdtempSync(path.join(tmpdir(), "sente-style-"))
  process.env.TEAI_CONFIG_DIR = dir
  try {
    expect(voiceStyle()).toBe("polite")
    setVoiceMuted(true)
    for (const style of voiceStyles) {
      setVoiceStyle(style)
      expect(readFileSync(path.join(dir, "voice-style"), "utf8").trim()).toBe(style)
      expect(voiceStyle()).toBe(style)
      expect(voiceState().muted).toBe(true)
    }
    writeFileSync(path.join(dir, "voice-style"), "invalid")
    expect(voiceStyle()).toBe("polite")
    writeFileSync(path.join(dir, "voice-style"), "friendly\n")
    expect(voiceStyle()).toBe("friendly")
    setVoiceMuted(false)
    expect(voiceState().muted).toBe(false)
    expect(voiceStyle()).toBe("friendly")
  } finally {
    if (previous === undefined) delete process.env.TEAI_CONFIG_DIR
    else process.env.TEAI_CONFIG_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

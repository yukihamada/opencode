import type { KeyEvent } from "@opentui/core"

export type HoldRecording = { finish(): Promise<string>; cancel(): void }
export type HoldState = "idle" | "pending" | "starting" | "recording" | "transcribing"

// Raw terminals cannot distinguish a held key from a released one.
export function createSpaceHold(options: {
  enabled(): boolean
  insert(text: string): void
  transcript(text: string): void
  start(ready: () => void, level: (value: number) => void): HoldRecording
  state(value: HoldState): void
  level(value: number): void
  error(error: unknown): void
  delay?: number
  limit?: number
}) {
  let state: HoldState = "idle"
  let timer: ReturnType<typeof setTimeout> | undefined
  let recording: HoldRecording | undefined
  let generation = 0
  let toggle = false
  const set = (value: HoldState) => {
    state = value
    options.state(value)
  }
  const cancel = () => {
    generation++
    toggle = false
    clearTimeout(timer)
    recording?.cancel()
    recording = undefined
    options.level(0)
    set("idle")
  }
  const tap = () => {
    cancel()
    if (options.enabled()) options.insert(" ")
  }
  const consume = (event: KeyEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }
  const finish = async () => {
    const current = generation
    clearTimeout(timer)
    set("transcribing")
    try {
      const text = await recording!.finish()
      if (current !== generation || !options.enabled()) return
      // Release capture before opening a modal: focus changes cancel the recorder.
      cancel()
      if (text) {
        try { options.transcript(text) }
        catch (error) { options.error(error) }
      }
    } catch (error) {
      if (current === generation) options.error(error)
    } finally {
      if (current === generation) cancel()
    }
  }
  const start = () => {
    const current = ++generation
    set("starting")
    try {
      recording = options.start(
        () => { if (current === generation && state === "starting") set("recording") },
        (value) => { if (current === generation && state === "recording") options.level(value) },
      )
      timer = setTimeout(() => {
        cancel()
        options.error(new Error("Voice recording timed out; audio discarded"))
      }, options.limit ?? 60_000)
    } catch (error) {
      cancel()
      options.error(error)
    }
  }
  return {
    cancel,
    busy: () => state !== "idle",
    toggled: () => toggle,
    toggle() {
      if (state !== "idle" || !options.enabled()) return
      toggle = true
      start()
    },
    key(event: KeyEvent) {
      const space = event.name === "space" || event.name === " "
      const plain = !event.ctrl && !event.meta && !event.option && !event.shift && !event.super && !event.hyper
      if (state !== "idle" && !options.enabled()) cancel()
      if (event.eventType === "release") {
        if (toggle) return
        if (!space || state === "idle") return
        consume(event)
        if (state === "pending") tap()
        else if (state === "starting" || state === "recording") void finish()
        return
      }
      if (state !== "idle" && event.name === "escape") {
        consume(event)
        cancel()
        return
      }
      if (toggle && (event.name === "return" || event.name === "enter")) {
        consume(event)
        if (state === "starting" || state === "recording") void finish()
        return
      }
      if (state === "pending" && (!space || !plain)) tap()
      if (state === "starting" || state === "recording" || state === "transcribing") {
        if (event.ctrl && (event.name === "c" || event.name === "z")) cancel()
        else consume(event)
        return
      }
      if (!space || !plain || event.source !== "kitty" || !options.enabled()) return
      consume(event)
      if (state === "pending" || event.eventType === "repeat") return
      set("pending")
      const current = ++generation
      timer = setTimeout(() => {
        if (current !== generation || !options.enabled()) return cancel()
        start()
      }, options.delay ?? 350)
    },
  }
}

export function voiceMeter(level: number) {
  const count = Math.round(Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0)) * 12)
  return "▰".repeat(count) + "▱".repeat(12 - count)
}

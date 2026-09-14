import path from "path"
import { onMount } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { readText, writeTextAtomic } from "../util/persistence"
import type { PromptInfo } from "./history"

export type StashEntry = {
  input: string
  parts: PromptInfo["parts"]
  mode?: PromptInfo["mode"]
  timestamp: number
  recovery?: { id: string; sessionID: string }
}

export const MAX_STASH_ENTRIES = 50

export function parsePromptStash(text: string) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        const entry = JSON.parse(line) as StashEntry | null
        if (!entry || typeof entry.input !== "string" || !Array.isArray(entry.parts)) return
        if (typeof entry.timestamp !== "number" || !Number.isFinite(entry.timestamp)) return
        if (entry.mode !== undefined && entry.mode !== "normal" && entry.mode !== "shell") return
        if (entry.parts.some((part) => !part || !["text", "file", "agent"].includes(part.type))) return
        if (
          entry.recovery !== undefined &&
          (!entry.recovery || typeof entry.recovery.id !== "string" || typeof entry.recovery.sessionID !== "string")
        )
          return
        return entry
      } catch {
        return undefined
      }
    })
    .filter((line): line is StashEntry => line !== undefined)
    .slice(-MAX_STASH_ENTRIES)
}

export const { use: usePromptStash, provider: PromptStashProvider } = createSimpleContext({
  name: "PromptStash",
  init: () => {
    const paths = useTuiPaths()
    const stashPath = path.join(paths.state, "prompt-stash.jsonl")
    let pending = Promise.resolve()
    let loaded = false
    function persist() {
      if (!loaded) return
      const text = store.entries.map((line) => JSON.stringify(line)).join("\n")
      // Restoring a stash can immediately save the displaced draft. Serialize
      // snapshots so the pop's write cannot erase the following push.
      pending = pending
        .then(() => writeTextAtomic(stashPath, text ? text + "\n" : ""))
        .then(() => setStore("saveError", false))
        .catch((error) => {
          setStore("saveError", true)
          console.error("Could not persist prompt stash:", error)
        })
    }
    onMount(async () => {
      const lines = parsePromptStash(await readText(stashPath).catch(() => ""))
      setStore("entries", [...lines, ...store.entries].slice(-MAX_STASH_ENTRIES))
      loaded = true
      if (store.entries.length > 0) persist()
    })

    const [store, setStore] = createStore({ entries: [] as StashEntry[], saveError: false })

    return {
      list() {
        return store.entries
      },
      get saveError() {
        return store.saveError
      },
      loaded() {
        return loaded
      },
      async flush() {
        await pending
      },
      recover(id: string, current: PromptInfo) {
        const entry = store.entries.find((entry) => entry.recovery?.id === id)
        if (!entry) return
        const displaced =
          current.input || current.parts.length ? [structuredClone(unwrap({ ...current, timestamp: Date.now() }))] : []
        setStore("entries", [...store.entries.filter((entry) => entry.recovery?.id !== id), ...displaced])
        persist()
        return structuredClone(unwrap({ input: entry.input, parts: entry.parts, mode: entry.mode }))
      },
      push(entry: Omit<StashEntry, "timestamp">) {
        const stash = structuredClone(unwrap({ ...entry, timestamp: Date.now() }))
        setStore(
          produce((draft) => {
            draft.entries.push(stash)
            if (draft.entries.length > MAX_STASH_ENTRIES) {
              draft.entries = draft.entries.slice(-MAX_STASH_ENTRIES)
            }
          }),
        )

        persist()
      },
      pop() {
        if (store.entries.length === 0) return undefined
        const entry = store.entries[store.entries.length - 1]
        setStore(produce((draft) => void draft.entries.pop()))
        persist()
        return entry
      },
      remove(index: number) {
        if (index < 0 || index >= store.entries.length) return
        setStore(produce((draft) => void draft.entries.splice(index, 1)))
        persist()
      },
    }
  },
})

import { createMemo } from "solid-js"
import { useKV } from "./kv"
import { terminalLocale } from "../util/locale"

export type Language = "ja" | "en"

export function useLanguage() {
  const kv = useKV()
  const current = createMemo<Language>(() => {
    const saved = kv.get("language")
    if (saved === "ja" || saved === "en") return saved
    return terminalLocale().startsWith("ja") ? "ja" : "en"
  })
  return {
    current,
    set: (value: Language) => kv.set("language", value),
    text: (ja: string, en: string) => current() === "ja" ? ja : en,
  }
}

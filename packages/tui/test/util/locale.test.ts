import { expect, test } from "bun:test"
import { terminalLocale, truncateWords } from "../../src/util/locale"

test("terminal locale honors POSIX precedence and normalizes encoding and modifiers", () => {
  expect(terminalLocale({ LC_ALL: "ja_JP.UTF-8", LC_MESSAGES: "de_DE", LANG: "en_US" })).toBe("ja-JP")
  expect(terminalLocale({ LC_ALL: "", LC_MESSAGES: "de_DE.UTF-8@euro", LANG: "ja_JP" })).toBe("de-DE")
  expect(terminalLocale({ LANG: "en_US.UTF-8" })).toBe("en-US")
  expect(terminalLocale({ LANG: "ja-JP" })).toBe("ja-JP")
})

test("C, missing and invalid locales do not break model display", () => {
  expect(terminalLocale({ LC_ALL: "C.UTF-8", LANG: "ja_JP" })).toBe("en-US")
  expect(terminalLocale({ LANG: "POSIX" })).toBe("en-US")
  expect(terminalLocale({ LANG: "not a locale" })).toBe("en-US")
  expect(terminalLocale({})).toBe(Intl.NumberFormat().resolvedOptions().locale)
})

test("truncateWords keeps short titles and stops at a natural boundary", () => {
  expect(truncateWords("短いタイトル", 50)).toBe("短いタイトル")
  expect(truncateWords("ログイン画面の作成と配色の調整作業", 10)).toBe("ログイン画面…")
  expect(truncateWords("debug production 500 errors today", 20)).toBe("debug production…")
})

test("truncateWords hard-cuts when no boundary keeps most of the width", () => {
  expect(truncateWords("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcdefghi…")
})

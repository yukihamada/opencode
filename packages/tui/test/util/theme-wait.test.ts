import { expect, test } from "bun:test"
import { themeModeWaitMs } from "../../src/util/theme-wait"

test("the first frame waits briefly for the terminal theme answer", () => {
  expect(themeModeWaitMs({})).toBe(150)
  expect(themeModeWaitMs({ SENTE_THEME_WAIT_MS: "1000" })).toBe(1000)
  expect(themeModeWaitMs({ SENTE_THEME_WAIT_MS: "0" })).toBe(0)
  expect(themeModeWaitMs({ SENTE_THEME_WAIT_MS: "" })).toBe(150)
  expect(themeModeWaitMs({ SENTE_THEME_WAIT_MS: "-5" })).toBe(150)
  expect(themeModeWaitMs({ SENTE_THEME_WAIT_MS: "abc" })).toBe(150)
})

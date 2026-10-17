import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import { OperationApproval, approvalOptions } from "../../../src/routes/session/operation-approval"

for (const locale of ["ja", "en"]) {
  test(`operation approval renders payload and offers only once/reject (${locale})`, async () => {
    const theme = { text: RGBA.fromHex("#ffffff"), textMuted: RGBA.fromHex("#aaaaaa") }
    const app = await testRender(() => <OperationApproval
      theme={theme} locale={locale}
      operation={'{"destination":"example.invalid","amount":10,"text":"fixture"}'}
      fingerprint="fixture-fingerprint"
    />, { width: 100, height: 12 })
    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("example.invalid")
      expect(frame).toContain('"amount":10')
      expect(frame).toContain("fixture-fingerprint")
      expect(frame).toContain(locale === "ja" ? "今回のみ" : "Run once")
      expect(Object.keys(approvalOptions("playwright_browser_click", [], locale))).toEqual(["once", "reject"])
      expect(Object.keys(approvalOptions("request_cost", ["*"], locale))).toEqual(["once", "reject"])
      expect(Object.keys(approvalOptions("read", ["src/*"], locale))).toContain("always")
    } finally {
      app.renderer.destroy()
    }
  })
}

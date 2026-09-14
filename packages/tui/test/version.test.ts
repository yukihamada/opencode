import { expect, test } from "bun:test"
import { versionLabel } from "../src/util/version"

test("preview build displays date and UTC time without branch noise", () => {
  expect(versionLabel("0.0.0-headless-model-fallback-202609131101")).toBe("2026.09.13 · 11:01 UTC")
})

test("release and local builds remain distinguishable", () => {
  expect(versionLabel("1.18.30")).toBe("v1.18.30")
  expect(versionLabel("local")).toBe("local")
})

test("malformed build dates are not presented as real dates", () => {
  expect(versionLabel("0.0.0-test-202602301101")).toBe("v0.0.0-test-202602301101")
  expect(versionLabel("0.0.0-test-202609139901")).toBe("v0.0.0-test-202609139901")
})

import { expect, test } from "bun:test"
import { ONBOARDING_KEY, shouldShowOnboarding } from "../src/onboarding"

test("does not show until KV has loaded", () => {
  expect(shouldShowOnboarding({ ready: false, get: () => undefined })).toBe(false)
})

test("shows on first launch", () => {
  expect(shouldShowOnboarding({ ready: true, get: () => undefined })).toBe(true)
})

test("does not show once completed", () => {
  expect(shouldShowOnboarding({ ready: true, get: () => true })).toBe(false)
})

test("completion key is namespaced and stable", () => {
  // キー名を変えると既存ユーザーに再度チュートリアルが出るので固定する
  expect(ONBOARDING_KEY).toBe("onboarding_completed")
})

import { expect, test } from "bun:test"
import { modelPrice, orderModels } from "../../src/util/model-browse"

test("sorts prices across providers, keeping unknown rates last and ties deterministic", () => {
  const models = [
    { title: "unknown", rank: 0, price: modelPrice(undefined) },
    { title: "costly favorite", rank: 1, price: modelPrice({ input: 10, output: 50 }) },
    { title: "cheap other provider", rank: 20, price: modelPrice({ input: 0.1, output: 0.2 }) },
    { title: "zero placeholder", rank: 20, price: modelPrice({ input: 0, output: 0 }) },
    { title: "equal favorite", rank: 2, price: modelPrice({ input: 0.1, output: 0.2 }) },
  ]
  expect(orderModels(models, "price").map((item) => item.title)).toEqual([
    "equal favorite", "cheap other provider", "costly favorite", "unknown", "zero placeholder",
  ])
  expect(orderModels(models, "recommended").map((item) => item.title)).toEqual([
    "unknown", "costly favorite", "equal favorite", "cheap other provider", "zero placeholder",
  ])
  expect(models[0].title).toBe("unknown")
})

test("invalid prices are unknown while a single zero rate remains valid", () => {
  for (const cost of [{ input: -1, output: 1 }, { input: NaN, output: 1 }, { input: 1, output: Infinity }]) {
    expect(modelPrice(cost)).toBe(Infinity)
  }
  expect(modelPrice({ input: 0, output: 1 })).toBe(1)
})

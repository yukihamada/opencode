import { terminalLocale } from "./locale"

const labels = {
  en: { rate: "Configured rate · USD/1M tokens", input: "in", output: "out", unknown: "Rate unavailable" },
  ja: { rate: "設定単価 · USD/100万token", input: "入力", output: "出力", unknown: "単価未確認" },
}

export function modelCostDetail(
  cost: { input: number; output: number } | undefined,
  locale = terminalLocale(),
) {
  const text = labels[locale.startsWith("ja") ? "ja" : "en"]
  // Providers may default missing prices to zero; this is not evidence of a free model.
  if (
    !cost ||
    !Number.isFinite(cost.input) ||
    !Number.isFinite(cost.output) ||
    cost.input < 0 ||
    cost.output < 0 ||
    (cost.input === 0 && cost.output === 0)
  )
    return text.unknown

  const number = new Intl.NumberFormat(locale, { maximumSignificantDigits: 4 })
  return `${text.rate} · ${text.input} ${number.format(cost.input)} / ${text.output} ${number.format(cost.output)}`
}

export function titlecase(str: string) {
  return str.replace(/\b\w/g, (c) => c.toUpperCase())
}

export function time(input: number): string {
  const date = new Date(input)
  return date.toLocaleTimeString(undefined, { timeStyle: "short" })
}

export function datetime(input: number): string {
  const date = new Date(input)
  const localTime = time(input)
  const localDate = date.toLocaleDateString()
  return `${localTime} · ${localDate}`
}

export function todayTimeOrDateTime(input: number): string {
  const date = new Date(input)
  const now = new Date()
  const isToday =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()

  if (isToday) {
    return time(input)
  } else {
    return datetime(input)
  }
}

export function number(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M"
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K"
  }
  return num.toString()
}

export function duration(input: number) {
  if (input < 1000) {
    return `${input}ms`
  }
  if (input < 60000) {
    return `${(input / 1000).toFixed(1)}s`
  }
  if (input < 3600000) {
    const minutes = Math.floor(input / 60000)
    const seconds = Math.floor((input % 60000) / 1000)
    return `${minutes}m ${seconds}s`
  }
  if (input < 86400000) {
    const hours = Math.floor(input / 3600000)
    const minutes = Math.floor((input % 3600000) / 60000)
    return `${hours}h ${minutes}m`
  }
  const days = Math.floor(input / 86400000)
  const hours = Math.floor((input % 86400000) / 3600000)
  return `${days}d ${hours}h`
}

export function truncate(str: string, len: number): string {
  if (str.length <= len) return str
  return str.slice(0, len - 1) + "…"
}

// Truncate at a natural boundary instead of mid-word. Prefers the last space,
// Japanese punctuation, or a particle boundary inside the limit so titles do not
// stop in the middle of a word; falls back to a hard cut when no reasonable
// boundary exists.
export function truncateWords(str: string, len: number): string {
  if (str.length <= len) return str
  const room = len - 1
  const head = str.slice(0, room)
  const marks = [" ", "　", "、", "。", "，", "・", "-", "—", "：", ":", "（", "("]
  let boundary = -1
  for (const mark of marks) boundary = Math.max(boundary, head.lastIndexOf(mark))
  // Japanese has no spaces: break after a trailing particle so the cut lands on
  // a phrase boundary (e.g. 「ログイン画面を…」) rather than mid-word.
  const particle = head.match(/.*[はをがにでとへのやも]/u)
  if (particle) boundary = Math.max(boundary, particle[0].length - 1)
  // Only break at the boundary when it keeps most of the width; otherwise a hard
  // cut reads better than dropping half the title.
  if (boundary >= Math.floor(room * 0.6)) {
    const trimmed = head.slice(0, boundary + 1).replace(/[\s、。，・\-—：:（(]+$/u, "").replace(/[はをがにでとへのやも]$/u, "")
    if (trimmed) return trimmed + "…"
  }
  return head + "…"
}

export function truncateLeft(str: string, len: number): string {
  if (str.length <= len) return str
  return "…" + str.slice(-(len - 1))
}

export function truncateMiddle(str: string, maxLength: number = 35): string {
  if (str.length <= maxLength) return str

  const ellipsis = "…"
  const keepStart = Math.ceil((maxLength - ellipsis.length) / 2)
  const keepEnd = Math.floor((maxLength - ellipsis.length) / 2)

  return str.slice(0, keepStart) + ellipsis + str.slice(-keepEnd)
}

export function pluralize(count: number, singular: string, plural: string): string {
  const template = count === 1 ? singular : plural
  return template.replace("{}", count.toString())
}

export * as Locale from "./locale"

export function terminalLocale(env: Record<string, string | undefined> = process.env) {
  const value = env.LC_ALL || env.LC_MESSAGES || env.LANG
  if (!value) return Intl.NumberFormat().resolvedOptions().locale
  const locale = value.split(/[.@]/)[0].replaceAll("_", "-")
  if (locale === "C" || locale === "POSIX") return "en-US"
  try {
    return new Intl.Locale(locale).baseName
  } catch {
    // Invalid terminal configuration must not prevent the UI opening.
    return "en-US"
  }
}

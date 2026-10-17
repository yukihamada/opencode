// Redact only the debug output; the resolved configuration must remain usable by providers.
const secretName = /(?:api.?key|secret|password|token$|authorization$|cookie$|credential|private.?key)/i

export function redactConfig(value: unknown, sensitive = false): unknown {
  if (typeof value === "string") {
    if (sensitive) return "***"
    if (!/^https?:\/\//i.test(value)) return value
    if (!URL.canParse(value)) return "***"
    const url = new URL(value)
    if (url.username || url.password || [...url.searchParams.keys()].some((name) => secretName.test(name))) return "***"
    return value
  }
  if (Array.isArray(value)) return value.map((item) => redactConfig(item, sensitive))
  if (value === null || typeof value !== "object") return value

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      redactConfig(item, sensitive || key.toLowerCase() === "headers" || secretName.test(key)),
    ]),
  )
}

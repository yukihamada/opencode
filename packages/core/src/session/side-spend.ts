// Cost of `/btw` side answers, kept in the session metadata under `btw_spend`
// (`{ total, recent: [{ usd, time }] }`) because they are not messages and so
// are not in the session's own cost. Only the server writes it: client
// metadata updates (PATCH /session, the /cost screen) never replace or remove
// it, see `keep`.

export const KEY = "btw_spend"
const RECENT = 200

type Entry = { usd: number; time: number }
type Metadata = Record<string, unknown> | undefined

function read(metadata: Metadata) {
  const value = metadata?.[KEY]
  if (typeof value !== "object" || value === null) return { total: 0, recent: [] as Entry[] }
  const total = "total" in value && typeof value.total === "number" && Number.isFinite(value.total) ? value.total : 0
  const recent =
    "recent" in value && Array.isArray(value.recent)
      ? value.recent.filter(
          (item): item is Entry =>
            typeof item === "object" && item !== null && typeof item.usd === "number" && typeof item.time === "number",
        )
      : []
  return { total: Math.max(0, total), recent }
}

/** Total recorded /btw cost of a session (USD). */
export function spentOn(metadata: Metadata) {
  return read(metadata).total
}

/**
 * /btw cost recorded at or after `since`. `partial` when the session kept only
 * its latest entries and older ones from the window may have been dropped.
 */
export function since(metadata: Metadata, time: number) {
  const value = read(metadata)
  const usd = value.recent.reduce((sum, item) => sum + (item.time >= time && item.usd > 0 ? item.usd : 0), 0)
  const partial = value.recent.length >= RECENT && (value.recent[0]?.time ?? 0) >= time
  return { usd, partial }
}

/** Metadata with one more /btw cost added. Other keys are kept. */
export function add(metadata: Metadata, usd: number, time: number): Record<string, unknown> {
  const current = read(metadata)
  return {
    ...metadata,
    [KEY]: { total: current.total + usd, recent: [...current.recent, { usd, time }].slice(-RECENT) },
  }
}

/**
 * Client-supplied metadata with the server-held `btw_spend` put back: a
 * client can neither overwrite nor delete it, even from a stale copy.
 */
export function keep(next: Record<string, unknown>, current: Metadata): Record<string, unknown> {
  const { [KEY]: _ignored, ...rest } = next
  return current?.[KEY] === undefined ? rest : { ...rest, [KEY]: current[KEY] }
}

/** Metadata without `btw_spend` (a fork did not spend the original's /btw cost). */
export function drop(metadata: Metadata) {
  if (!metadata || metadata[KEY] === undefined) return metadata
  const { [KEY]: _ignored, ...rest } = metadata
  return rest
}

export * as SideSpend from "./side-spend"

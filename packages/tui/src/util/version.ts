/** Human-facing label only. Preserve the raw build ID for updates and diagnostics. */
export function versionLabel(version: string) {
  const match = /^0\.0\.0-.+-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(version)
  if (match) {
    const [, year, month, day, hour, minute] = match
    const iso = `${year}-${month}-${day}T${hour}:${minute}:00.000Z`
    const date = new Date(iso)
    if (Number.isFinite(date.getTime()) && date.toISOString() === iso) {
      return `${year}.${month}.${day} · ${hour}:${minute} UTC`
    }
  }
  return version === "local" ? "local" : `v${version}`
}

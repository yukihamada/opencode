declare global {
  const SENTE_VERSION: string
  const SENTE_CHANNEL: string
}

export const InstallationVersion = typeof SENTE_VERSION === "string" ? SENTE_VERSION : "local"
/** Stable channel of shipped builds. Must match DEFAULT_CHANNEL in packages/script/src/channel.ts. */
export const InstallationDefaultChannel = "headless-model-fallback"

/**
 * A build stamped with an empty channel (older build scripts on a detached HEAD) used to open
 * `sente-.db` and hide every existing session. Treat it as the stable channel instead.
 * Running from source (no stamp at all) stays "local".
 */
export function normalizeChannel(stamped: string | undefined) {
  if (stamped === undefined) return "local"
  return stamped.trim() || InstallationDefaultChannel
}

export const InstallationChannel = normalizeChannel(typeof SENTE_CHANNEL === "string" ? SENTE_CHANNEL : undefined)
export const InstallationLocal = InstallationChannel === "local"
// @sente-ai/plugin is not published to npm (dev builds 0.0.0-* and sente-tagged builds alike),
// so registry installs must be skipped or every boot pays a 404 round trip.
export const InstallationPublished = false

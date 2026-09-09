declare global {
  const SENTE_VERSION: string
  const SENTE_CHANNEL: string
}

export const InstallationVersion = typeof SENTE_VERSION === "string" ? SENTE_VERSION : "local"
export const InstallationChannel = typeof SENTE_CHANNEL === "string" ? SENTE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
// @sente-ai/plugin is not published to npm (dev builds 0.0.0-* and sente-tagged builds alike),
// so registry installs must be skipped or every boot pays a 404 round trip.
export const InstallationPublished = false

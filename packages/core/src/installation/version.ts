declare global {
  const SENTE_VERSION: string
  const SENTE_CHANNEL: string
}

export const InstallationVersion = typeof SENTE_VERSION === "string" ? SENTE_VERSION : "local"
export const InstallationChannel = typeof SENTE_CHANNEL === "string" ? SENTE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"

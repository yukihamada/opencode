/** How long the first frame waits for the terminal's dark/light answer. `SENTE_THEME_WAIT_MS` overrides (0 = do not wait). */
export function themeModeWaitMs(env: Record<string, string | undefined> = process.env) {
  const value = Number(env.SENTE_THEME_WAIT_MS)
  if (env.SENTE_THEME_WAIT_MS !== undefined && env.SENTE_THEME_WAIT_MS !== "" && Number.isFinite(value) && value >= 0)
    return value
  return 150
}

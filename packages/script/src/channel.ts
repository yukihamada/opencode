// Side-effect free so tests (and the core runtime guard test) can import it without running git.

/**
 * Build channel used when nothing else decides it. The channel names the session database
 * (`sente-<channel>.db`), so it must stay the same across branches: a per-branch channel
 * silently opens a different, empty database and every existing conversation looks lost.
 * Must match `InstallationDefaultChannel` in packages/core/src/installation/version.ts.
 */
export const DEFAULT_CHANNEL = "headless-model-fallback"

export function resolveChannel(env: { SENTE_CHANNEL?: string; SENTE_BUMP?: string; SENTE_VERSION?: string }) {
  const explicit = env.SENTE_CHANNEL?.trim()
  // Set SENTE_CHANNEL=<name> on purpose to get an isolated `sente-<name>.db`.
  if (explicit) return explicit
  if (env.SENTE_BUMP) return "latest"
  if (env.SENTE_VERSION && !env.SENTE_VERSION.startsWith("0.0.0-")) return "latest"
  return DEFAULT_CHANNEL
}

/** Preview version label: keep the branch name visible even though it no longer picks the database. */
export function previewLabel(channel: string, branch: string) {
  return (branch.trim() || channel).replace(/[^a-zA-Z0-9.-]/g, "-")
}

/**
 * Whether to stamp the binary as a developer build. A developer build shares the stable
 * session database, so at startup it refuses to apply migrations the database has not seen
 * (packages/core/src/database/guard.ts). A shipped binary must never carry this stamp, so it
 * needs every one of: a `0.0.0-` preview version, not built on CI, and no explicit
 * SENTE_OFFICIAL_BUILD=1 (for the emergency manual release in script/release-sente.sh).
 */
export function devBuild(input: { version: string; env: Record<string, string | undefined> }) {
  if (!input.version.startsWith("0.0.0-")) return false
  if (input.env.CI || input.env.GITHUB_ACTIONS) return false
  if (input.env.SENTE_OFFICIAL_BUILD || input.env.SENTE_RELEASE) return false
  return true
}

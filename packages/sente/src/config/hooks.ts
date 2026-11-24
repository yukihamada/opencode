export * as ConfigHooks from "./hooks"

import path from "path"
import { createHash } from "crypto"
import { readFileSync, statSync } from "fs"
import { Global } from "@sente-ai/core/global"
import type { ConfigHooksV1 } from "@sente-ai/core/v1/config/hooks"

// Where a hook was declared:
// - "user": files the user controls outside the opened project (~/.config/sente, ~/.sente, SENTE_CONFIG,
//   SENTE_CONFIG_DIR, SENTE_CONFIG_CONTENT, managed config / MDM). Runs right away.
// - "project": the opened project's own sente.json / .sente/. A cloned repository must not run commands just by
//   being opened, so it runs only once the user trusts that exact content (`sente hooks trust`).
// - "remote": organization config fetched from a server (well-known, /api/config). A compromised server must not be
//   able to push commands to every user, so it needs the same trust, or SENTE_ALLOW_REMOTE_HOOKS=1.
export type Kind = "user" | "project" | "remote"

// One configured command, flattened out of `hooks.<Event>[].hooks[]` together with the file that declared it.
export type Origin = {
  event: string
  matcher?: string
  command: string
  timeout?: number
  source: string
  kind: Kind
}

export function flatten(hooks: ConfigHooksV1.Info | undefined, source: string, kind: Kind): Origin[] {
  return Object.entries(hooks ?? {}).flatMap(([event, groups]) =>
    groups.flatMap((group) =>
      group.hooks
        .filter(
          (hook): hook is ConfigHooksV1.Command & { command: string } => hook.type === "command" && !!hook.command,
        )
        .map((hook) => ({
          event,
          matcher: group.matcher,
          command: hook.command,
          timeout: hook.timeout,
          source,
          kind,
        })),
    ),
  )
}

const identity = (item: Origin) => JSON.stringify([item.event, item.matcher ?? "", item.command, item.timeout ?? null])

// The global config is read twice (once as the global layer, once as a config directory), and the same command may
// sit in several files. Keep one entry per identical hook, preferring the user's own copy.
export function deduplicate(items: Origin[]) {
  const seen = new Map<string, Origin>()
  for (const item of items) {
    const key = identity(item)
    const prev = seen.get(key)
    if (!prev || (prev.kind !== "user" && item.kind === "user")) seen.set(key, item)
  }
  return [...seen.values()]
}

export type Scope = { projectDir: string; cwd: string }

const PROJECT_VARS = /\$\{?(?:CLAUDE_PROJECT_DIR|SENTE_PROJECT_DIR)\}?/g
const PWD_VAR = /\$\{?PWD\}?/g

function tokens(command: string, scope: Scope) {
  return command
    .replace(PROJECT_VARS, scope.projectDir)
    .replace(PWD_VAR, scope.cwd)
    .split(/[\s;&|()<>`]+/)
    .map((token) =>
      token
        .replace(/['"]/g, "")
        // POSIX shell escapes such as `a\.sh` name the same file as `a.sh` (on Windows, `\` separates paths).
        .replace(process.platform === "win32" ? /(?!)/g : /\\(.)/g, "$1"),
    )
    .filter((token) => token && !token.startsWith("-"))
}

// Files a command names directly: `./check.sh`, `node scripts/lint.js`, `"$CLAUDE_PROJECT_DIR"/.sente/hooks/a.py`,
// `$PWD/x.sh`. Only regular files inside the project count. What those files load in turn (a script that sources
// another one, `npm run x`, a glob) is not followed: `sente hooks list` says so.
export function referencedFiles(command: string, scope: Scope) {
  const files = tokens(command, scope)
    .filter((token) => !token.includes("$"))
    // resolve() also normalizes absolute tokens (`C:\x/y` on Windows).
    .map((token) => path.resolve(scope.cwd, token))
    .filter((file) => {
      const relative = path.relative(scope.projectDir, file)
      if (relative.startsWith("..") || path.isAbsolute(relative)) return false
      try {
        return statSync(file).isFile()
      } catch {
        return false
      }
    })
  return [...new Set(files)].toSorted()
}

// Parts of a command Sente cannot resolve to a file (other variables, command substitution): a script named that way
// is not covered by the fingerprint, and `sente hooks list` warns about it.
export function unresolved(command: string, scope: Scope) {
  return [...new Set(tokens(command, scope).filter((token) => token.includes("$")))]
}

// File hashes are cached by inode, size, mtime and ctime, so checking trust before every hook run stays cheap. ctime
// cannot be set back by `touch -t` (any write or metadata change moves it), so a same-size rewrite with a restored
// mtime is still seen. On Windows nothing is cached.
const hashes = new Map<string, { key: string; hash: string }>()

function hashFile(file: string) {
  try {
    const stat = statSync(file)
    const cached = hashes.get(file)
    const key = [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":")
    // Windows does not reliably move ctime on a rewrite, so files are hashed every time there.
    if (process.platform !== "win32" && cached?.key === key) return cached.hash
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex")
    hashes.set(file, { key, hash })
    return hash
  } catch {
    return "unreadable"
  }
}

// Trust is bound to the exact hooks a file declares and to the content of the scripts they name directly: editing
// either (or a `git pull` that changes them) asks again.
export function fingerprint(items: Origin[], scope?: Scope) {
  const files = scope ? [...new Set(items.flatMap((item) => referencedFiles(item.command, scope)))].toSorted() : []
  return createHash("sha256")
    .update(JSON.stringify([items.map(identity).toSorted(), files.map((file) => [file, hashFile(file)])]))
    .digest("hex")
}

export function bySource(items: Origin[]) {
  return Map.groupBy(items, (item) => item.source)
}

export function trustFile() {
  return path.join(Global.Path.state, "hooks-trust.json")
}

export async function readTrust(): Promise<Record<string, string>> {
  const data = await Bun.file(trustFile())
    .json()
    .catch(() => ({}))
  if (!data || typeof data !== "object" || Array.isArray(data)) return {}
  return Object.fromEntries(
    Object.entries(data).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

const trustCache = { key: "", value: {} as Record<string, string> }

// Synchronous, mtime-cached read of the trust file for the check right before each project/remote hook runs, so an
// `untrust` in another terminal takes effect without restarting.
export function readTrustSync(): Record<string, string> {
  try {
    const stat = statSync(trustFile())
    const key = [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":")
    if (process.platform !== "win32" && key === trustCache.key) return trustCache.value
    const data: unknown = JSON.parse(readFileSync(trustFile(), "utf8"))
    const value =
      data && typeof data === "object" && !Array.isArray(data)
        ? Object.fromEntries(
            Object.entries(data).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
          )
        : {}
    Object.assign(trustCache, { key, value })
    return value
  } catch {
    return {}
  }
}

export async function writeTrust(next: Record<string, string>) {
  await Bun.write(trustFile(), JSON.stringify(next, null, 2) + "\n")
}

export type Status = {
  source: string
  kind: Kind
  // "user config", "project" or "remote: <url>"
  label: string
  hooks: Origin[]
  files: string[]
  fingerprint: string
  trusted: boolean
  // Trusted once, changed since: its PreToolUse / UserPromptSubmit hooks still take part, and block until trusted again.
  lapsed?: boolean
  reason: string
}

// Per source: is it allowed to run, and why.
export function status(
  items: Origin[],
  trust: Record<string, string>,
  scope: Scope,
  env: Record<string, string | undefined> = process.env,
): Status[] {
  return [...bySource(items)].map(([source, hooks]) => {
    const kind = hooks.find((hook) => hook.kind !== "user")?.kind ?? "user"
    const base = {
      source,
      kind,
      label: kind === "user" ? "user config" : kind === "remote" ? `remote: ${source}` : "project",
      hooks,
      files: [...new Set(hooks.flatMap((hook) => referencedFiles(hook.command, scope)))].toSorted(),
      fingerprint: fingerprint(hooks, scope),
    }
    if (kind === "user") return { ...base, trusted: true, reason: "user config" }
    if (kind === "project" && env.SENTE_TRUST_PROJECT_HOOKS === "1")
      return { ...base, trusted: true, reason: "SENTE_TRUST_PROJECT_HOOKS=1" }
    if (kind === "remote" && env.SENTE_ALLOW_REMOTE_HOOKS === "1")
      return { ...base, trusted: true, reason: "SENTE_ALLOW_REMOTE_HOOKS=1" }
    if (trust[source] === base.fingerprint) return { ...base, trusted: true, reason: `trusted ${kind}` }
    return {
      ...base,
      trusted: false,
      lapsed: !!trust[source],
      reason: trust[source]
        ? `${kind} hooks or their scripts changed since they were trusted`
        : `${kind} hooks not trusted yet`,
    }
  })
}

export function scopeOf(ctx: { directory: string; worktree: string }): Scope {
  return { projectDir: ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory, cwd: ctx.directory }
}

// `sente hooks trust` only offers files that belong to the opened project: inside the git worktree, or inside the
// current directory when there is no git repository (config lookup walks up to `/` then, and a parent directory's
// sente.json must not be trusted in bulk from here).
export function inProject(source: string, ctx: { directory: string; worktree: string }) {
  const root = ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory
  const relative = path.relative(root, source)
  return !relative.startsWith("..") && !path.isAbsolute(relative)
}

// Checked right before a project or remote hook runs: the trust given at startup is not enough, because the hook's
// scripts (or the trust file) can change while Sente is running. Returns why the hook must not run, if it must not.
export function recheck(
  source: Origin[],
  scope: Scope,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const current = status(source, readTrustSync(), scope, env)[0]
  return current && !current.trusted ? current.reason : undefined
}

export * as ConfigHooks from "./hooks"

import path from "path"
import { createHash } from "crypto"
import { Global } from "@sente-ai/core/global"
import type { ConfigHooksV1 } from "@sente-ai/core/v1/config/hooks"

// One configured command, flattened out of `hooks.<Event>[].hooks[]` together with the file that declared it.
// `trusted` is false for hooks that came from the opened project's own files (sente.json / .sente/ inside the
// project): those run only once the user trusts that exact content with `sente hooks trust`.
export type Origin = {
  event: string
  matcher?: string
  command: string
  timeout?: number
  source: string
  trusted: boolean
}

export function flatten(hooks: ConfigHooksV1.Info | undefined, source: string, trusted: boolean): Origin[] {
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
          trusted,
        })),
    ),
  )
}

const identity = (item: Origin) => JSON.stringify([item.event, item.matcher ?? "", item.command, item.timeout ?? null])

// The global config is read twice (once as the global layer, once as a config directory), and the same command may
// sit in several files. Keep one entry per identical hook; it is trusted when any file that declares it is trusted.
export function deduplicate(items: Origin[]) {
  const seen = new Map<string, Origin>()
  for (const item of items) {
    const key = identity(item)
    const prev = seen.get(key)
    if (!prev) {
      seen.set(key, item)
      continue
    }
    if (!prev.trusted && item.trusted) seen.set(key, item)
  }
  return [...seen.values()]
}

// Trust is bound to the exact hooks a file declares: editing them (or a `git pull` that changes them) asks again.
export function fingerprint(items: Origin[]) {
  return createHash("sha256")
    .update(JSON.stringify(items.map(identity).toSorted()))
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

export async function writeTrust(next: Record<string, string>) {
  await Bun.write(trustFile(), JSON.stringify(next, null, 2) + "\n")
}

export type Status = { source: string; hooks: Origin[]; fingerprint: string; trusted: boolean; reason: string }

// Per source file: is it allowed to run, and why.
export function status(
  items: Origin[],
  trust: Record<string, string>,
  env: Record<string, string | undefined> = process.env,
): Status[] {
  return [...bySource(items)].map(([source, hooks]) => {
    const print = fingerprint(hooks)
    if (hooks.every((hook) => hook.trusted))
      return { source, hooks, fingerprint: print, trusted: true, reason: "user config" }
    if (env.SENTE_TRUST_PROJECT_HOOKS === "1")
      return { source, hooks, fingerprint: print, trusted: true, reason: "SENTE_TRUST_PROJECT_HOOKS=1" }
    if (trust[source] === print) return { source, hooks, fingerprint: print, trusted: true, reason: "trusted project" }
    return {
      source,
      hooks,
      fingerprint: print,
      trusted: false,
      reason: trust[source] ? "project hooks changed since they were trusted" : "project hooks not trusted yet",
    }
  })
}

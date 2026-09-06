#!/usr/bin/env bun
/**
 * Pull upstream OpenCode (anomalyco/opencode) into this rebranded fork.
 *
 *   bun run sync-upstream                # merge upstream/dev into the current branch
 *   bun run sync-upstream -- --ref upstream/dev --no-install --allow-dirty
 *
 * Why this exists: the fork renamed opencode → sente everywhere (packages, env
 * vars, config paths, copy), so a plain `git merge upstream/dev` conflicts on
 * hundreds of files whose only fork-side change is that rename. This script
 * runs the merge, then re-resolves every conflicted file with a rebrand-aware
 * 3-way merge (base and upstream are rebranded before `git merge-file`), so
 * only genuine conflicts are left for a human. It also rebrands "opencode"
 * mentions that upstream introduced in lines/files git auto-merged verbatim.
 *
 * Afterwards: review `git diff --cached --stat`, run typecheck + tests
 * (`bun install --force` if bun patches look stale), commit, push — the
 * sente-release workflow publishes the binaries.
 */
import path from "path"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const ref = opt("--ref") ?? "upstream/dev"
const root = git("rev-parse", "--show-toplevel").trim()
process.chdir(root)

function git(...argv: string[]) {
  const r = Bun.spawnSync(["git", ...argv], { stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) throw new Error(`git ${argv.join(" ")} failed: ${r.stderr.toString()}`)
  return r.stdout.toString()
}

/** Blob at rev:file, or undefined. (`git show rev:path` is not used: for a missing path that contains `[…]` it prints the commit instead of failing.) */
function show(rev: string, file: string) {
  const entry = Bun.spawnSync(["git", "ls-tree", "-z", rev, "--", file], { stdout: "pipe", stderr: "pipe" })
  const match = entry.stdout.toString().match(/^\d+ blob ([0-9a-f]+)\t/)
  if (!match) return undefined
  const r = Bun.spawnSync(["git", "cat-file", "blob", match[1]], { stdout: "pipe", stderr: "pipe" })
  return r.exitCode === 0 ? new Uint8Array(r.stdout) : undefined
}

const decoder = new TextDecoder("utf-8", { fatal: false })
const encoder = new TextEncoder()

/** Same mapping the original rebrand commit used (156ad800bc). Order matters: domain first. */
function rebrand(text: string) {
  return text
    .replaceAll("opencode.ai", "teai.io/sente")
    .replaceAll("OPENCODE", "SENTE")
    .replaceAll("OpenCode", "Sente")
    .replaceAll("Opencode", "Sente")
    .replaceAll("openCode", "sente")
    .replaceAll("opencode", "sente")
}
const rebrandBytes = (b: Uint8Array) => encoder.encode(rebrand(decoder.decode(b)))
const binary = (b: Uint8Array) => b.subarray(0, 8000).includes(0)
/** Fork path → upstream path (packages/sente → packages/opencode, .sente → .opencode, …). */
const upstreamPath = (p: string) => p.replaceAll("sente", "opencode").replaceAll("Sente", "OpenCode")

async function mergeFile(ours: Uint8Array, base: Uint8Array, theirs: Uint8Array) {
  const dir = mkdtempSync(path.join(tmpdir(), "sync-upstream-"))
  const files = { ours: path.join(dir, "ours"), base: path.join(dir, "base"), theirs: path.join(dir, "theirs") }
  await Bun.write(files.ours, ours)
  await Bun.write(files.base, base)
  await Bun.write(files.theirs, theirs)
  const r = Bun.spawnSync(
    ["git", "merge-file", "-p", "-L", "ours", "-L", "base", "-L", "upstream", files.ours, files.base, files.theirs],
    { stdout: "pipe", stderr: "pipe" },
  )
  Bun.spawnSync(["rm", "-rf", dir])
  return { conflicts: r.exitCode, out: new Uint8Array(r.stdout) }
}

/** True when every fork-side commit touching `file` since `base` is rebrand/merge housekeeping. */
const housekeeping = new Map<string, boolean>()
function rebrandOnlyHistory(base: string, file: string) {
  return git("log", "--no-merges", "--format=%h %s", `${base}..HEAD`, "--", file)
    .split("\n")
    .filter(Boolean)
    .every((line) => {
      const [sha, ...rest] = line.split(" ")
      if (/rebrand|reconcile|merge leftovers|post-merge/i.test(rest.join(" "))) return true
      // Tree-wide commits (initial import, mass reformat) touch thousands of files and
      // carry no file-specific intent either.
      if (!housekeeping.has(sha)) {
        const touched = git("diff-tree", "--root", "--no-commit-id", "--name-only", "-r", sha).split("\n").filter(Boolean).length
        housekeeping.set(sha, touched >= 1000)
      }
      return housekeeping.get(sha)!
    })
}

/** Resolve a conflicted package.json/bun.lock when every hunk is just the version bump: upstream wins. */
function resolveVersionHunks(merged: string) {
  const hunk = /<<<<<<< ours\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> upstream\n/g
  let ok = true
  const out = merged.replace(hunk, (_, ours: string, theirs: string) => {
    const versionOnly = (side: string) => side.split("\n").filter(Boolean).every((l) => /^\s*"version":\s*"[^"]+",?\s*$/.test(l))
    if (!versionOnly(ours) || !versionOnly(theirs)) ok = false
    return theirs
  })
  return ok ? out : undefined
}

// ---------------------------------------------------------------------------

if (!flag("--allow-dirty") && git("status", "--porcelain").trim()) {
  console.error("Working tree is dirty. Commit/stash first, or pass --allow-dirty (dirty files must not overlap the merge).")
  process.exit(1)
}

console.log(`fetching ${ref.split("/")[0]}…`)
git("fetch", "--tags", ref.split("/")[0])
const base = git("merge-base", "HEAD", ref).trim()
const behind = git("rev-list", "--count", `HEAD..${ref}`).trim()
console.log(`merge-base ${base.slice(0, 10)} · ${behind} upstream commits to merge from ${ref}`)
if (behind === "0") {
  console.log("Already up to date.")
  process.exit(0)
}

const merge = Bun.spawnSync(["git", "merge", "--no-ff", "--no-commit", ref], { stdout: "pipe", stderr: "pipe" })
const unmerged = git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean)
if (merge.exitCode !== 0 && unmerged.length === 0) {
  console.error(merge.stderr.toString())
  process.exit(1)
}
console.log(`git merge: ${unmerged.length} conflicted files`)

const stats = { pure: 0, wholesale: 0, threeWay: 0, deleted: 0, added: 0, manual: [] as string[] }
for (const file of unmerged) {
  const ours = show("HEAD", file)
  const theirsRaw = show(ref, upstreamPath(file))
  const write = async (data: Uint8Array) => {
    await Bun.write(file, data)
    git("add", "--", file)
  }

  if (!theirsRaw) {
    // modify/delete: upstream removed it. Keep upstream's decision.
    git("rm", "-q", "--", file)
    stats.deleted++
    continue
  }
  if (file === "bun.lock") {
    // Regenerated by `bun install` below; start from upstream's lock (rebranded package names).
    await write(rebrandBytes(theirsRaw))
    stats.pure++
    continue
  }
  if (!ours || binary(theirsRaw)) {
    // added by upstream inside a renamed directory (or binary): take upstream.
    await write(binary(theirsRaw) ? theirsRaw : rebrandBytes(theirsRaw))
    stats.added++
    continue
  }
  const theirs = rebrandBytes(theirsRaw)
  const baseRaw = show(base, upstreamPath(file))
  const baseText = baseRaw ? rebrandBytes(baseRaw) : new Uint8Array()
  if (Bun.deepEquals(baseText, ours) || Bun.deepEquals(theirs, ours)) {
    await write(theirs)
    stats.pure++
    continue
  }
  const merged = await mergeFile(ours, baseText, theirs)
  if (merged.conflicts === 0) {
    await write(merged.out)
    stats.threeWay++
    continue
  }
  if (file.endsWith("package.json")) {
    const resolved = resolveVersionHunks(decoder.decode(merged.out))
    if (resolved !== undefined) {
      await write(encoder.encode(resolved))
      stats.threeWay++
      continue
    }
  }
  if (rebrandOnlyHistory(base, file)) {
    // Fork never changed this file beyond the rename: hunk-level resolution would
    // leave old and new code mixed (seen with stats routes), so take upstream whole.
    await write(theirs)
    stats.wholesale++
    continue
  }
  await Bun.write(file, merged.out)
  stats.manual.push(file)
}

// Upstream lines/files git merged verbatim may still say "opencode"; rebrand only what is new.
const staged = git("diff", "--cached", "--name-status", "-M").split("\n").filter(Boolean)
let leaked = 0
for (const line of staged) {
  const [status, ...rest] = line.split("\t")
  const file = rest[rest.length - 1]
  if (status.startsWith("D") || stats.manual.includes(file)) continue
  const current = await Bun.file(file)
    .bytes()
    .catch(() => undefined)
  if (!current || binary(current)) continue
  const text = decoder.decode(current)
  if (!/opencode/i.test(text)) continue
  const before = status.startsWith("A") ? undefined : show("HEAD", file)
  if (!before) {
    await Bun.write(file, rebrand(text))
    git("add", "--", file)
    leaked++
    continue
  }
  const known = new Set(decoder.decode(before).split("\n"))
  let changed = false
  const lines = text.split("\n").map((l) => {
    if (known.has(l) || !/opencode/i.test(l)) return l
    changed = true
    return rebrand(l)
  })
  if (!changed) continue
  await Bun.write(file, lines.join("\n"))
  git("add", "--", file)
  leaked++
}

const strayUpstreamPaths = git("diff", "--cached", "--name-only").split("\n").filter((f) => /(^|\/)packages\/opencode\//.test(f))

if (!flag("--no-install")) {
  console.log("bun install (regenerates bun.lock)…")
  const r = Bun.spawnSync(["bun", "install"], { stdout: "inherit", stderr: "inherit" })
  if (r.exitCode === 0) git("add", "--", "bun.lock")
}

console.log(`
sync-upstream summary (${ref} → ${git("branch", "--show-current").trim()})
  pure rebrand diffs resolved : ${stats.pure}
  3-way merged cleanly        : ${stats.threeWay}
  upstream taken wholesale    : ${stats.wholesale}   (fork history was rename-only)
  added by upstream           : ${stats.added}
  deleted by upstream         : ${stats.deleted}
  rebranded leaked mentions   : ${leaked} files
  still conflicted (manual)   : ${stats.manual.length}`)
for (const f of stats.manual) console.log(`    ✗ ${f}`)
if (strayUpstreamPaths.length) {
  console.log(`  ⚠ paths under packages/opencode/ appeared (directory rename not detected):`)
  for (const f of strayUpstreamPaths) console.log(`    ${f}`)
}
console.log(`
next:
  git diff --cached --stat
  bun run typecheck && (cd packages/sente && bun test)      # bun install --force if vertex/anthropic patch tests fail
  git commit -m "merge: upstream ${ref} → sente (rebrand 維持)"`)
process.exit(stats.manual.length ? 2 : 0)

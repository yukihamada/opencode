// Unattended permission policy — "allowlisted autonomy" for non-TTY runs.
//
// Background: a non-interactive `sente run` has nobody to answer a permission
// prompt, so it auto-rejects every "ask". Unattended jobs (te loop / te goal /
// te agent run / launchd) therefore used to start with SENTE_NO_GUARDRAILS=1
// (= permission "allow" for everything + `--auto`), which also lets the model
// push, deploy, delete, pay and publish with no one watching.
//
// Unattended mode replaces that with a policy: only what the policy allows is
// auto-approved; everything else is rejected, logged, and reported through the
// exit code (ExitCode.PermissionDenied). The policy is evaluated for *every*
// permission check — including ones the agent config would silently allow —
// because the engine defaults to `"*": "allow"` and a policy that only saw
// "ask" requests would not restrict anything. Explicit config `deny` rules are
// still honoured first (the policy can only narrow, never widen, a deny).
//
// Safe by default: without a policy file only read-only tools and read-only
// shell commands are allowed. Commands that send, delete, pay, publish or
// deploy (git push, fly, rm, curl -X POST, gh pr merge, npm publish, ...) are
// refused even when a broad allow pattern like "*" or "git *" matches them —
// they must be named explicitly (e.g. "git push origin agent/*").
import fs from "fs"
import os from "os"
import path from "path"
import { Global } from "@sente-ai/core/global"
import { Wildcard } from "@sente-ai/core/util/wildcard"

export type OnDeny = "continue" | "stop"

/** permission name -> allowed/denied patterns (a policy file may write `true` for `["*"]`). */
export type RuleMap = Record<string, string[]>

export interface Policy {
  allow: RuleMap
  deny: RuleMap
  onDeny: OnDeny
  /** Where the policy came from, for logs ("builtin", a file path, "agent:<name>"). */
  sources: string[]
}

export interface PolicyInput {
  allow?: Record<string, boolean | string | string[]>
  deny?: Record<string, boolean | string | string[]>
  on_deny?: OnDeny
  agents?: Record<string, PolicyInput>
}

export interface Request {
  permission: string
  patterns: readonly string[]
  metadata?: Record<string, unknown>
}

export interface Context {
  /** Project worktree — `edit` patterns arrive relative to it. */
  worktree: string
  directory: string
}

export interface Verdict {
  allow: boolean
  permission: string
  /** The pattern that decided the verdict (the first refused one when denied). */
  pattern?: string
  reason: string
  /** Danger classes found on the refused command, if any. */
  danger?: string[]
}

// ---------------------------------------------------------------------------
// Built-in read-only baseline
// ---------------------------------------------------------------------------

/** Read-only shell commands. Output redirection is still refused (see `danger`). */
const READONLY_BASH = [
  "ls",
  "ls *",
  "pwd",
  "cat *",
  "head *",
  "tail *",
  "wc *",
  "grep *",
  "rg *",
  "file *",
  "stat *",
  "du *",
  "df *",
  "which *",
  "date",
  "date *",
  "echo *",
  "true",
  "jq *",
  "sort *",
  "uniq *",
  "diff *",
  "git status",
  "git status *",
  "git diff",
  "git diff *",
  "git log",
  "git log *",
  "git show *",
  "git branch",
  "git branch --show-current",
  "git branch -a",
  "git branch -r",
  "git rev-parse *",
  "git ls-files *",
  "git remote -v",
  "git blame *",
]

const SECRET_FILES = ["*.ssh/*", "*.config/teai/credentials*", "*.aws/credentials*", "*.netrc*", "*.git-credentials*"]

export const BUILTIN: Policy = {
  allow: {
    read: ["*"],
    glob: ["*"],
    grep: ["*"],
    list: ["*"],
    lsp: ["*"],
    todowrite: ["*"],
    todoread: ["*"],
    skill: ["*"],
    bash: READONLY_BASH,
    // The engine's own scratch/truncation files live in the temp dir.
    external_directory: [path.join(Global.Path.tmp, "*")],
  },
  deny: {
    // Secrets stay unreadable even when a policy allows `read: true`.
    read: ["*.env", "*.env.*", ...SECRET_FILES],
    // Shell reads of the same files (`head ~/.ssh/id_ed25519`) — cat is already fenced by external_directory.
    bash: ["*.env", "*.env *", "*/.env.*", "* .env.*", ...SECRET_FILES],
  },
  onDeny: "continue",
  sources: ["builtin"],
}

// ---------------------------------------------------------------------------
// Danger classes — never approved by a wildcard, only by an explicit pattern
// ---------------------------------------------------------------------------

type Tokens = string[]

interface DangerRule {
  id: string
  test: (tokens: Tokens, raw: string) => boolean
}

const WRAPPERS = new Set(["env", "command", "builtin", "nohup", "time", "nice", "exec", "caffeinate"])
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"])
const INTERPRETERS: Record<string, string[]> = {
  python: ["-c"],
  python3: ["-c"],
  node: ["-e", "--eval", "-p", "--print"],
  bun: ["-e", "--eval"],
  deno: ["eval"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
  php: ["-r"],
}

function tokenize(command: string): Tokens {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  for (const m of command.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? "")
  return out
}

/** Drop leading `VAR=value` assignments and wrapper commands (`env`, `nohup`, `sudo`, `timeout 5`...). */
function strip(tokens: Tokens): Tokens {
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++
      continue
    }
    const base = path.basename(t)
    if (WRAPPERS.has(base)) {
      i++
      // env -i / env -u NAME
      while (i < tokens.length && tokens[i].startsWith("-")) i += tokens[i] === "-u" ? 2 : 1
      continue
    }
    if (base === "timeout" || base === "gtimeout") {
      i++
      while (i < tokens.length && tokens[i].startsWith("-")) i++
      i++ // duration
      continue
    }
    break
  }
  return tokens.slice(i)
}

function head(tokens: Tokens) {
  return tokens.length ? path.basename(tokens[0]) : ""
}

/** `git -C dir -c k=v push` -> "push" */
function gitSub(tokens: Tokens) {
  let i = 1
  while (i < tokens.length) {
    const t = tokens[i]
    if (t === "-C" || t === "-c" || t === "--git-dir" || t === "--work-tree" || t === "--namespace") {
      i += 2
      continue
    }
    if (t.startsWith("-")) {
      i++
      continue
    }
    return { sub: t, rest: tokens.slice(i + 1) }
  }
  return { sub: "", rest: [] as string[] }
}

function hasFlag(tokens: Tokens, ...flags: string[]) {
  return tokens.some((t) => flags.some((f) => t === f || (f.startsWith("--") && t.startsWith(f + "="))))
}

/** Short-flag cluster check: `-rf`, `-fr`, `-R` ... */
function hasShort(tokens: Tokens, letters: string) {
  return tokens.some((t) => /^-[A-Za-z]+$/.test(t) && letters.split("").some((l) => t.includes(l)))
}

const WRITE_METHODS = /^(POST|PUT|PATCH|DELETE)$/i

function outputRedirect(raw: string) {
  // `>`, `>>`, `1>`, `&>`; ignore `2>&1`, `>&2` and writes to /dev/null|stdout|stderr.
  // Quoted text (`rg "=>"`) is not a redirection.
  const bare = raw.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""')
  for (const m of bare.matchAll(/(?:^|[^<>&0-9])(?:[0-9]|&)?>>?\s*(?!&)([^\s;|&]+)/g)) {
    const target = m[1]
    if (/^\/dev\/(null|stdout|stderr|tty)$/.test(target)) continue
    return true
  }
  return false
}

const DANGER: DangerRule[] = [
  { id: "output-redirect", test: (_t, raw) => outputRedirect(raw) },
  {
    id: "delete",
    test: (t) =>
      ["rm", "rmdir", "unlink", "shred", "trash", "srm"].includes(head(t)) ||
      (head(t) === "find" && hasFlag(t, "-delete", "-exec", "-execdir", "-ok")),
  },
  {
    id: "git-remote-write",
    test: (t) => {
      if (head(t) !== "git") return false
      const { sub, rest } = gitSub(t)
      if (sub === "push") return true
      if (sub === "remote" && ["add", "set-url", "remove", "rm"].includes(rest[0] ?? "")) return true
      return false
    },
  },
  {
    id: "git-destructive",
    test: (t) => {
      if (head(t) !== "git") return false
      const { sub, rest } = gitSub(t)
      if (sub === "reset" && rest.includes("--hard")) return true
      if (sub === "clean" && hasShort(rest, "f")) return true
      if (sub === "checkout" && (rest.includes("--") || rest.includes("."))) return true
      if (sub === "restore") return true
      if (sub === "branch" && hasShort(rest, "D")) return true
      if (sub === "stash" && ["drop", "clear"].includes(rest[0] ?? "")) return true
      if (sub === "filter-branch" || sub === "filter-repo") return true
      return false
    },
  },
  {
    id: "network-write",
    test: (t) => {
      const h = head(t)
      if (h === "curl") {
        for (let i = 0; i < t.length; i++) {
          const x = t[i]
          if ((x === "-X" || x === "--request") && WRITE_METHODS.test(t[i + 1] ?? "")) return true
          if (/^-X(POST|PUT|PATCH|DELETE)$/i.test(x) || /^--request=(POST|PUT|PATCH|DELETE)$/i.test(x)) return true
        }
        return hasFlag(
          t,
          "-d",
          "--data",
          "--data-raw",
          "--data-binary",
          "--data-urlencode",
          "--json",
          "-F",
          "--form",
          "--form-string",
          "-T",
          "--upload-file",
        )
      }
      if (h === "wget") return hasFlag(t, "--post-data", "--post-file", "--method", "--body-data", "--body-file")
      if (h === "http" || h === "https" || h === "xh") return t.some((x) => WRITE_METHODS.test(x))
      return (
        ["nc", "ncat", "netcat", "socat", "telnet", "ftp", "sftp", "scp", "ssh", "mail", "sendmail", "mutt"].includes(
          h,
        ) ||
        (h === "rsync" && t.slice(1).some((x) => /^[^/-][^\s]*:/.test(x)))
      )
    },
  },
  {
    id: "deploy",
    test: (t) => {
      const h = head(t)
      const sub = t[1] ?? ""
      if (
        [
          "fly",
          "flyctl",
          "vercel",
          "netlify",
          "heroku",
          "kubectl",
          "helm",
          "terraform",
          "pulumi",
          "eas",
          "fastlane",
          "xcrun",
        ].includes(h)
      )
        return true
      if (h === "wrangler") return !["whoami", "--version", "-v", "dev", "types"].includes(sub)
      if (h === "firebase" || h === "supabase") return true
      if (h === "docker" || h === "podman") return ["push", "login"].includes(sub)
      if (h === "aws" || h === "gcloud" || h === "az" || h === "gsutil") return true
      if (h === "launchctl") return true
      if (h === "crontab") return !hasFlag(t, "-l")
      return false
    },
  },
  {
    id: "publish",
    test: (t) => {
      const h = head(t)
      const sub = t[1] ?? ""
      if (["npm", "pnpm", "yarn", "bun"].includes(h) && ["publish", "unpublish", "deprecate", "dist-tag"].includes(sub))
        return true
      if (h === "cargo" && ["publish", "yank", "owner"].includes(sub)) return true
      if (h === "twine" || (h === "gem" && sub === "push")) return true
      if (h === "gh") {
        const [area = "", verb = ""] = t.slice(1).filter((x) => !x.startsWith("-"))
        if (area === "api") {
          const method = t.findIndex((x) => x === "-X" || x === "--method")
          if (method >= 0 && !/^GET$/i.test(t[method + 1] ?? "")) return true
          return hasFlag(t, "-f", "-F", "--field", "--raw-field", "--input")
        }
        const readOnly = ["view", "list", "status", "diff", "checks", "watch", "download", "search"]
        if (
          [
            "pr",
            "issue",
            "release",
            "repo",
            "gist",
            "secret",
            "variable",
            "workflow",
            "run",
            "label",
            "ruleset",
            "project",
            "cache",
          ].includes(area)
        )
          return !readOnly.includes(verb)
        if (area === "auth") return !["status", "token"].includes(verb)
        return false
      }
      if (h === "git" && gitSub(t).sub === "tag") return gitSub(t).rest.some((x) => !x.startsWith("-"))
      return false
    },
  },
  {
    id: "payment",
    test: (t) => ["stripe", "paypal"].includes(head(t)),
  },
  {
    id: "privilege",
    test: (t) =>
      [
        "sudo",
        "doas",
        "su",
        "chown",
        "security",
        "osascript",
        "defaults",
        "dscl",
        "diskutil",
        "mkfs",
        "dd",
        "shutdown",
        "reboot",
        "killall",
        "pkill",
      ].includes(head(t)) ||
      (head(t) === "chmod" && hasShort(t.slice(1), "R")),
  },
  {
    id: "shell-escape",
    test: (t) => {
      const h = head(t)
      if (h === "eval" || h === "xargs" || h === "source" || h === ".") return true
      if (SHELLS.has(h)) return t.length > 1 // `bash script.sh`, `sh -c "..."`
      const flags = INTERPRETERS[h]
      return !!flags && t.some((x) => flags.includes(x))
    },
  },
  {
    id: "agent-spawn",
    test: (t) =>
      ["te", "sente", "opencode", "claude", "codex", "koe", "fuseki"].includes(head(t)) ||
      t.includes("--dangerously-skip-permissions") ||
      t.includes("--yolo"),
  },
]

/** Danger classes of one simple shell command (as the shell tool reports it). */
export function danger(command: string): string[] {
  const tokens = strip(tokenize(command.trim()))
  if (tokens.length === 0) return []
  const raw = command
  return DANGER.filter((rule) => rule.test(tokens, raw)).map((rule) => rule.id)
}

/**
 * A pattern "explicitly" names a danger class when the pattern itself — read
 * as a command with its wildcards removed — already falls into that class.
 * `git push origin agent/*` names git-remote-write; `git *` and `*` name none.
 */
export function explicitClasses(pattern: string): string[] {
  return danger(pattern.replaceAll("*", "").replaceAll("?", ""))
}

// ---------------------------------------------------------------------------
// Policy loading and merging
// ---------------------------------------------------------------------------

export class PolicyError extends Error {}

function expandHome(pattern: string) {
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  return pattern
}

function toRules(input: unknown, where: string): RuleMap {
  if (input === undefined) return {}
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PolicyError(`${where}: must be an object`)
  const out: RuleMap = {}
  for (const [permission, value] of Object.entries(input)) {
    if (value === true) out[permission] = ["*"]
    else if (value === false) continue
    else if (typeof value === "string") out[permission] = [value]
    else if (Array.isArray(value) && value.every((x) => typeof x === "string")) out[permission] = value.map(String)
    else throw new PolicyError(`${where}.${permission}: must be true, a pattern, or a list of patterns`)
  }
  return out
}

function concat(a: RuleMap, b: RuleMap): RuleMap {
  const out: RuleMap = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = [...(out[k] ?? []), ...v]
  return out
}

/** Layer `input` on top of `base`: allows and denies are unioned, on_deny is overridden. */
export function extend(base: Policy, input: PolicyInput | undefined, source: string, agent?: string): Policy {
  if (!input) return base
  if (typeof input !== "object" || Array.isArray(input)) throw new PolicyError(`${source}: policy must be an object`)
  if (input.on_deny !== undefined && input.on_deny !== "continue" && input.on_deny !== "stop")
    throw new PolicyError(`${source}: on_deny must be "continue" or "stop"`)
  let next: Policy = {
    allow: concat(base.allow, toRules(input.allow, `${source}: allow`)),
    deny: concat(base.deny, toRules(input.deny, `${source}: deny`)),
    onDeny: input.on_deny ?? base.onDeny,
    sources: [...base.sources, source],
  }
  if (agent && input.agents?.[agent]) next = extend(next, input.agents[agent], `${source}#agents.${agent}`)
  return next
}

export function defaultPolicyPath() {
  return path.join(Global.Path.config, "unattended.json")
}

export function readPolicyFile(file: string): PolicyInput {
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch (error) {
    throw new PolicyError(`cannot read unattended policy ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return JSON.parse(text) as PolicyInput
  } catch (error) {
    throw new PolicyError(
      `invalid JSON in unattended policy ${file}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Resolve the effective policy for a run:
 *   builtin read-only baseline
 *   + policy file (explicit path, else ~/.config/sente/unattended.json when present)
 *   + that file's `agents.<name>` section
 *   + the agent's own frontmatter `sente.permissions`
 * An explicit path that cannot be read is an error — never a silent fallback.
 */
export function resolve(input: { file?: string; agent?: string; agentPermissions?: unknown }): Policy {
  let policy = BUILTIN
  const file = input.file ?? defaultPolicyPath()
  if (input.file || fs.existsSync(file)) policy = extend(policy, readPolicyFile(file), file, input.agent)
  if (input.agentPermissions !== undefined)
    policy = extend(policy, input.agentPermissions as PolicyInput, `agent:${input.agent ?? "?"}`)
  return policy
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

function matchesAny(value: string, patterns: readonly string[] | undefined) {
  if (!patterns) return undefined
  return patterns.find((p) => Wildcard.match(value, expandHome(p)))
}

function lookup(map: RuleMap, permission: string) {
  const out: string[] = []
  for (const [key, patterns] of Object.entries(map)) if (Wildcard.match(permission, key)) out.push(...patterns)
  return out
}

/** Candidate strings a pattern may be matched against (edit paths: relative and absolute). */
function candidates(permission: string, pattern: string, ctx: Context) {
  if (permission === "edit" || permission === "read") {
    const abs = path.isAbsolute(pattern) ? pattern : path.resolve(ctx.worktree, pattern)
    return abs === pattern ? [pattern] : [pattern, abs]
  }
  return [pattern]
}

export function decide(policy: Policy, request: Request, ctx: Context): Verdict {
  const allow = lookup(policy.allow, request.permission)
  const deny = lookup(policy.deny, request.permission)
  const patterns = request.patterns.length ? request.patterns : ["*"]

  for (const pattern of patterns) {
    const values = candidates(request.permission, pattern, ctx)
    const denied = values.map((v) => matchesAny(v, deny)).find(Boolean)
    if (denied)
      return { allow: false, permission: request.permission, pattern, reason: `denied by policy rule "${denied}"` }

    const hit = values.map((v) => matchesAny(v, allow)).find(Boolean)
    if (!hit) {
      const classes = request.permission === "bash" ? danger(pattern) : []
      return {
        allow: false,
        permission: request.permission,
        pattern,
        ...(classes.length ? { danger: classes } : {}),
        reason:
          (allow.length
            ? "not in the unattended allowlist"
            : `permission "${request.permission}" is not allowed unattended`) +
          (classes.length ? ` (${classes.join(", ")})` : ""),
      }
    }

    if (request.permission === "bash") {
      const classes = danger(pattern)
      if (classes.length) {
        // Every danger class must be named by some allow pattern that matches this command.
        const named = new Set(
          allow.filter((p) => Wildcard.match(pattern, expandHome(p))).flatMap((p) => explicitClasses(p)),
        )
        const missing = classes.filter((c) => !named.has(c))
        if (missing.length)
          return {
            allow: false,
            permission: request.permission,
            pattern,
            danger: missing,
            reason: `${missing.join(", ")} must be allowed by an explicit pattern (a wildcard like "${hit}" is not enough)`,
          }
      }
    }
  }
  return { allow: true, permission: request.permission, reason: "allowed by unattended policy" }
}

// ---------------------------------------------------------------------------
// Process-wide activation (set by `sente run --unattended`)
// ---------------------------------------------------------------------------

export interface Decision extends Verdict {
  time: number
  sessionID?: string
  patterns: readonly string[]
}

interface Active {
  policy: Policy
  log?: string
  onDecision?: (record: Decision) => void
  denials: Decision[]
}

let active: Active | undefined

export function activate(policy: Policy, options: { log?: string; onDecision?: (record: Decision) => void } = {}) {
  active = { policy, log: options.log, onDecision: options.onDecision, denials: [] }
}

export function deactivate() {
  active = undefined
}

export function current(): Policy | undefined {
  return active?.policy
}

export function denials(): readonly Decision[] {
  return active?.denials ?? []
}

export function defaultLogPath() {
  return process.env["SENTE_UNATTENDED_LOG"] || path.join(Global.Path.state, "unattended.jsonl")
}

/** Record a decision: remember denials, append to the JSONL audit log, notify the CLI. */
export function record(verdict: Verdict, request: Request & { sessionID?: string }) {
  if (!active) return
  const entry: Decision = { ...verdict, time: Date.now(), sessionID: request.sessionID, patterns: request.patterns }
  if (!verdict.allow) active.denials.push(entry)
  if (active.log) {
    try {
      fs.mkdirSync(path.dirname(active.log), { recursive: true })
      fs.appendFileSync(
        active.log,
        JSON.stringify({
          time: new Date(entry.time).toISOString(),
          decision: verdict.allow ? "allow" : "deny",
          permission: verdict.permission,
          pattern: verdict.pattern,
          patterns: request.patterns,
          reason: verdict.reason,
          danger: verdict.danger,
          sessionID: request.sessionID,
          cwd: process.cwd(),
          pid: process.pid,
        }) + "\n",
      )
    } catch {
      // The audit log is best-effort; the decision itself already happened.
    }
  }
  active.onDecision?.(entry)
}

export function feedback(verdict: Verdict) {
  return (
    `Unattended policy refused ${verdict.permission}${verdict.pattern ? ` "${verdict.pattern}"` : ""}: ${verdict.reason}. ` +
    "Nobody is available to approve this. Do not retry it or reach the same effect another way; " +
    "continue with what is allowed and list this blocked step in your final report."
  )
}

export * as Unattended from "./unattended"

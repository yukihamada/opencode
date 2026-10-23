// Confined execution for shell commands a non-interactive run would otherwise refuse.
//
// A non-interactive `sente run` has nobody to approve an "ask", so commands such as
// `python3 main.py` or `sh verify.sh` were refused and the agent finished without
// checking its own work. With SENTE_SHELL_SANDBOX=1 the run instead approves such a
// command on the condition that it runs under macOS Seatbelt: writes only inside the
// project and temp directories, no network except localhost. Commands a config rule
// denies, commands in a danger class (delete, send, publish, ...) and commands that
// touch other directories are never sandbox-approved; they are refused as before.
import fs from "node:fs"
import os from "node:os"

const EXEC = "/usr/bin/sandbox-exec"

/**
 * Danger classes the sandbox itself contains: running arbitrary code (`python3 -c`, `sh script.sh`) and
 * writing files. Every other class (delete, send, publish, pay, privilege, ...) is refused as before.
 */
export const CONTAINED = new Set(["output-redirect", "shell-escape"])

let active = false

/** Commands the run approved on the condition that they are confined, by request token. */
export const granted = new Set<string>()

export function available() {
  return process.platform === "darwin" && fs.existsSync(EXEC)
}

/** Turned on by `sente run` for its own in-process instance only (never for --attach or the TUI). */
export function enable() {
  active = available()
  return active
}

export function disable() {
  active = false
  granted.clear()
}

export function enabled() {
  return active
}

function real(dir: string) {
  try {
    return fs.realpathSync(dir)
  } catch {
    return dir
  }
}

function quote(value: string) {
  return '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"'
}

/**
 * Seatbelt profile: everything is allowed except writes outside `writable`, network other than loopback,
 * and the ways a confined process could reach out through another one: DNS (the query itself carries data),
 * Apple Events (e.g. asking Mail to send), opening URLs, and the keychain.
 */
export function profile(writable: string[]) {
  const dirs = [...new Set([...writable, os.tmpdir(), "/private/tmp"].map(real))].filter((dir) => dir !== "/")
  return [
    "(version 1)",
    "(allow default)",
    '(deny network-outbound (remote ip "*:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
    '(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    "(deny appleevent-send)",
    '(deny mach-lookup (global-name "com.apple.dnssd.service") (global-name-regex #"^com\\.apple\\.(coreservices\\.launchservicesd|lsd\\..*|securityd.*|SecurityServer|security\\..*|pasteboard\\..*)$"))',
    "(deny file-write*)",
    `(allow file-write* ${dirs.map((dir) => `(subpath ${quote(dir)})`).join(" ")} (regex #"^/dev/(null|zero|tty|fd/.*|stdout|stderr|dtracehelper)$"))`,
  ].join("\n")
}

export function command(shell: string, script: string, writable: string[]) {
  return { file: EXEC, args: ["-p", profile(writable), shell, "-c", script] }
}

export const NOTE =
  "This command ran in a sandbox because nobody can approve it in this non-interactive run: it may write only inside the project and temp directories, and has no network access except localhost."

export * as ShellSandbox from "./sandbox"

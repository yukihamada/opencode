# CLI terminal tab status — 2026-10-06

Implemented in `packages/tui/src/util/terminal-title.ts` and wired to the terminal renderer in `packages/tui/src/app.tsx`.

- Japanese/English status prefixes: working, done, stopped, error, approval needed, answer needed, retrying, ready, loading.
- Restored transcripts distinguish successful final responses from aborted/error/incomplete turns. Outstanding todos prevent a done badge.
- Parent tabs include child-session permission/question gates; active busy/retry status takes precedence over old transcript errors.
- Status prefixes precede truncated/sanitized session names, including unnamed sessions.

## Verified

- `cd packages/tui` then `bun test test/util/terminal-title.test.ts`: 6 pass, 22 assertions.
- `bun typecheck` from the same package: exit 0.
- `git diff --check`: exit 0.
- Native build: `SENTE_CHANNEL=local SENTE_VERSION=0.0.0-local-tab-status-20261006 SENTE_RELEASE= bun run packages/sente/script/build.ts --single --skip-install --skip-embed-web-ui`.
- Real PTY E2E against a loopback-only model: working → done/abort/error/permission/question/retry, plus done/abort/error after reopening. Nine cases passed both candidate and installed binary. Assertions inspect the latest OSC terminal title, not earlier matching output.
- Installed `~/.opencode/bin/opencode`: version `0.0.0-local-tab-status-20261006`; `codesign --verify --strict` exit 0.
- Installed SHA-256 after re-signing: `a96e2520279aac71d3535983c5ba77fd064c9f0357263debf7728399d18ba294`.
- Installed PTY evidence: `/var/folders/5h/3zhkzzk12_1g06p6w2vxc45r0000gn/T/sente/terminal-title-20261006-installed/report.json` (raw captures alongside).
- Previous binary: `/var/folders/5h/3zhkzzk12_1g06p6w2vxc45r0000gn/T/sente/terminal-title-20261006-final/opencode-before`.

Existing CLI processes need restarting to load the binary. PTY OSC output is verified; the terminal application's visual tab rendering is unverified. A process that is itself frozen cannot emit title updates; this change uses session state, not an external watchdog. No public release was performed.

# Login persistence — 2026-09-23

Base: ac5c80accc07b17b759ea2719aad795465dd0cff. Branch: login-persistence.

## Reproduced defect

The released 202609230121 engine does not read `$TE_CONFIG_DIR/credentials`
on startup. `/login` saves there and sets the current process/worker environment,
but a fresh direct engine invocation resolves `{env:TEAI_API_KEY}` to empty.
The shell launcher already loads the file when no explicit key is supplied.
This is not evidence that every launcher login failure has the same cause.

## Fix

- Restore saved credentials before command handlers and worker creation.
- Preserve explicit environment overrides and scrub-mode key isolation.
- Remove duplicate key assignments on save; parse existing files with the same
  last-assignment precedence as the launcher shell.

## Verification

- Released engine: fresh-process restoration false; patched engine: true.
- Actual TUI with loopback auth fixture: `/login` → email → six-digit code →
  saved session token → `/exit` → two fresh process config resolutions: PASS.
- Same E2E against the installed, signed binary: PASS. Saved mode 0600.
- `packages/tui`: `bun test`: 241 pass, 1 skip, 0 fail (52 files).
- `bun typecheck` in both packages/tui and packages/sente: PASS.
- Native build and codesign verification: PASS. `git diff --check`: PASS.
- Prettier check: PASS; focused oxlint: 0 errors, 5 warnings.
- Paid model/API requests: zero; no real email sent by the E2E fixture.
- Test drivers beside this checkout: `../login-restart-check.py`,
  `../login-tui-check.py`.

## Installed scope

This Mac only: `~/.opencode/bin/opencode`, version
`0.0.0-headless-model-fallback-202609230205` (same DB channel).
Previous binary: `~/.opencode/bin/opencode.pre-persistence-20260923`.
No commit, push or public release. `te update` can replace this local fix until
it is released. M5 SSH to 192.168.0.47 timed out; M5 remains unverified.

Dependency setup needed a fresh Bun cache and isolated linker; cached packages
initially lacked package.json, and hoisted mode misresolved Azure's OpenAI SDK.
Final install used `bun install --frozen-lockfile --ignore-scripts --linker isolated --force`
with an isolated BUN_INSTALL_CACHE_DIR. No lockfile change.

commit 5345bab5f497cd670826137619774f15a54261b2
Author: Yuki Hamada <mail@yukihamada.jp>
Date:   Sun Aug 30 22:22:07 2026 +0900

    perf(config): skip node_modules/.git when globbing for command/agent markdown
    
    Config.loadInstanceState globs {command,commands}/**/*.md and
    {agent,agents}/**/*.md against the project root with a recursive `**`
    pattern, and glob's `ignore` option was never set — meaning every `te`/
    `sente` session start walked the *entire* project tree, including
    node_modules and .git, looking for a command/ or commands/ directory
    anywhere in it. Measured directly (same repo, before/after, isolated with
    timing instrumentation): 3.6s on this repo's own ~5GB node_modules, down
    to ~4ms with the ignore in place. Neither pattern has any legitimate
    reason to match inside node_modules or .git, so exclude both.
    
    End-to-end (config load through first TUI paint), measured on this
    machine: ~3.1s in this repo (5GB node_modules) vs previously 25-30s+ under
    load, ~2.2s in a small Rust-only repo (nanobot) unaffected by this bug.
    
    Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

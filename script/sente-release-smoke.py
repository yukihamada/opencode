#!/usr/bin/env python3
"""Pre-release smoke for a packaged Sente binary.

Usage: sente-release-smoke.py <path-to-sente> <expected-version>

Checks, in a throwaway HOME so no user config or credentials are read:
  1. `sente --version` exits 0 and prints exactly the expected version.
  2. `sente debug config` exits 0 and prints the resolved config as JSON.
No network login or paid inference is performed.
"""
import fnmatch
import json
import os
import subprocess
import sys
import tempfile

binary = os.path.abspath(sys.argv[1])
expected = sys.argv[2]

with tempfile.TemporaryDirectory(prefix="sente-smoke-") as home:
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": home,
        "XDG_CONFIG_HOME": os.path.join(home, ".config"),
        "XDG_DATA_HOME": os.path.join(home, ".local", "share"),
        "XDG_CACHE_HOME": os.path.join(home, ".cache"),
        "XDG_STATE_HOME": os.path.join(home, ".local", "state"),
        "TERM": "dumb",
        "CI": "1",
    }

    def run(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run([binary, *args], cwd=home, env=env, capture_output=True, text=True, timeout=120)

    version = run("--version")
    assert version.returncode == 0, f"--version exit {version.returncode}: {version.stderr[-2000:]}"
    assert version.stdout.strip() == expected, f"--version printed {version.stdout.strip()!r}, expected {expected!r}"
    print(f"PASS --version = {expected}")

    config = run("debug", "config")
    assert config.returncode == 0, f"debug config exit {config.returncode}: {config.stderr[-2000:]}"
    text = config.stdout
    start = text.find("{")
    assert start >= 0, f"debug config printed no JSON: {text[-2000:]}"
    parsed = json.loads(text[start:])
    assert isinstance(parsed, dict), "debug config JSON is not an object"
    print(f"PASS debug config exit 0 ({len(parsed)} top-level keys)")

    agents = run("agent", "list")
    assert agents.returncode == 0, f"agent list exit {agents.returncode}: {agents.stderr[-2000:]}"
    marker = "delivery (primary)\n"
    assert marker in agents.stdout, "packaged binary is missing the delivery agent"
    rules, _ = json.JSONDecoder().raw_decode(agents.stdout.split(marker, 1)[1].lstrip())

    def action(permission: str, pattern: str = "*") -> str:
        matches = [
            rule for rule in rules
            if fnmatch.fnmatchcase(permission, rule["permission"])
            and fnmatch.fnmatchcase(pattern, rule["pattern"])
        ]
        assert matches, f"no permission rule for {permission}"
        return matches[-1]["action"]

    for tool in ["read", "glob", "grep", "question"]:
        assert action(tool) == "allow", f"delivery cannot review with {tool}"
    for tool in ["edit", "bash"]:
        assert action(tool) == "ask", f"delivery must ask before {tool}"
    for tool in ["task", "skill", "webfetch", "mcp_send_message", "browser_click"]:
        assert action(tool) == "deny", f"delivery must deny {tool}"
    assert action("read", ".env") == "ask", "delivery must ask before reading secrets"
    print("PASS packaged delivery agent and human-review permission gates")

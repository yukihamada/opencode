#!/usr/bin/env python3
"""End-to-end check: a running Sente picks up a rotated teai.io key without a restart.

Runs the real CLI (from source by default, or a built binary with --binary) against a
local fake model server inside a throwaway HOME. It never reads the user's credentials,
config or sessions and never calls a real model API. The keys below are made up.

Usage:
  key-reload-e2e.py [--binary PATH] [--only NAME[,NAME]] [--keep]

Exit code is 0 only when every selected case passes.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OK_TEXT = "検証OK"
OLD = "te_e2e_old_key_000000"
NEW = "te_e2e_new_key_111111"
OTHER = "te_e2e_other_key_2222"

FAILURES = {
    "revoked": (401, {"error": {"message": "Invalid API key", "code": "invalid_api_key"}}),
    "monthly": (402, {"error": {"message": "This API key has reached its monthly limit (500 of 100 credits this month)", "code": "api_key_monthly_limit_exceeded"}}),
    "balance": (402, {"error": {"message": "Insufficient credits", "code": "insufficient_credits"}}),
}


class Fake:
    """OpenAI-compatible endpoint that accepts exactly one key and fails every other one the same way."""

    def __init__(self):
        self.lock = threading.Lock()
        self.reset()

    def reset(self, accept=NEW, failure="revoked", rotate=None):
        with self.lock:
            self.accept = accept
            self.failure = failure
            self.rotate = rotate  # credentials file to rewrite with NEW on the first rejected main call
            self.keys = []  # key of every call that carried tools (the main turn)

    def plan(self, key, body):
        with self.lock:
            if body.get("tools"):
                self.keys.append(key)
            if key == self.accept:
                return None
            if self.rotate and body.get("tools"):
                # Stand-in for `te key rotate` / `/login` done in another terminal while this session runs.
                # Fires on the main turn so the retry under test is the user's own request.
                with open(self.rotate, "w") as file:
                    file.write(f"TEAI_API_KEY={NEW}\n")
                self.rotate = None
            return FAILURES[self.failure]


def handler(fake):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def do_POST(self):
            size = int(self.headers.get("content-length") or 0)
            try:
                body = json.loads(self.rfile.read(size) or b"{}")
            except ValueError:
                body = {}
            key = (self.headers.get("authorization") or "").removeprefix("Bearer ").strip()
            failed = fake.plan(key, body)
            if failed:
                data = json.dumps(failed[1]).encode()
                self.send_response(failed[0])
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            base = {"id": "chk", "object": "chat.completion.chunk", "created": 1, "model": body.get("model", "m")}
            chunks = [
                {**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": OK_TEXT}, "finish_reason": None}]},
                {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
                {**base, "choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}},
            ]
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            self.send_header("connection", "close")
            self.end_headers()
            try:
                for chunk in chunks:
                    self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode())
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            self.close_connection = True

    return Handler


class Bench:
    def __init__(self, binary, keep):
        self.command = [binary] if binary else ["bun", "run", "--cwd", os.path.join(ROOT, "packages", "sente"), "--conditions=browser", "./src/index.ts"]
        self.keep = keep
        self.root = tempfile.mkdtemp(prefix="sente-key-reload-")
        self.fake = Fake()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler(self.fake))
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.results = []
        self.count = 0

    def home(self, saved):
        """Fresh isolated HOME: a teai provider pointed at the fake server, key taken from the env like the real config."""
        self.count += 1
        home = os.path.join(self.root, f"home-{self.count}")
        project = os.path.join(home, "project")
        os.makedirs(os.path.join(home, ".config", "sente"))
        os.makedirs(os.path.join(home, ".config", "teai"))
        os.makedirs(project)
        config = {
            "model": "teai/check",
            "small_model": "teai/check",
            "autoupdate": False,
            "share": "disabled",
            "provider": {
                "teai": {
                    "name": "teai (fake)",
                    "npm": "@ai-sdk/openai-compatible",
                    "env": [],
                    "options": {"apiKey": "{env:TEAI_API_KEY}", "baseURL": self.url},
                    "models": {
                        "check": {
                            "id": "check", "name": "Check", "attachment": False, "reasoning": False, "temperature": False,
                            "tool_call": True, "release_date": "2025-01-01",
                            "limit": {"context": 100000, "output": 4000}, "cost": {"input": 0, "output": 0}, "options": {},
                        }
                    },
                }
            },
        }
        with open(os.path.join(home, ".config", "sente", "sente.json"), "w") as file:
            json.dump(config, file)
        credentials = os.path.join(home, ".config", "teai", "credentials")
        if saved:
            with open(credentials, "w") as file:
                file.write(f"TEAI_API_KEY={saved}\n")
        subprocess.run(["git", "init", "-q", project], check=False)
        return home, project, credentials

    def run(self, home, project, extra=None, timeout=240):
        keep = {key: os.environ[key] for key in ("PATH", "TERM", "TMPDIR", "SHELL") if key in os.environ}
        env = {
            **keep,
            "HOME": home,
            "XDG_CONFIG_HOME": os.path.join(home, ".config"),
            "XDG_DATA_HOME": os.path.join(home, ".local", "share"),
            "XDG_STATE_HOME": os.path.join(home, ".local", "state"),
            "XDG_CACHE_HOME": os.path.join(home, ".cache"),
            "LANG": "ja_JP.UTF-8",
            "SENTE_DISABLE_AUTOUPDATE": "1",
            **(extra or {}),
        }
        try:
            done = subprocess.run(
                [*self.command, "run", "--pure", "-m", "teai/check", "check"],
                cwd=project, env=env, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL,
            )
            return done.returncode, done.stdout + done.stderr
        except subprocess.TimeoutExpired as error:
            return -1, f"timeout after {timeout}s\n{error.stdout or ''}{error.stderr or ''}"

    def check(self, name, title, ok, detail):
        self.results.append((name, ok))
        print(f"{'✅' if ok else '❌'} {name}: {title}")
        if not ok or os.environ.get("VERBOSE"):
            for line in str(detail).strip().splitlines()[-25:]:
                print(f"     {line}")

    def close(self, failed):
        self.server.shutdown()
        if self.keep or failed:
            print(f"\n作業ディレクトリ: {self.root}")
        else:
            shutil.rmtree(self.root, ignore_errors=True)


def labels(keys):
    """Never print key material, even fake: show which key each main call carried."""
    names = {OLD: "old", NEW: "new", OTHER: "other", "": "none"}
    return [names.get(key, "unknown") for key in keys]


def case_rotated(bench):
    """Session starts with the old key; the key is rotated on disk mid-run; the turn completes on the new key."""
    for failure in ("revoked", "monthly"):
        home, project, credentials = bench.home(OLD)
        bench.fake.reset(accept=NEW, failure=failure, rotate=credentials)
        code, out = bench.run(home, project)
        seen = labels(bench.fake.keys)
        ok = code == 0 and OK_TEXT in out and seen == ["old", "new"]
        bench.check(f"rotated-{failure}", "起動後に差し替えたキーで1回だけ再送して完走する", ok, f"exit={code} main_calls={seen}\n{out}")


def case_unchanged(bench):
    """Same key on disk: no retry, the run stops with the cause instead of looping."""
    for failure, word, exit_code in (("monthly", "上限", 6), ("balance", "残高", 6), ("revoked", "Invalid API key", None)):
        home, project, _ = bench.home(OLD)
        bench.fake.reset(accept=NEW, failure=failure)
        code, out = bench.run(home, project)
        seen = labels(bench.fake.keys)
        ok = code not in (0, -1) and (exit_code is None or code == exit_code) and word in out and seen == ["old"] and OK_TEXT not in out
        bench.check(f"unchanged-{failure}", f"キーが同じなら再送せず原因を出して止まる({word})", ok, f"exit={code} main_calls={seen}\n{out}")


def case_override(bench):
    """An explicit TEAI_API_KEY that differs from the saved login is never swapped for the saved key."""
    home, project, _ = bench.home(NEW)
    bench.fake.reset(accept=NEW, failure="balance")
    code, out = bench.run(home, project, {"TEAI_API_KEY": OTHER})
    seen = labels(bench.fake.keys)
    ok = code not in (0, -1) and seen == ["other"] and OK_TEXT not in out
    bench.check("override", "明示指定したキーは保存済みキーへ勝手に差し替えない", ok, f"exit={code} main_calls={seen}\n{out}")


CASES = {"rotated": case_rotated, "unchanged": case_unchanged, "override": case_override}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--binary", help="built sente binary (default: run packages/sente from source with bun)")
    parser.add_argument("--only", help="comma-separated case names: " + ",".join(CASES))
    parser.add_argument("--keep", action="store_true", help="keep the throwaway HOME directories")
    args = parser.parse_args()
    names = args.only.split(",") if args.only else list(CASES)
    unknown = [name for name in names if name not in CASES]
    if unknown:
        parser.error(f"unknown case: {', '.join(unknown)}")
    bench = Bench(args.binary, args.keep)
    try:
        for name in names:
            CASES[name](bench)
    finally:
        failed = [name for name, ok in bench.results if not ok]
        bench.close(bool(failed) or not bench.results)
    print(f"\n{len(bench.results) - len(failed)}/{len(bench.results)} passed")
    return 1 if failed or not bench.results else 0


if __name__ == "__main__":
    sys.exit(main())

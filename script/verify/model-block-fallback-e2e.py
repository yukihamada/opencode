#!/usr/bin/env python3
"""End-to-end check: when teai says a model's upstream account is blocked, Sente moves on.

Runs the real binary against a local fake model server inside a throwaway HOME (never
touches the user's config, sessions, credits or any real model API).

  fake/blocked  always answers 503 "... is blocked at the account level ..." (teai's text)
  fake/ok       answers normally

Usage: model-block-fallback-e2e.py --binary PATH
Exit code is 0 only when every case passes.
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

OK_TEXT = "検証OK"
BLOCKED = (
    "Generation did not complete: API error (503): Upstream provider for `anthropic/claude-sonnet-5` "
    "is blocked at the account level (upstream returned 400, typically an exhausted balance or a revoked key). "
    "The route reopens automatically once a background probe succeeds; other models on unaffected providers keep working."
)


class Fake:
    def __init__(self):
        self.lock = threading.Lock()
        self.calls = {}

    def reset(self):
        with self.lock:
            self.calls = {}

    def hit(self, model, main):
        with self.lock:
            key = f"{model}:{'main' if main else 'other'}"
            self.calls[key] = self.calls.get(key, 0) + 1


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
            model = body.get("model", "?")
            fake.hit(model, bool(body.get("tools")))
            if model.startswith("anthropic/"):
                data = json.dumps({"error": {"message": BLOCKED, "type": "upstream_unavailable"}}).encode()
                self.send_response(503)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            base = {"id": "chk", "object": "chat.completion.chunk", "created": 1, "model": model}
            chunks = [
                {**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": OK_TEXT}, "finish_reason": None}]},
                {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
                {**base, "choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}},
            ]
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
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


def model(api_id):
    return {
        "id": api_id, "name": api_id, "attachment": False, "reasoning": False, "temperature": False,
        "tool_call": True, "release_date": "2025-01-01", "limit": {"context": 200000, "output": 8000},
        "cost": {"input": 0, "output": 0}, "options": {},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", required=True)
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    fake = Fake()
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler(fake))
    url = f"http://127.0.0.1:{server.server_address[1]}/v1"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    root = tempfile.mkdtemp(prefix="sente-block-")
    results = []

    def run(name, small_model, extra_env=None):
        fake.reset()
        home = os.path.join(root, name)
        project = os.path.join(home, "project")
        os.makedirs(os.path.join(home, ".config", "sente"))
        os.makedirs(project)
        config = {
            "model": "fake/blocked", "small_model": small_model, "autoupdate": False, "share": "disabled",
            "provider": {"fake": {
                "name": "Fake", "npm": "@ai-sdk/openai-compatible", "env": [],
                "options": {"apiKey": "check-key", "baseURL": url},
                "models": {"blocked": model("anthropic/claude-sonnet-5"), "ok": model("z-ai/glm-5.3-flash")},
            }},
        }
        with open(os.path.join(home, ".config", "sente", "sente.json"), "w") as f:
            json.dump(config, f)
        subprocess.run(["git", "init", "-q", project], check=False)
        keep = {k: os.environ[k] for k in ("PATH", "TERM", "TMPDIR", "SHELL") if k in os.environ}
        env = {**keep, "HOME": home, "XDG_CONFIG_HOME": os.path.join(home, ".config"),
               "XDG_DATA_HOME": os.path.join(home, ".local", "share"), "XDG_STATE_HOME": os.path.join(home, ".local", "state"),
               "XDG_CACHE_HOME": os.path.join(home, ".cache"), "LANG": "ja_JP.UTF-8", "TE_LANG": "ja",
               "SENTE_DISABLE_AUTOUPDATE": "1", "SENTE_AUTO_RESUME_BASE_MS": "50", **(extra_env or {})}
        try:
            done = subprocess.run([args.binary, "run", "--pure", "-m", "fake/blocked", "check"], cwd=project, env=env,
                                  capture_output=True, text=True, timeout=180)
            return done.returncode, done.stdout + done.stderr, dict(fake.calls)
        except subprocess.TimeoutExpired as e:
            return -1, f"timeout\n{e.stdout or ''}{e.stderr or ''}", dict(fake.calls)

    def check(name, desc, ok, detail):
        results.append((name, ok))
        print(f"{'✅' if ok else '❌'} {name}: {desc}")
        if not ok:
            print("   " + detail.replace("\n", "\n   ")[:3000])

    code, out, calls = run("fallback", "fake/ok")
    blocked = calls.get("anthropic/claude-sonnet-5:main", 0)
    check("fallback", "遮断モデルは1回で諦め、設定済みの別モデル(small_model)で完了する",
          code == 0 and OK_TEXT in out and blocked == 1 and calls.get("z-ai/glm-5.3-flash:main", 0) == 1,
          f"exit={code} calls={calls}\n{out}")

    code, out, calls = run("env-first", "fake/blocked", {"SENTE_FALLBACK_MODELS": "fake/ok"})
    check("env-first", "SENTE_FALLBACK_MODELS で代わりのモデルを指定できる",
          code == 0 and OK_TEXT in out and calls.get("z-ai/glm-5.3-flash:main", 0) == 1,
          f"exit={code} calls={calls}\n{out}")

    code, out, calls = run("no-fallback", "fake/blocked")
    blocked = calls.get("anthropic/claude-sonnet-5:main", 0)
    # 代わりが無いときは従来どおり自動再開(5回)だけ。ストリーム内の再送(各5回)はしない → 計6回。
    check("no-fallback", "代わりが無ければ同モデルの再送連打をせず止まる(1+自動再開5回=6回)",
          OK_TEXT not in out and blocked == 6, f"exit={code} calls={calls}\n{out}")

    server.shutdown()
    failed = [n for n, ok in results if not ok]
    if args.keep or failed:
        print(f"work dir: {root}")
    else:
        shutil.rmtree(root, ignore_errors=True)
    print(f"{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Check built TUI quota notices against loopback only, in isolated homes."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def run_case(binary, root, driver, lang, kind):
    case = root / f"{lang}-{kind}"
    home = case / "home"
    project = case / "project"
    project.mkdir(parents=True)
    state = home / ".local/state/sente"
    state.mkdir(parents=True)
    (state / "kv.json").write_text(json.dumps({"onboarding_completed": True}))
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            main = bool(body.get("tools"))
            calls.append({"main": main, "at": time.monotonic()})
            if main:
                self.send_response(429)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"type": "error", "error": {
                    "type": kind, "message": "Quota exceeded"}}).encode())
                return
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            chunk = {"id": "quota-fixture", "object": "chat.completion.chunk", "created": 1,
                     "model": "local", "choices": [{"index": 0, "delta": {
                         "content": "Quota verification"}, "finish_reason": "stop"}]}
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\ndata: [DONE]\n\n").encode())

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    config = {
        "model": "sente/local", "small_model": "sente/local", "autoupdate": False, "share": "disabled",
        "enabled_providers": ["sente"],
        "provider": {"sente": {"npm": "@ai-sdk/openai-compatible", "env": [],
            "options": {"apiKey": "fixture", "baseURL": f"http://127.0.0.1:{server.server_port}/v1"},
            "models": {"local": {"name": "Fixture", "tool_call": True,
                "limit": {"context": 100000, "output": 1000}}}}},
    }
    (project / "sente.json").write_text(json.dumps(config))
    env = {key: os.environ[key] for key in ("PATH", "SHELL", "TMPDIR") if key in os.environ}
    env.update({"HOME": str(home), "SENTE_TEST_HOME": str(home), "PWD": str(project),
                "LANG": "ja_JP.UTF-8" if lang == "ja" else "en_US.UTF-8", "TE_LANG": lang,
                "TERM": "xterm-256color", "COLUMNS": "120", "LINES": "40", "NO_KOE": "1",
                "AGENT_KOE": "0", "SENTE_DISABLE_AUTOUPDATE": "1", "SENTE_DISABLE_MODELS_FETCH": "1"})
    for key, suffix in [("XDG_CONFIG_HOME", ".config"), ("XDG_DATA_HOME", ".local/share"),
                        ("XDG_STATE_HOME", ".local/state"), ("XDG_CACHE_HOME", ".cache")]:
        env[key] = str(home / suffix)
    tui = driver.Tui([binary, str(project), "--pure", "--prompt", "verify quota notice"],
                     env, str(project), str(project))
    try:
        label = "設定を開く" if lang == "ja" else "open settings"
        deadline = time.monotonic() + 60
        while label not in tui.screen() and time.monotonic() < deadline:
            tui.drain(0.2)
        assert label in tui.screen(), f"{case.name}: missing dialog action"
        screen = tui.screen()
        title = ("無料利用の上限に達しました" if kind == "FreeUsageLimitError" else "利用上限に達しました") if lang == "ja" else (
            "Free usage limit reached" if kind == "FreeUsageLimitError" else "Usage limit reached")
        assert title in screen, f"{case.name}: missing title"
        assert re.search("自動再試行を停止しました" if lang == "ja" else r"Automatic\s+retries\s+stopped\.", screen)
        if kind == "GoUsageLimitError":
            assert ("解除時刻は未確認です" if lang == "ja" else "Reset time is unknown.") in screen
        assert "/undefined/" not in screen and "reset in ." not in screen
        (case / "dialog.txt").write_text(screen)
        # Dismiss only: never activate a settings link or a purchase action.
        tui.send(b"\x1b")
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            tui.drain(0.2)
        main_calls = sum(call["main"] for call in calls)
        assert main_calls == 1, f"{case.name}: {main_calls} main requests"
        titles = re.findall(r"\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)", tui.buf.decode("utf-8", "replace"))
        assert titles and not titles[-1].startswith(("●", "↻")), f"{case.name}: still busy {titles}"
        result = {"case": case.name, "ok": True, "main_requests": main_calls,
                  "observation_seconds": 35, "last_title": titles[-1], "dialog": str(case / "dialog.txt")}
        (case / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
        return result
    finally:
        (case / "terminal.raw").write_bytes(tui.buf)
        (case / "calls.json").write_text(json.dumps(calls))
        tui.kill()
        server.shutdown()
        server.server_close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True)
    parser.add_argument("--root", required=True)
    args = parser.parse_args()
    root = Path(args.root).resolve()
    root.mkdir(parents=True, exist_ok=False)
    spec = importlib.util.spec_from_file_location("pty_driver", Path(__file__).with_name("output-limit-pty.py"))
    driver = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(driver)
    # PTY fork/exec runs sequentially to avoid forking multiple worker threads.
    results = [run_case(str(Path(args.binary).resolve()), root, driver, lang, kind)
               for lang in ("ja", "en") for kind in ("FreeUsageLimitError", "GoUsageLimitError")]
    (root / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Verify real terminal OSC titles using an isolated CLI and a loopback model."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


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
    results = []

    for case, badge in [("done", "✅ 完了"), ("abort", "⏸ 停止"), ("error", "🔴 エラー"),
                        ("permission", "⏳ 確認待ち"), ("question", "⏳ 回答待ち"), ("retry", "↻ 再試行")]:
        current = case

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                main_request = bool(body.get("tools"))
                if main_request and current in ("error", "retry"):
                    self.send_response(400 if current == "error" else 429)
                    self.send_header("content-type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": {"message": "local title fixture"}}).encode())
                    return
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.end_headers()

                def chunk(delta, finish=None):
                    data = {"id": "title-fixture", "object": "chat.completion.chunk", "created": 1,
                            "model": "local", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                    self.wfile.write(("data: " + json.dumps(data) + "\n\n").encode())
                    self.wfile.flush()

                try:
                    if not main_request:
                        chunk({"content": "Title verification"}, "stop")
                    elif current in ("permission", "question"):
                        tools = [tool["function"]["name"] for tool in body["tools"]]
                        tool = "question" if current == "question" else ("bash" if "bash" in tools else "shell")
                        params = {"questions": [{"question": "Continue?", "header": "Fixture", "options": [
                            {"label": "Yes", "description": "Continue fixture"}]}]} if current == "question" else {
                                "command": "pwd", "description": "Local title fixture"}
                        chunk({"tool_calls": [{"index": 0, "id": "call_title", "type": "function", "function": {
                            "name": tool, "arguments": json.dumps(params)}}]})
                        chunk({}, "tool_calls")
                    else:
                        chunk({"content": "TITLE_FIXTURE "})
                        time.sleep(15 if current == "abort" else 1)
                        chunk({"content": "DONE"}, "stop")
                    self.wfile.write(b"data: [DONE]\n\n")
                except (BrokenPipeError, ConnectionResetError):
                    pass  # The abort case intentionally closes the stream.

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        home = root / case / "home"
        project = root / case / "project"
        project.mkdir(parents=True)
        state = home / ".local/state/sente"
        state.mkdir(parents=True)
        (state / "kv.json").write_text(json.dumps({"onboarding_completed": True}))
        config = {
            "model": "fake/local", "small_model": "fake/local", "autoupdate": False, "share": "disabled",
            "permission": {"*": "allow", "bash": "ask", "shell": "ask"},
            "provider": {"fake": {"npm": "@ai-sdk/openai-compatible", "env": [],
                "options": {"apiKey": "fixture", "baseURL": f"http://127.0.0.1:{server.server_port}/v1"},
                "models": {"local": {"name": "Fixture", "tool_call": True,
                    "limit": {"context": 100000, "output": 1000}}}}},
        }
        (project / "sente.json").write_text(json.dumps(config))
        env = {key: os.environ[key] for key in ("PATH", "SHELL", "TMPDIR") if key in os.environ}
        env.update({"HOME": str(home), "SENTE_TEST_HOME": str(home), "PWD": str(project),
                    "LANG": "ja_JP.UTF-8", "TE_LANG": "ja", "TERM": "xterm-256color",
                    "COLUMNS": "120", "LINES": "40", "NO_KOE": "1", "AGENT_KOE": "0",
                    "SENTE_DISABLE_AUTOUPDATE": "1", "SENTE_DISABLE_MODELS_FETCH": "1"})
        for key, suffix in [("XDG_CONFIG_HOME", ".config"), ("XDG_DATA_HOME", ".local/share"),
                            ("XDG_STATE_HOME", ".local/state"), ("XDG_CACHE_HOME", ".cache")]:
            env[key] = str(home / suffix)

        def titles(tui):
            return re.findall(r"\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)", tui.buf.decode("utf-8", "replace"))

        def wait_title(tui, text):
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline:
                tui.drain(0.2)
                latest = titles(tui)
                if latest and latest[-1].startswith(text):
                    return
            raise AssertionError(f"{case}: missing {text}; titles={titles(tui)}")

        cmd = [str(Path(args.binary).resolve()), str(project), "--pure", "--prompt", "verify terminal title"]
        tui = driver.Tui(cmd, env, str(project), str(project))
        try:
            wait_title(tui, "● 実行中")
            if case == "abort":
                tui.read_until(b"TITLE_FIXTURE", 20)
                tui.send(b"\x1b", settle=0.3)
                tui.send(b"\x1b", settle=0.3)
            wait_title(tui, badge)
            results.append({"case": case, "titles": titles(tui), "ok": True})
            print(json.dumps(results[-1], ensure_ascii=False), flush=True)
        finally:
            (root / case / "terminal.raw").write_bytes(tui.buf)
            tui.kill()
            server.shutdown()
        if case in ("done", "abort", "error"):
            restored = driver.Tui([cmd[0], str(project), "--pure", "--continue"], env, str(project), str(project))
            try:
                wait_title(restored, badge)
                results.append({"case": case + "-restored", "titles": titles(restored), "ok": True})
                print(json.dumps(results[-1], ensure_ascii=False), flush=True)
            finally:
                (root / case / "restored.raw").write_bytes(restored.buf)
                restored.kill()
    (root / "report.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

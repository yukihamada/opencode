#!/usr/bin/env python3
"""Real packaged TUI -> loopback email login -> exit -> fresh-process restoration."""
import http.server
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import threading
import time

binary = str(Path(sys.argv[1]).resolve())
session_token = "fixture-session-token"
key = "te_durable_fixture_12345678"
calls = []

class API(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_GET(self):
        calls.append(self.path)
        self.reply({"authenticated": self.headers.get("Authorization") == "Bearer " + key,
                    "email": "fixture@example.com", "credits_remaining": 0})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        calls.append(self.path)
        if self.path == "/api/v1/auth/email" and body.get("email") == "fixture@example.com":
            self.reply({"ok": True})
        elif self.path == "/api/v1/auth/verify" and body.get("code") == "123456":
            self.reply({"ok": True, "token": session_token, "email": "fixture@example.com"})
        elif self.path == "/api/v1/apikeys" and self.headers.get("Authorization") == "Bearer " + session_token:
            self.reply({"ok": True, "api_key": key})
        else:
            self.reply({"error": "unexpected request"}, 400)

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), API)
threading.Thread(target=server.serve_forever, daemon=True).start()
socket = "sente-release-" + str(os.getpid())

def tmux(*args, check=True):
    return subprocess.run(["tmux", "-L", socket, *args], capture_output=True, text=True, check=check)

def wait_for(text):
    end = time.monotonic() + 45
    screen = ""
    while time.monotonic() < end:
        screen = tmux("capture-pane", "-p", "-t", "login:0.0", check=False).stdout
        if text in screen:
            return
        time.sleep(0.3)
    raise AssertionError("Missing " + text + "\n" + screen[-2000:])

def send(text):
    tmux("send-keys", "-t", "login:0.0", "-l", text)
    tmux("send-keys", "-t", "login:0.0", "Enter")

try:
    with tempfile.TemporaryDirectory(prefix="sente-release-") as directory:
        home = Path(directory)
        conf = home / "teai"
        conf.mkdir()
        state = home / "state/sente"
        state.mkdir(parents=True)
        (state / "kv.json").write_text('{"onboarding_completed":true}')
        env = {k: v for k, v in os.environ.items() if not k.startswith(("SENTE", "OPENCODE", "TEAI", "TE_CONFIG", "TMUX"))}
        env.update(HOME=directory, TE_CONFIG_DIR=str(conf), SENTE_TEST_HOME=directory, LANG="en_US.UTF-8", LC_ALL="C.UTF-8",
                   XDG_CONFIG_HOME=str(home / "config"), XDG_DATA_HOME=str(home / "data"),
                   XDG_STATE_HOME=str(home / "state"), XDG_CACHE_HOME=str(home / "cache"),
                   SENTE_DISABLE_PROJECT_CONFIG="1", SENTE_DISABLE_CLAUDE_CODE="1", SENTE_DISABLE_EXTERNAL_SKILLS="1",
                   SENTE_DISABLE_DEFAULT_PLUGINS="1", SENTE_PURE="1", SENTE_DISABLE_AUTOUPDATE="1",
                   TEAI_API=f"http://127.0.0.1:{server.server_port}", TERM="xterm-256color",
                   SENTE_CONFIG_CONTENT=json.dumps({"provider": {"teai": {"npm": "@ai-sdk/openai-compatible",
                       "options": {"apiKey": "{env:TEAI_API_KEY}", "baseURL": f"http://127.0.0.1:{server.server_port}/v1"},
                       "models": {"fixture": {"name": "fixture"}}}}, "model": "teai/fixture", "plugin": [], "mcp": {}}))
        command = shlex.join(["env", "-i", *[k + "=" + v for k, v in env.items()], binary])
        tmux("new-session", "-d", "-s", "login", "-x", "120", "-y", "38", "-c", directory, command)
        time.sleep(5)
        send("/login")
        wait_for("Log in to teai.io")
        send("fixture@example.com")
        wait_for("Check your email")
        send("123456")
        wait_for("Logged in as")
        assert (conf / "credentials").read_text().strip() == "TEAI_API_KEY=" + key
        send("/account")
        wait_for("Logged in")
        wait_for("Insufficient credits")
        tmux("send-keys", "-t", "login:0.0", "Escape")
        time.sleep(0.5)
        send("/exit")
        end = time.monotonic() + 15
        while tmux("has-session", "-t", "login", check=False).returncode == 0:
            assert time.monotonic() < end, "TUI failed to exit"
            time.sleep(0.2)
        for _ in range(2):
            result = subprocess.run([binary, "debug", "config"], env=env, cwd=home, capture_output=True, text=True, timeout=45)
            assert result.returncode == 0, result.stderr[-1000:]
            assert json.loads(result.stdout)["provider"]["teai"]["options"]["apiKey"] == key
        assert calls.count("/api/v1/apikeys") == 1, "key creation must not repeat on restart"
        assert (conf / "credentials").stat().st_mode & 0o777 == 0o600
        print("PASS: email -> durable key -> /account (authenticated, zero credits) -> /exit -> two fresh processes")
finally:
    tmux("kill-server", check=False)
    server.shutdown()

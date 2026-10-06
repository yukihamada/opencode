#!/usr/bin/env python3
"""End-to-end check of a built Sente binary: cost gate, automatic resume, sidebar.

Runs the real binary against a local fake model server inside a throwaway HOME,
so it never touches the user's config, sessions, credits or any real model API.

Usage:
  cost-resume-e2e.py [--binary PATH] [--only NAME[,NAME]] [--keep] [--list]

Exit code is 0 only when every selected case passes. TUI screens are saved as
plain text under the work directory (printed at the end; kept with --keep or on failure).
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OK_TEXT = "検証OK"
LONG_TODO = "KOEで音声を制作し、再生・認識検証と本人確認用の成果物を渡すところまで一気に進める"


class Fake:
    """Scripted OpenAI-compatible chat endpoint. Only calls that carry tools count as main calls."""

    def __init__(self):
        self.lock = threading.Lock()
        self.reset()

    def reset(self, fail=0, status=503, todo=False, hold=0.0):
        with self.lock:
            self.fail = fail  # main calls to fail before succeeding (-1 = always)
            self.status = status
            self.todo = todo  # first main call answers with a todowrite tool call
            self.hold = hold  # seconds to keep each successful main call open
            self.main = 0
            self.other = 0

    def plan(self, body):
        with self.lock:
            if not body.get("tools"):
                self.other += 1
                return ("text", "check")
            self.main += 1
            if self.fail != 0:
                if self.fail > 0:
                    self.fail -= 1
                return ("error", self.status)
            if self.todo:
                self.todo = False
                return ("todo", None)
            return ("text", OK_TEXT)


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
            kind, value = fake.plan(body)
            if kind == "error":
                data = json.dumps({"error": {"message": "service unavailable" if value >= 500 else "invalid api key", "type": "error"}}).encode()
                self.send_response(value)
                self.send_header("content-type", "application/json")
                self.send_header("retry-after-ms", "20")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            base = {"id": "chk", "object": "chat.completion.chunk", "created": 1, "model": body.get("model", "m")}
            if kind == "todo":
                todos = [
                    {"content": "素材と前提を確認する", "status": "completed", "priority": "high"},
                    {"content": LONG_TODO, "status": "in_progress", "priority": "high"},
                    {"content": "結果を報告する", "status": "pending", "priority": "medium"},
                ]
                call = {"index": 0, "id": "call_todo", "type": "function", "function": {"name": "todowrite", "arguments": json.dumps({"todos": todos}, ensure_ascii=False)}}
                chunks = [
                    {**base, "choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [call]}, "finish_reason": None}]},
                    {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]},
                ]
            else:
                chunks = [
                    {**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": value}, "finish_reason": None}]},
                    {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
                ]
            chunks.append({**base, "choices": [], "usage": {"prompt_tokens": 197665, "completion_tokens": 12, "total_tokens": 197677}})
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            self.send_header("connection", "close")
            self.end_headers()
            try:
                if kind == "text" and body.get("tools") and fake.hold:
                    time.sleep(fake.hold)
                for chunk in chunks:
                    self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode())
                    self.wfile.flush()
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            self.close_connection = True

    return Handler


class Bench:
    def __init__(self, binary, keep):
        self.binary = binary
        self.keep = keep
        self.root = tempfile.mkdtemp(prefix="sente-check-")
        self.fake = Fake()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler(self.fake))
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.results = []
        self.count = 0

    def home(self, permission=None):
        """Fresh isolated HOME with one expensive fake model, so each case starts from nothing."""
        self.count += 1
        home = os.path.join(self.root, f"home-{self.count}")
        project = os.path.join(home, "project")
        os.makedirs(os.path.join(home, ".config", "sente"))
        os.makedirs(project)
        config = {
            "$schema": "https://teai.io/sente/config.json",
            "model": "fake/pricey",
            "small_model": "fake/pricey",
            "autoupdate": False,
            "share": "disabled",
            "provider": {
                "fake": {
                    "name": "Fake",
                    "npm": "@ai-sdk/openai-compatible",
                    "env": [],
                    "options": {"apiKey": "check-key", "baseURL": self.url},
                    "models": {
                        "pricey": {
                            "id": "pricey",
                            "name": "Pricey",
                            "attachment": False,
                            "reasoning": False,
                            "temperature": False,
                            "tool_call": True,
                            "release_date": "2025-01-01",
                            # a small request is estimated at about $5.40: (request + 20k margin) * $30/M + 32k * $150/M
                            "limit": {"context": 1000000, "output": 32000},
                            "cost": {"input": 30, "output": 150},
                            "options": {},
                        }
                    },
                }
            },
        }
        if permission:
            config["permission"] = permission
        with open(os.path.join(home, ".config", "sente", "sente.json"), "w") as file:
            json.dump(config, file)
        subprocess.run(["git", "init", "-q", project], check=False)
        return home, project

    def env(self, home, extra=None):
        keep = {key: os.environ[key] for key in ("PATH", "TERM", "TMPDIR", "SHELL") if key in os.environ}
        env = {
            **keep,
            "HOME": home,
            "XDG_CONFIG_HOME": os.path.join(home, ".config"),
            "XDG_DATA_HOME": os.path.join(home, ".local", "share"),
            "XDG_STATE_HOME": os.path.join(home, ".local", "state"),
            "XDG_CACHE_HOME": os.path.join(home, ".cache"),
            "LANG": "ja_JP.UTF-8",
            "TE_LANG": "ja",
            "TERM": keep.get("TERM", "xterm-256color"),
            "SENTE_DISABLE_AUTOUPDATE": "1",
        }
        env.update(extra or {})
        return env

    def run(self, extra=None, permission=None, timeout=180):
        home, project = self.home(permission)
        try:
            done = subprocess.run(
                [self.binary, "run", "--pure", "-m", "fake/pricey", "check"],
                cwd=project, env=self.env(home, extra), capture_output=True, text=True, timeout=timeout,
                # `run` reads piped stdin as part of the message; never let it wait on ours.
                stdin=subprocess.DEVNULL,
            )
            return done.returncode, done.stdout + done.stderr
        except subprocess.TimeoutExpired as error:
            return -1, f"timeout after {timeout}s\n{error.stdout or ''}{error.stderr or ''}"

    def tui(self, name, wait, extra=None, timeout=90, width=150, height=45):
        """Start the real TUI in a detached tmux pane, wait for `wait(screen)`, and return the screen text."""
        home, project = self.home()
        socket = f"sente-check-{os.getpid()}-{self.count}"
        env = self.env(home, extra)
        cmd = ["tmux", "-L", socket, "new-session", "-d", "-s", "check", "-x", str(width), "-y", str(height)]
        for key, value in env.items():
            cmd += ["-e", f"{key}={value}"]
        cmd += ["-c", project, self.binary, "--pure", "-m", "fake/pricey", "--prompt", "check"]
        subprocess.run(cmd, check=True, env=env)
        screen = ""
        deadline = time.time() + timeout
        sent = False
        try:
            while time.time() < deadline:
                time.sleep(0.5)
                shot = subprocess.run(["tmux", "-L", socket, "capture-pane", "-p", "-t", "check"], capture_output=True, text=True)
                if shot.returncode != 0:
                    break
                screen = shot.stdout
                # --prompt only fills the input box; submit it once the TUI has drawn.
                if not sent and "check" in screen:
                    time.sleep(1)
                    subprocess.run(["tmux", "-L", socket, "send-keys", "-t", "check", "Enter"])
                    sent = True
                if sent and wait(screen):
                    break
        finally:
            subprocess.run(["tmux", "-L", socket, "kill-server"], capture_output=True)
        path = os.path.join(self.root, f"screen-{name}.txt")
        with open(path, "w") as file:
            file.write(screen)
        return screen, path

    def check(self, name, title, ok, detail):
        self.results.append((name, ok))
        print(f"{'✅' if ok else '❌'} {name}: {title}")
        if not ok or os.environ.get("VERBOSE"):
            for line in str(detail).strip().splitlines()[-25:]:
                print(f"     {line}")

    def close(self, failed):
        self.server.shutdown()
        if self.keep or failed:
            print(f"\n作業ディレクトリ(画面の控えあり): {self.root}")
        else:
            shutil.rmtree(self.root, ignore_errors=True)


def sidebar(screen, start=80):
    """Right-hand part of each row, where the sidebar is drawn. Wide (Japanese) characters take two
    columns but one string index, so cut generously and match on content rather than exact columns."""
    return "\n".join(line[start:] for line in screen.splitlines())


def cases(bench):
    fake = bench.fake

    def gate_off():
        fake.reset()
        code, out = bench.run()
        bench.check("gate-off", "上限未設定なら高額モデルでも確認なしで実行する", code == 0 and fake.main == 1 and OK_TEXT in out, f"exit={code} main={fake.main}\n{out}")

    def gate_on():
        fake.reset()
        code, out = bench.run({"SENTE_COST_LIMIT_USD": "1"}, timeout=60)
        bench.check("gate-on", "SENTE_COST_LIMIT_USD=1 を設定すると、呼び出す前に止まる", fake.main == 0 and OK_TEXT not in out, f"exit={code} main={fake.main}\n{out}")

    def gate_high():
        fake.reset()
        code, out = bench.run({"SENTE_COST_LIMIT_USD": "50"})
        bench.check("gate-high", "上限が見積より高ければ確認なしで実行する", code == 0 and fake.main == 1 and OK_TEXT in out, f"exit={code} main={fake.main}\n{out}")

    def gate_settles():
        # Each call is estimated at about $5.40. Two calls plus the title call would be $16 if finished
        # calls kept counting at their estimate; they must drop to their recorded cost instead.
        fake.reset(todo=True)
        code, out = bench.run({"SENTE_COST_LIMIT_USD": "12"})
        bench.check("gate-settles", "終わった呼び出しは見積ではなく実費で数えるので、上限 $12 でも続けて実行できる", code == 0 and fake.main == 2 and OK_TEXT in out, f"exit={code} main={fake.main} (期待 2)\n{out}")

    def gate_allow():
        fake.reset()
        code, out = bench.run({"SENTE_COST_LIMIT_USD": "1"}, permission={"request_cost": "allow"})
        bench.check("gate-allow", "上限あり + 設定で request_cost: allow なら確認なしで実行する", code == 0 and fake.main == 1 and OK_TEXT in out, f"exit={code} main={fake.main}\n{out}")

    def resume():
        # 1 call + 5 built-in retries all fail, then the automatic resume succeeds on the 7th call.
        fake.reset(fail=6)
        code, out = bench.run({"SENTE_AUTO_RESUME_BASE_MS": "200"})
        bench.check("resume", "503 が続いて止まっても、自動で再開して完了する", code == 0 and fake.main == 7 and OK_TEXT in out, f"exit={code} main={fake.main} (期待 7)\n{out}")

    def resume_limit():
        fake.reset(fail=-1)
        code, out = bench.run({"SENTE_AUTO_RESUME_BASE_MS": "50"}, timeout=240)
        # (1 call + 5 retries) x (1 original + 5 resumes)
        bench.check("resume-limit", "直らないエラーは5回再開したところで止まる", fake.main == 36 and OK_TEXT not in out, f"exit={code} main={fake.main} (期待 36)\n{out}")

    def no_resume():
        fake.reset(fail=-1, status=401)
        code, out = bench.run({"SENTE_AUTO_RESUME_BASE_MS": "50"}, timeout=60)
        bench.check("no-resume", "認証エラー(401)は再開しない", fake.main == 1 and OK_TEXT not in out, f"exit={code} main={fake.main} (期待 1)\n{out}")

    def tui_sidebar():
        fake.reset(todo=True)
        screen, path = bench.tui("sidebar", lambda shot: OK_TEXT in shot and "今回の使用" in shot and "[✓]" in shot)
        side = sidebar(screen)
        order = [side.find(word) for word in ("進捗", "今回の使用", "残高")]
        lines = side.splitlines()
        current = [index for index, line in enumerate(lines) if "[•]" in line]
        problems = []
        if -1 in order or order != sorted(order):
            problems.append(f"並び順が 進捗→今回の使用→残高 でない: {order}")
        for word in ("費用 $", "1/3 項目完了", "使用 197,677 / 残り 802,323"):
            if word not in side:
                problems.append(f"「{word}」が無い")
        if not re.search(r"文脈 █+░+ 20%", side):
            problems.append("文脈のバー表示(20%)が無い")
        for word in ("累計使用", "サブスク残量とは別", "LSPs are disabled", "会話のトークン枠"):
            if word in screen:
                problems.append(f"消したはずの「{word}」が出ている")
        if not current or "[ ]" not in lines[current[-1] + 1]:
            problems.append("一覧の実行中の項目が1行に収まっていない")
        if "request_cost" in screen or "実行費用の確認" in screen:
            problems.append("費用確認が出ている")
        bench.check("tui-sidebar", "実画面の右側が新しい並びと表示になっている", not problems, "\n".join(problems) + f"\n画面: {path}\n" + side)

    def tui_retry():
        fake.reset(fail=6)
        screen, path = bench.tui("retry", lambda shot: "再試行待ち" in sidebar(shot) and "回目" in sidebar(shot), {"SENTE_AUTO_RESUME_BASE_MS": "8000"})
        side = sidebar(screen)
        bench.check("tui-retry", "再開待ちの間、右側に「再試行待ち（n回目）」と出る", "再試行待ち（" in side and "回目）" in side, f"画面: {path}\n{side}")

    return {
        "gate-off": gate_off,
        "gate-on": gate_on,
        "gate-high": gate_high,
        "gate-settles": gate_settles,
        "gate-allow": gate_allow,
        "resume": resume,
        "resume-limit": resume_limit,
        "no-resume": no_resume,
        "tui-sidebar": tui_sidebar,
        "tui-retry": tui_retry,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--binary", default=os.path.expanduser("~/.opencode/bin/opencode"))
    parser.add_argument("--only", default="")
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()
    bench = Bench(os.path.abspath(args.binary), args.keep)
    table = cases(bench)
    if args.list:
        print("\n".join(table))
        bench.close(False)
        return 0
    wanted = [name for name in args.only.split(",") if name] or list(table)
    unknown = [name for name in wanted if name not in table]
    if unknown:
        print(f"unknown case: {', '.join(unknown)} (available: {', '.join(table)})")
        bench.close(False)
        return 2
    version = subprocess.run([bench.binary, "--version"], capture_output=True, text=True).stdout.strip().splitlines()[-1:]
    print(f"対象: {bench.binary} ({''.join(version)})\n")
    for name in wanted:
        try:
            table[name]()
        except Exception as error:  # a broken case must not hide the others
            bench.check(name, "実行できなかった", False, repr(error))
    failed = [name for name, ok in bench.results if not ok]
    print(f"\n{len(bench.results) - len(failed)}/{len(bench.results)} 件 成功" + (f"・失敗: {', '.join(failed)}" if failed else ""))
    bench.close(bool(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

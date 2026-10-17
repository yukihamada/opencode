#!/usr/bin/env python3
"""PTY driver for the real Sente TUI against the local output-limit fixture.

Launches `bun run ./src/index.ts` (source build) in a pty with an isolated
XDG home, sends keystrokes, and captures the screen. No real model API is
contacted; the only LLM endpoint is the 127.0.0.1 fixture server.

Usage:
  output-limit-pty.py --case partial|empty|abort --workdir DIR [--binary CMD...]

Writes <workdir>/screen-<case>.txt (ANSI-stripped final screen) and
<workdir>/transcript-<case>.raw.
"""
import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import time

import pty
import select

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]|\x1b[=>]|\r")


def strip(text: str) -> str:
    text = ANSI.sub("", text)
    text = text.replace("\x1b", "")
    return "\n".join(line.rstrip() for line in text.splitlines() if line.strip())


class Tui:
    def __init__(self, cmd, env, cwd, chdir):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            # chdir to the package dir so bun loads its bunfig.toml preload
            # (required for the solid JSX transform), then let the CLI itself
            # chdir into the isolated project directory.
            os.chdir(chdir)
            os.execvpe(cmd[0], cmd, env)
        self.buf = b""
        self.answered = set()

    def read_until(self, needle: bytes, timeout: float, mark: int = 0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            r, _, _ = select.select([self.fd], [], [], 0.2)
            if r:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                self.buf += data
                # answer terminal capability queries so the TUI finishes
                # negotiating input modes (kitty keyboard, XTGETTCAP, DSR)
                self.answer_queries()
            if needle in self.buf[mark:]:
                return True
        return needle in self.buf[mark:]

    def drain(self, timeout: float = 0.2):
        """Read any pending output without blocking long."""
        r, _, _ = select.select([self.fd], [], [], timeout)
        if r:
            try:
                data = os.read(self.fd, 65536)
                if data:
                    self.buf += data
                    self.answer_queries()
            except OSError:
                pass

    def answer_queries(self):
        replies = {
            b"\x1b[?u": b"\x1b[?0u",  # kitty keyboard flags query: unsupported
            b"\x1bP+q4d73\x1b\\": b"\x1bP0+r\x1b\\",  # XTGETTCAP: invalid
            b"\x1b[?1016$p": b"\x1b[?1016;0$y",
            b"\x1b[?2027$p": b"\x1b[?2027;0$y",
            b"\x1b[?2031$p": b"\x1b[?2031;0$y",
            b"\x1b[?1004$p": b"\x1b[?1004;0$y",
            b"\x1b[?2004$p": b"\x1b[?2004;0$y",
            b"\x1b[?2026$p": b"\x1b[?2026;0$y",
            b"\x1b]10;?\x07": b"\x1b]10;rgb:ee/ee/ee\x07",
            b"\x1b]11;?\x07": b"\x1b]11;rgb:00/00/00\x07",
            b"\x1b[6n": b"\x1b[1;1R",
            b"\x1b[>0q": b"\x1bP0|0\x1b\\",
            b"\x1b]1337;Capabilities\x1b\\": b"",
            b"\x1b]99;i=opentui-notifications:p=?\x1b\\": b"",
        }
        for query, reply in replies.items():
            if query in self.buf and query not in self.answered:
                self.answered.add(query)
                if reply:
                    try:
                        os.write(self.fd, reply)
                    except OSError:
                        pass

    def send(self, data: bytes, settle=0.4):
        os.write(self.fd, data)
        time.sleep(settle)

    def type_text(self, text: str):
        # bracketed paste to avoid per-key autocomplete interference
        self.send(b"\x1b[200~" + text.encode() + b"\x1b[201~")

    def screen(self) -> str:
        return strip(self.buf.decode("utf-8", "replace"))

    def kill(self):
        try:
            os.write(self.fd, b"\x03")  # ctrl-c
            time.sleep(0.3)
            os.kill(self.pid, 9)
        except (ProcessLookupError, OSError):
            pass
        try:
            os.waitpid(self.pid, 0)
        except ChildProcessError:
            pass


def find_db(home: str) -> str:
    """Locate the sente-local.db under the isolated XDG home."""
    for root, _, files in os.walk(os.path.join(home, "share")):
        for f in files:
            if f == "sente-local.db":
                return os.path.join(root, f)
    raise FileNotFoundError("sente-local.db not found under " + home)


def check_abort_evidence(home: str, session_id_hint: str | None = None) -> tuple[bool, str]:
    """Verify the abort left positive evidence in the isolated DB.

    Returns (ok, detail). Requires:
    - an assistant message with error.name == "MessageAbortedError"
    - that message has time.completed set (turn closed, not stuck)
    """
    db = find_db(home)
    conn = sqlite3.connect(db)
    try:
        rows = conn.execute(
            "SELECT id, json_extract(data,'$.error.name'), json_extract(data,'$.time.completed') "
            "FROM message WHERE json_extract(data,'$.role') = 'assistant' "
            "ORDER BY time_created DESC LIMIT 5"
        ).fetchall()
        for mid, err_name, completed in rows:
            if err_name == "MessageAbortedError":
                if completed:
                    return True, f"MessageAbortedError found on {mid} completed={completed}"
                return False, f"MessageAbortedError on {mid} but time.completed is empty"
        return False, f"no MessageAbortedError in recent assistant messages: {rows}"
    finally:
        conn.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", required=True, choices=["partial", "empty", "abort"])
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--binary", nargs="+", required=True)
    ap.add_argument("--ready-timeout", type=float, default=90)
    args = ap.parse_args()

    workdir = os.path.abspath(args.workdir)
    state = os.path.join(workdir, "fixture")
    with open(os.path.join(state, "port")) as f:
        port = int(f.read().strip())

    home = os.path.join(workdir, f"home-{args.case}")
    for sub in ("share", "cache", "config", "state"):
        os.makedirs(os.path.join(home, sub), exist_ok=True)
    os.makedirs(os.path.join(home, "fakehome"), exist_ok=True)

    config = {
        "$schema": "https://teai.io/sente/config.json",
        "model": "fixture/fixture-model",
        "small_model": "fixture/fixture-model",
        "provider": {
            "fixture": {
                "name": "Fixture",
                "id": "fixture",
                "env": [],
                "npm": "@ai-sdk/openai-compatible",
                "models": {
                    "fixture-model": {
                        "id": "fixture-model",
                        "name": "Fixture Model",
                        "attachment": False,
                        "reasoning": False,
                        "temperature": False,
                        "tool_call": True,
                        "release_date": "2025-01-01",
                        "limit": {"context": 100000, "output": 10000},
                        "cost": {"input": 0, "output": 0},
                        "options": {},
                    }
                },
                "options": {"apiKey": "fixture-key", "baseURL": f"http://127.0.0.1:{port}/v1"},
            }
        },
    }
    project = os.path.join(workdir, f"project-{args.case}")
    os.makedirs(project, exist_ok=True)
    with open(os.path.join(project, "sente.json"), "w") as f:
        json.dump(config, f)

    env = dict(os.environ)
    env.update(
        {
            "XDG_DATA_HOME": os.path.join(home, "share"),
            "XDG_CACHE_HOME": os.path.join(home, "cache"),
            "XDG_CONFIG_HOME": os.path.join(home, "config"),
            "XDG_STATE_HOME": os.path.join(home, "state"),
            "SENTE_DISABLE_AUTOUPDATE": "true",
            "SENTE_DISABLE_MODELS_FETCH": "true",
            "SENTE_DISABLE_MOUSE": "true",
            "SENTE_DISABLE_MOUSE_MOTION": "true",
            "SENTE_TEST_HOME": os.path.join(home, "fakehome"),
            "SENTE_PURE": "1",
            "SENTE_LANGUAGE": "en",
            "TERM": "xterm-256color",
            "COLUMNS": "120",
            "LINES": "40",
        }
    )
    for key in ("SENTE_CONFIG", "OPENCODE_CONFIG", "SENTE_BARE", "TEAI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
        env.pop(key, None)

    # queue the first reply for this case
    first = {
        "partial": {"text": "PARTIAL-ANSWER-START " + "x" * 60, "finish": "length", "usage": {"input": 100, "output": 32000}},
        "empty": {"text": "", "finish": "length", "usage": {"input": 100, "output": 32000}},
        # long delay so the user can interrupt mid-stream; the abort case
        # asserts the turn is cancelled before this delay elapses
        "abort": {"text": "ABORT-SHOULD-NEVER-STREAM", "finish": "stop", "delayMs": 30000},
    }[args.case]
    with open(os.path.join(state, "queue.json"), "w") as f:
        json.dump([first], f)
    subprocess.run(
        ["curl", "-s", "-X", "POST", f"http://127.0.0.1:{port}/control/reload"], check=True, capture_output=True
    )

    # launch from packages/sente so bun picks up its bunfig.toml preload
    # (solid JSX transform); the CLI chdirs into the project dir itself
    chdir = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "packages", "sente"))
    binary = [os.path.abspath(part) if part.startswith(".") else part for part in args.binary]
    binary.append(project)
    tui = Tui(binary, env, project, chdir=chdir)
    transcript = os.path.join(workdir, f"transcript-{args.case}.raw")
    ok = True
    try:
        # wait until the prompt box is up and the onboarding modal is gone
        if not tui.read_until(b"Ask", args.ready_timeout):
            print("FAIL: TUI prompt never appeared")
            return 1
        time.sleep(2)
        tui.send(b"\x1b", settle=0.8)  # dismiss any welcome modal
        prompt_text = "say hi"

        # record the fixture hit baseline BEFORE sending the prompt
        hits_file = os.path.join(state, "hits.jsonl")
        def hit_count():
            try:
                with open(hits_file) as f:
                    return sum(1 for line in f if line.strip())
            except FileNotFoundError:
                return 0
        baseline = hit_count()

        mark = len(tui.buf)
        tui.type_text(prompt_text)
        tui.send(b"\r", settle=0.5)
        # wait for the session to start (busy indicator or any response)
        if not (tui.read_until(b"esc", 30, mark=mark) or tui.read_until(b"interrupt", 5, mark=mark) or tui.read_until(b"Build", 5, mark=mark)):
            print(f"FAIL {args.case}: prompt submission never started the session")
            return 1

        if args.case != "abort":
            tui.read_until(b"output limit", 60) or tui.read_until(b"incomplete", 5)
            time.sleep(1)

        if args.case == "abort":
            # wait until the fixture received the request (server-side busy)
            deadline = time.time() + 30
            while time.time() < deadline and hit_count() <= baseline:
                tui.drain(0.25)
            if hit_count() <= baseline:
                print(f"FAIL {args.case}: fixture never received the prompt request")
                return 1
            # wait until the footer shows the busy hint before sending esc;
            # sending esc while autocomplete or a modal owns the keypress
            # silently swallows it
            if not tui.read_until(b"esc", 10) or not tui.read_until(b"interrupt", 5):
                print(f"FAIL {args.case}: busy footer (esc interrupt) never appeared")
                return 1
            tui.send(b"\x1b", settle=0.6)
            # the first esc must flip the footer hint to "again to interrupt";
            # without it the keypress went somewhere else (autocomplete, modal)
            if not tui.read_until(b"again to interrupt", 5):
                print(f"FAIL {args.case}: first esc did not arm the interrupt (no 'again to interrupt' hint)")
                return 1
            tui.send(b"\x1b", settle=0.6)
            # wait for the abort to settle; keep draining the pty so output
            # does not block the child process
            settle_deadline = time.time() + 20
            while time.time() < settle_deadline:
                tui.drain(0.5)
            after = hit_count()
            with open(os.path.join(workdir, "abort-hits.txt"), "w") as f:
                f.write(f"baseline={baseline} after={after}\n")
            if after > baseline + 1:
                print(f"FAIL {args.case}: fixture received {after - baseline} requests; automatic retry fired after user abort")
                return 1
            # positive evidence: the abort must be recorded in the isolated DB
            evidence_ok, evidence_msg = check_abort_evidence(home)
            with open(os.path.join(workdir, "abort-evidence.txt"), "w") as f:
                f.write(f"ok={evidence_ok} msg={evidence_msg}\n")
            if not evidence_ok:
                print(f"FAIL {args.case}: abort evidence missing: {evidence_msg}")
                return 1

        if args.case == "partial":
            # explicit continuation: queue a stop reply, then ask to continue
            with open(os.path.join(state, "queue.json"), "w") as f:
                json.dump([{"text": "CONTINUED-ANSWER-END", "finish": "stop"}], f)
            subprocess.run(
                ["curl", "-s", "-X", "POST", f"http://127.0.0.1:{port}/control/reload"], check=True, capture_output=True
            )
            tui.type_text("continue from the partial answer")
            tui.send(b"\r", settle=0.5)
            tui.read_until(b"CONTINUED-ANSWER-END", 60)
            time.sleep(1)
    finally:
        with open(transcript, "wb") as f:
            f.write(tui.buf)
        screen = tui.screen()
        with open(os.path.join(workdir, f"screen-{args.case}.txt"), "w") as f:
            f.write(screen)
        tui.kill()

    checks = {
        "partial": ["output limit", "CONTINUED-ANSWER-END"],
        "empty": ["output limit"],
        # the delayed reply text must never reach the screen
        "abort": [],
    }[args.case]
    forbidden = {
        "abort": ["ABORT-SHOULD-NEVER-STREAM", "output limit"],
    }.get(args.case, [])
    # assert against the raw transcript: the final screen wraps long lines,
    # so a wrapped marker can be split across rows and missed by plain search
    raw = tui.buf.decode("utf-8", "replace")
    missing = [c for c in checks if c not in raw]
    leaked = [c for c in forbidden if c in raw]
    if missing or leaked:
        if missing:
            print(f"FAIL {args.case}: missing {missing}")
        if leaked:
            print(f"FAIL {args.case}: forbidden content reached screen {leaked}")
        ok = False
    else:
        print(f"PASS {args.case}")

    # additional check for partial case: the partial answer must be in the DB
    if args.case == "partial" and ok:
        db = find_db(home)
        conn = sqlite3.connect(db)
        try:
            rows = conn.execute(
                "SELECT json_extract(data,'$.text') FROM part WHERE json_extract(data,'$.type')='text'"
            ).fetchall()
            texts = [r[0] for r in rows if r[0]]
            if not any("PARTIAL-ANSWER-START" in t for t in texts):
                print(f"FAIL {args.case}: partial answer not found in DB parts")
                ok = False
        finally:
            conn.close()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Exercise a built engine with local SSE responses and real tools, without model API calls.

Default: parallel 310-second delegation/streaming and a 300-second idle timeout.
Each case uses an isolated HOME. Evidence is retained under --root.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def run_case(args, name):
    root = Path(args.root).resolve() / name
    home = root / "home"
    project = root / "project"
    config_dir = home / ".config" / "sente"
    config_dir.mkdir(parents=True, exist_ok=False)
    project.mkdir()
    calls = []
    errors = []
    started = time.monotonic()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass

        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                main = bool(body.get("tools"))
                messages = body.get("messages", [])
                child = any(
                    m.get("role") == "user" and "IDLE_CHILD" in json.dumps(m.get("content"))
                    for m in messages
                )
                outputs = [m for m in messages if m.get("role") == "tool"]
                calls.append({"at": round(time.monotonic() - started, 3), "main": main,
                              "child": child, "tool_results": len(outputs)})
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("connection", "close")
                self.end_headers()

                def chunk(delta, finish=None):
                    data = {"id": "idle-check", "object": "chat.completion.chunk", "created": 1,
                            "model": "local", "choices": [{"index": 0, "delta": delta,
                                                           "finish_reason": finish}]}
                    self.wfile.write(("data: " + json.dumps(data) + "\n\n").encode())
                    self.wfile.flush()

                def text(value):
                    chunk({"content": value})

                def tool(tool_name, params):
                    chunk({"tool_calls": [{"index": 0, "id": "call_" + str(len(calls)),
                                           "type": "function", "function": {
                                               "name": tool_name, "arguments": json.dumps(params)}}]})
                    chunk({}, "tool_calls")

                if not main:
                    text("local verification")
                    chunk({}, "stop")
                elif name == "delegate":
                    if child and not outputs:
                        tools = [t["function"]["name"] for t in body["tools"]]
                        shell = "bash" if "bash" in tools else "shell"
                        tool(shell, {"command": f"sleep {args.seconds}; printf IDLE_TOOL_DONE",
                                     "description": "local long tool verification", "timeout": 360000})
                    elif child:
                        text("IDLE_CHILD_DONE")
                        chunk({}, "stop")
                    elif not outputs:
                        tool("task", {"description": "local long child verification", "prompt": "IDLE_CHILD",
                                      "subagent_type": "general"})
                    elif len(outputs) == 1:
                        match = re.search(r'ses_[A-Za-z0-9]+', json.dumps(outputs[0]))
                        if not match:
                            raise ValueError("completed task output has no resumable session ID")
                        tool("task", {"description": "resume existing child verification", "prompt": "IDLE_CHILD resume",
                                      "subagent_type": "general", "task_id": match.group()})
                    else:
                        if "IDLE_CHILD_DONE" not in json.dumps(outputs):
                            raise ValueError("child completion marker missing")
                        text("IDLE_PARENT_DONE")
                        chunk({}, "stop")
                elif name == "stream":
                    deadline = time.monotonic() + args.seconds
                    text("IDLE_STREAM_START ")
                    while time.monotonic() < deadline:
                        time.sleep(min(10, max(0, deadline - time.monotonic())))
                        text("tick ")
                    text("IDLE_STREAM_DONE")
                    chunk({}, "stop")
                elif name == "stall":
                    text("IDLE_PARTIAL ")
                    time.sleep(340)
                    text("UNEXPECTED_STALL_FINISH")
                    chunk({}, "stop")
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                # Expected when the idle timer closes the deliberately stalled stream.
                pass
            except Exception as error:
                errors.append(repr(error))
            finally:
                self.close_connection = True

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    config = {
        "model": "fake/local", "small_model": "fake/local", "autoupdate": False, "share": "disabled",
        "permission": {"*": "allow"},
        "provider": {"fake": {"name": "Local fixture", "npm": "@ai-sdk/openai-compatible", "env": [],
            "options": {"apiKey": "local-fixture", "baseURL": f"http://127.0.0.1:{server.server_port}/v1",
                        # Isolate the processor timer from the independent SSE transport timer.
                        "chunkTimeout": False},
            "models": {"local": {"id": "local", "name": "Local fixture", "tool_call": True,
                "attachment": False, "reasoning": False, "temperature": False, "release_date": "2025-01-01",
                "limit": {"context": 1000000, "output": 32000}, "cost": {"input": 0, "output": 0}}}}},
    }
    (config_dir / "sente.json").write_text(json.dumps(config))
    env = {key: os.environ[key] for key in ("PATH", "SHELL", "TMPDIR") if key in os.environ}
    env.update({"HOME": str(home), "PWD": str(project), "LANG": "en_US.UTF-8", "TE_LANG": "en",
                "SENTE_DISABLE_AUTOUPDATE": "1", "SENTE_AUTO_RESUME_BASE_MS": "10"})
    for key, suffix in (("XDG_CONFIG_HOME", ".config"), ("XDG_DATA_HOME", ".local/share"),
                        ("XDG_STATE_HOME", ".local/state"), ("XDG_CACHE_HOME", ".cache")):
        env[key] = str(home / suffix)
    command = [args.binary, "run", "--pure", "--format", "json", "-m", "fake/local", "local idle verification"]
    try:
        done = subprocess.run(command, cwd=project, env=env, stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=max(args.seconds + 90, 370))
        output = done.stdout + done.stderr
        elapsed = time.monotonic() - started
        (root / "stdout.jsonl").write_text(done.stdout)
        (root / "stderr.txt").write_text(done.stderr)
        events = []
        for line in done.stdout.splitlines():
            if line.startswith("{"):
                events.append(json.loads(line))
        failures = [e for e in events if e.get("type") == "error"]
        if name == "stall":
            ok = (295 <= elapsed <= 335 and bool(failures) and
                  "Partial response" in output and "UNEXPECTED_STALL_FINISH" not in output and
                  len([c for c in calls if c["main"]]) == 1)
        else:
            marker = "IDLE_PARENT_DONE" if name == "delegate" else "IDLE_STREAM_DONE"
            ok = done.returncode == 0 and marker in output and not failures and elapsed >= args.seconds
            if name == "delegate":
                task_parts = [e["part"] for e in events if e.get("type") == "tool_use" and
                              e.get("part", {}).get("tool") == "task"]
                ids = [p.get("state", {}).get("metadata", {}).get("sessionId") for p in task_parts]
                ok = ok and len(ids) == 2 and bool(ids[0]) and ids[0] == ids[1]
        result = {"case": name, "pass": bool(ok and not errors), "elapsed": round(elapsed, 3),
                  "exit": done.returncode, "calls": calls, "fixture_errors": errors,
                  "error_events": failures}
    except subprocess.TimeoutExpired:
        result = {"case": name, "pass": False, "error": "fixture process timeout", "calls": calls}
    finally:
        server.shutdown()
        server.server_close()
    (root / "result.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--seconds", type=float, default=310)
    parser.add_argument("--only", default="delegate,stream,stall")
    args = parser.parse_args()
    args.binary = str(Path(args.binary).resolve())
    root = Path(args.root)
    root.mkdir(parents=True, exist_ok=False)
    identity = {"binary": args.binary, "sha256": hashlib.file_digest(open(args.binary, "rb"), "sha256").hexdigest(),
                "version": subprocess.check_output([args.binary, "--version"], text=True).strip()}
    print(json.dumps(identity), flush=True)
    with concurrent.futures.ThreadPoolExecutor() as executor:
        results = list(executor.map(lambda name: run_case(args, name), args.only.split(",")))
    (root / "summary.json").write_text(json.dumps({"identity": identity, "results": results}, indent=2))
    return 0 if all(r["pass"] for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())

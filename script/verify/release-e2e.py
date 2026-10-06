#!/usr/bin/env python3
"""Pre-release gate for a built Sente binary: session database + end-to-end run.

Runs the real binary against the local fake model server from cost-resume-e2e.py inside a
throwaway HOME. Nothing here reads the user's config, sessions, credits or a real model API.

Usage:
  release-e2e.py --binary PATH [--channel NAME] [--only NAME[,NAME]] [--all] [--keep] [--list]

Default selection = every db-* case below + the cost-resume-e2e.py cases listed in
COST_CASES. `--all` adds the rest of cost-resume-e2e.py (cost gate, automatic resume,
sidebar); those need features that are not on the release branch yet, so they are not
part of the gate until that work is merged. Exit code is 0 only when every selected case passes.
"""
import argparse
import importlib.util
import json
import os
import sqlite3
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("cost_resume_e2e", os.path.join(HERE, "cost-resume-e2e.py"))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

# cost-resume-e2e.py cases that exercise behaviour present on the release branch today:
# a plain run, a tool-call round trip (two model calls), and "401 is not retried".
COST_CASES = ["gate-off", "gate-settles", "no-resume"]
SEED = "sente-seed-many.db"
SEED_SESSIONS = 50


def data_dir(home):
    return os.path.join(home, ".local", "share", "sente")


def seed(home):
    """A sibling session database with clearly more sessions than a fresh one."""
    os.makedirs(data_dir(home), exist_ok=True)
    db = sqlite3.connect(os.path.join(data_dir(home), SEED))
    db.execute("CREATE TABLE session (id TEXT PRIMARY KEY)")
    db.executemany("INSERT INTO session (id) VALUES (?)", [(f"ses_seed_{index}",) for index in range(SEED_SESSIONS)])
    db.commit()
    db.close()


def databases(home):
    if not os.path.isdir(data_dir(home)):
        return []
    return sorted(name for name in os.listdir(data_dir(home)) if name.startswith("sente") and name.endswith(".db"))


def sessions(path):
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return db.execute("SELECT count(*) FROM session").fetchone()[0]
    finally:
        db.close()


def cases(bench, channel):
    fake = bench.fake
    expected = "sente.db" if channel in ("latest", "beta", "prod") else f"sente-{channel}.db"

    def call(home, project, *args, extra=None, timeout=180):
        return subprocess.run(
            [bench.binary, *args], cwd=project, env=bench.env(home, extra), capture_output=True, text=True,
            timeout=timeout, stdin=subprocess.DEVNULL,
        )

    def run(home, project, *flags, extra=None):
        return call(home, project, "run", "--pure", "-m", "fake/pricey", *flags, "check", extra=extra)

    def db_path():
        home, project = bench.home()
        done = call(home, project, "db", "path", timeout=60)
        printed = done.stdout.strip().splitlines()[-1:] or [""]
        want = os.path.join(data_dir(home), expected)
        bench.check(
            "db-path", f"db path が {expected} を指す(ブランチ名や空のチャンネルでDBが分かれない)",
            done.returncode == 0 and os.path.realpath(printed[0]) == os.path.realpath(want),
            f"exit={done.returncode}\n期待: {want}\n実際: {printed[0]}\n{done.stderr}",
        )

    def db_persist():
        fake.reset()
        home, project = bench.home()
        done = run(home, project)
        files = databases(home)
        count = sessions(os.path.join(data_dir(home), expected)) if expected in files else -1
        bench.check(
            "db-persist", f"run の会話が {expected} に保存され、ほかのDBを作らない",
            done.returncode == 0 and base.OK_TEXT in done.stdout and files == [expected] and count >= 1,
            f"exit={done.returncode} main={fake.main} files={files} sessions={count}\n{done.stdout}{done.stderr}",
        )

    def db_notice_quiet():
        fake.reset()
        home, project = bench.home()
        done = run(home, project)
        bench.check(
            "db-notice-quiet", "会話の多い別DBが無ければ案内を出さない",
            done.returncode == 0 and "SENTE_DB=" not in done.stdout + done.stderr,
            f"exit={done.returncode}\n{done.stdout}{done.stderr}",
        )

    def db_notice_run():
        fake.reset()
        home, project = bench.home()
        seed(home)
        done = run(home, project)
        problems = []
        if done.returncode != 0 or base.OK_TEXT not in done.stdout:
            problems.append(f"run が完了していない exit={done.returncode}")
        for word in (SEED, f"{SEED_SESSIONS}件", expected, f"SENTE_DB={SEED} sente"):
            if word not in done.stderr:
                problems.append(f"stderr に「{word}」が無い")
        if done.stderr.count("SENTE_DISABLE_DB_NOTICE=1") != 1:
            problems.append(f"案内が {done.stderr.count('SENTE_DISABLE_DB_NOTICE=1')} 回出ている(期待 1)")
        if SEED in done.stdout:
            problems.append("案内が stdout に混ざっている")
        if sessions(os.path.join(data_dir(home), SEED)) != SEED_SESSIONS:
            problems.append("別DBの中身が変わっている")
        bench.check("db-notice-run", "会話の多い別DBがあると run が stderr に1回案内する(DBは触らない)", not problems, "\n".join(problems) + f"\n--- stdout\n{done.stdout}\n--- stderr\n{done.stderr}")

    def db_notice_json():
        fake.reset()
        home, project = bench.home()
        seed(home)
        done = run(home, project, "--format", "json")
        problems = []
        lines = [line for line in done.stdout.splitlines() if line.strip()]
        for line in lines:
            try:
                json.loads(line)
            except ValueError:
                problems.append(f"stdout に JSON でない行: {line[:120]}")
        warnings = []
        for line in done.stderr.splitlines():
            try:
                item = json.loads(line)
            except ValueError:
                continue
            if isinstance(item, dict) and item.get("type") == "warning" and SEED in str(item.get("message")):
                warnings.append(item)
        if done.returncode != 0 or not lines:
            problems.append(f"run が完了していない exit={done.returncode}")
        if len(warnings) != 1:
            problems.append(f"stderr の warning が {len(warnings)} 件(期待 1)")
        bench.check("db-notice-json", "--format json でも stdout はイベントだけ、案内は stderr に構造化して1回", not problems, "\n".join(problems) + f"\n--- stderr\n{done.stderr}")

    def db_notice_off():
        fake.reset()
        home, project = bench.home()
        seed(home)
        done = run(home, project, extra={"SENTE_DISABLE_DB_NOTICE": "1"})
        bench.check(
            "db-notice-off", "SENTE_DISABLE_DB_NOTICE=1 で案内を止められる",
            done.returncode == 0 and base.OK_TEXT in done.stdout and SEED not in done.stdout + done.stderr,
            f"exit={done.returncode}\n{done.stdout}{done.stderr}",
        )

    def db_notice_tui():
        fake.reset()
        make = bench.home

        def seeded(permission=None):
            home, project = make(permission)
            seed(home)
            return home, project

        bench.home = seeded
        try:
            flat = lambda shot: "".join(shot.split())
            screen, path = bench.tui("db-notice", lambda shot: SEED in flat(shot) and base.OK_TEXT in shot)
        finally:
            bench.home = make
        text = flat(screen)
        problems = [f"画面に「{word}」が無い" for word in (SEED, f"{SEED_SESSIONS}件", f"SENTE_DB={SEED}") if word not in text]
        if base.OK_TEXT not in screen:
            problems.append("案内が出たまま会話が完了していない")
        bench.check("db-notice-tui", "TUI でも同じ案内が画面に出て、そのまま会話できる", not problems, "\n".join(problems) + f"\n画面: {path}\n{screen}")

    return {
        "db-path": db_path,
        "db-persist": db_persist,
        "db-notice-quiet": db_notice_quiet,
        "db-notice-run": db_notice_run,
        "db-notice-json": db_notice_json,
        "db-notice-off": db_notice_off,
        "db-notice-tui": db_notice_tui,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--channel", default="headless-model-fallback", help="build channel the binary must use for its database")
    parser.add_argument("--only", default="")
    parser.add_argument("--all", action="store_true", help="also run every cost-resume-e2e.py case")
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()
    bench = base.Bench(os.path.abspath(args.binary), args.keep)
    cost = base.cases(bench)
    missing = [name for name in COST_CASES if name not in cost]
    table = {**cases(bench, args.channel), **cost}
    default = [name for name in table if name.startswith("db-")] + COST_CASES
    if args.list:
        print("\n".join(f"{name}{'' if name in default else ' (--all)'}" for name in table))
        bench.close(False)
        return 0
    wanted = [name for name in args.only.split(",") if name] or (list(table) if args.all else default)
    unknown = [name for name in wanted if name not in table] + missing
    if unknown:
        print(f"unknown case: {', '.join(unknown)} (available: {', '.join(table)})")
        bench.close(False)
        return 2
    version = subprocess.run([bench.binary, "--version"], capture_output=True, text=True).stdout.strip().splitlines()[-1:]
    print(f"対象: {bench.binary} ({''.join(version)}) channel={args.channel}\n")
    for name in wanted:
        try:
            table[name]()
        except Exception as error:  # a broken case must not hide the others; it still fails the gate
            bench.check(name, "実行できなかった", False, repr(error))
    failed = [name for name, ok in bench.results if not ok]
    print(f"\n{len(bench.results) - len(failed)}/{len(bench.results)} 件 成功" + (f"・失敗: {', '.join(failed)}" if failed else ""))
    bench.close(bool(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

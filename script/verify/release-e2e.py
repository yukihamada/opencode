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
# a plain run, a tool-call round trip (two model calls), "401 is not retried", and
# "a turn stopped by repeated 503s resumes by itself" (automatic resume, 2026-10-07).
COST_CASES = ["gate-off", "gate-settles", "no-resume", "resume"]
SEED = "sente-seed-many.db"
SEED_SESSIONS = 50
# A migration that only deletes derived rows, so applying it a second time is harmless. The
# db-migrate case makes it look unapplied to prove what a build does with a pending migration.
MIGRATION = "20260622202450_simplify_session_input"


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


def cases(bench, channel, dev_guard=False):
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

    def db_migrate():
        # An existing database with a conversation and one migration this build still has to
        # apply. A release build must apply it and carry on: if it stopped here, the shipped
        # binary would stop every user's startup after an update. A developer build
        # (--expect-dev-guard) must stop instead, until the developer consents.
        fake.reset()
        home, project = bench.home()
        first = run(home, project)
        path = os.path.join(data_dir(home), expected)

        def journal():
            db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                return {row[0] for row in db.execute("SELECT id FROM migration")}
            finally:
                db.close()

        problems = []
        if first.returncode != 0 or MIGRATION not in journal():
            problems.append(f"準備の run が失敗、または {MIGRATION} が記録されていない exit={first.returncode}")
            bench.check("db-migrate", "未適用マイグレーションのある既存DB", False, "\n".join(problems) + first.stdout + first.stderr)
            return
        db = sqlite3.connect(path)
        db.execute("DELETE FROM migration WHERE id = ?", (MIGRATION,))
        db.commit()
        db.close()
        before = sessions(path)
        fake.reset()
        second = run(home, project)
        out = second.stdout + second.stderr
        if dev_guard:
            title = "開発ビルドは会話のある既存DBへ新しいマイグレーションを黙って適用せず、承知の指定で適用する"
            if second.returncode != 1 or fake.main != 0:
                problems.append(f"止まっていない exit={second.returncode} main={fake.main}")
            for word in (MIGRATION, path, f"{before}件", "SENTE_DB=", "SENTE_CHANNEL=", "SENTE_ALLOW_DEV_MIGRATION=1"):
                if word not in second.stderr:
                    problems.append(f"stderr に「{word}」が無い")
            if MIGRATION in journal():
                problems.append("止めたのに適用されている")
            as_json = run(home, project, "--format", "json")
            record = None
            for line in as_json.stderr.splitlines():
                try:
                    item = json.loads(line)
                except ValueError:
                    continue
                if isinstance(item, dict) and item.get("code") == "database_migration_blocked":
                    record = item
            if as_json.returncode != 1 or as_json.stdout.strip() or not record:
                problems.append(f"--format json で構造化されていない exit={as_json.returncode} stdout={as_json.stdout[:80]!r}")
            elif record.get("migrations") != [MIGRATION] or record.get("sessions") != before or record.get("exitCode") != 1:
                problems.append(f"JSON の中身が違う: {record}")
            tui_env = bench.env(home)
            tui = subprocess.run([bench.binary, "--pure", "-m", "fake/pricey"], cwd=project, env=tui_env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
            if tui.returncode != 1 or MIGRATION not in tui.stderr:
                problems.append(f"TUI 起動が止まらない、または案内が無い exit={tui.returncode}")
            listed = call(home, project, "db", "path", timeout=60)
            if listed.returncode != 0:
                problems.append("止まっている間も db path は使えるはず")
            fake.reset()
            allowed = run(home, project, extra={"SENTE_ALLOW_DEV_MIGRATION": "1"})
            if allowed.returncode != 0 or base.OK_TEXT not in allowed.stdout or MIGRATION not in journal():
                problems.append(f"SENTE_ALLOW_DEV_MIGRATION=1 で適用・実行されない exit={allowed.returncode}")
            out += as_json.stderr + tui.stderr + allowed.stdout + allowed.stderr
        else:
            title = "リリースビルドは既存DBの未適用マイグレーションを止まらずに適用して動く"
            if second.returncode != 0 or base.OK_TEXT not in second.stdout:
                problems.append(f"run が完了していない exit={second.returncode}")
            if "SENTE_ALLOW_DEV_MIGRATION" in out:
                problems.append("リリースビルドが開発ビルド用の安全弁で止まっている")
            if MIGRATION not in journal():
                problems.append("マイグレーションが適用されていない")
            if sessions(path) < before:
                problems.append("会話が減っている")
        bench.check("db-migrate", title, not problems, "\n".join(problems) + f"\n{out}")

    return {
        "db-migrate": db_migrate,
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
    parser.add_argument("--expect-dev-guard", action="store_true", help="the binary is a developer build: db-migrate must stop instead of applying (never pass this for a release)")
    parser.add_argument("--only", default="")
    parser.add_argument("--all", action="store_true", help="also run every cost-resume-e2e.py case")
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()
    bench = base.Bench(os.path.abspath(args.binary), args.keep)
    cost = base.cases(bench)
    missing = [name for name in COST_CASES if name not in cost]
    table = {**cases(bench, args.channel, args.expect_dev_guard), **cost}
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

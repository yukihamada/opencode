# 実行上限前の仕上げ・報告枠 — ローカル検証記録

## 結果

2026-10-07、ローカルCLIの対象回帰テスト・型検査・ビルド・署名・起動確認まで成功。公開、インストール済み実行環境への差し替え、コミット、pushは未実施。

## 対象

- 100リクエスト／100ターンの上限は維持し、消費済み80から仕上げ、99から報告専用に切り替える。`packages/sente/src/session/escalation.ts:8-25`
- 引き継ぎには直近8ツールの参照と未検証・明示再開の状態を保存し、入力・出力のコピーは保存しない。`packages/sente/src/session/escalation.ts:28-37`
- 子・補助呼び出しが親の最後の報告枠を消費することを防ぐ。`packages/sente/src/session/llm.ts:140-143`
- 100回目に正常な最終回答を返した場合、上限エラーを後付けしない。`packages/sente/src/session/prompt.ts:1146-1147`
- 100回目の回答・引き継ぎ保存・再loop時に追加モデル呼び出しがないことを検証するテストを追加。`packages/sente/test/session/prompt.test.ts:3266`

## 実行証拠

作業ディレクトリ: `packages/sente`

1. `PATH="/Users/yukihamada/.cache/sente/bin:$PATH" bun run test test/session/escalation.test.ts test/session/prompt.test.ts test/session/llm.test.ts test/tool/glob.test.ts`
   - 181 pass / 1 skip / 0 fail、654 assertions、48.49秒。
   - skipは既存のv2 projector無効化テスト（`test/session/prompt.test.ts:760-761`）。今回追加したテストのskipではない。
   - ログ: `/Users/yukihamada/.local/share/sente/tool-output/tool_113f25800001azzmXCreiMMymr`
2. `bun typecheck` — exit 0。
3. `SENTE_RELEASE= SENTE_CHANNEL=local-verify bun run build --single --skip-install --skip-embed-web-ui` — exit 0。
   - ビルドスクリプトによるad-hoc署名・`--version` smoke成功。
4. `codesign --verify --strict dist/sente-darwin-arm64/bin/sente` — exit 0。
5. `dist/sente-darwin-arm64/bin/sente --version` — `0.0.0-local-verify-202610070120`。
6. `shasum -a 256 dist/sente-darwin-arm64/bin/sente`
   - `4d83102e0bac26ece896d68d116c6fd2b1e8ca85345d2d19dcac7b81de246a88`
7. 対象追跡ファイル4件の `git diff --check` — exit 0。

## テスト環境の詰まりと解消

PATHにrgがない隔離テストでGitHubからのripgrep 15.1.0取得がConnectionRefusedとなり、globが失敗した。キャッシュ済み実バイナリのディレクトリを当該テストコマンドのPATHに追加すると成功した。テスト無効化・例外握り潰し・ripgrep実装変更は行っていない。

## 検証範囲と残件

- 公開承認後の確認（2026-10-07）: 最新リリースブランチを取得する `git fetch mine headless-model-fallback` がGitHub SSH（22番）へのConnection refusedで失敗。`gh api repos/yukihamada/opencode/branches/headless-model-fallback` もGitHub API HTTPS（443番）へのconnection refusedで失敗した。HTTPS URL指定のfetchもSSH接続へ進み失敗。最新リモート確認・対象差分の分離・リリース用再検証に進めていない。commit/push/Actions起動/公開は行っていない。接続復旧後に最新リリースブランチ取得から再開する。

- 全リポジトリテスト、実モデルを使った100回の連続実行、Web UI同梱ビルド、配布版での動作は未確認（unverified）。
- ビルドは他の未コミット変更を含む現在の作業ツリーから生成したもの。今回の差分だけを分離したリリース成果物ではない。
- 実行環境への反映・公開は未実施。必要なら混在差分を確認して適用範囲を確定する。
- 元依頼の `workspace/tension-dashboard/DAILY-COSTS-20261006.md` 等の費用台帳・監査記録・本人待ち一覧は、この検証では更新・確認していない。

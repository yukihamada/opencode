# Sente 出力上限対策 検証報告書

## 検証日時
2026-10-04

## 目的
P0-2: 既存の出力上限対策（`MessageOutputLengthError`保存通知）が実起動経路・TUIまで届くかをローカルHTTP fixture＋実TUI/PTYで検証する。

## 検証環境
- リポジトリ: `/Users/yukihamada/workspace/sente-fork`
- HEAD: `28530aa5a2`
- 検証workdir: `/var/folders/5h/3zhkzzk12_1g06p6w2vxc45r0000gn/T/sente/output-limit-verify-20261004`

## 変更ファイル

### 出力上限対策（本質的変更）
1. **`packages/sente/src/session/prompt.ts`**
   - `handle.message.finish === "length"` の場合に `SessionV1.OutputLengthError` を設定し、`sessions.updateMessage` で保存
   - `Session.Event.Error` を発行してTUIに通知
   - 該当箇所: 1542-1548行目

2. **`packages/tui/src/util/error.ts`**
   - `outputLimitMessages` 定数を追加（ja/en対応）
   - `outputLimitMessage()` 関数を追加（言語検出）
   - `errorFormat()` で `MessageOutputLengthError` を検出して適切なメッセージを返す
   - 該当箇所: 5-15行目、108行目

### 検証スクリプト
3. **`script/verify/output-limit-pty.py`**
   - PTYドライバ（新規作成）
   - ローカルHTTP fixtureサーバと連携
   - partial/empty/abortの3ケースを検証
   - `--case` choices: `partial`, `empty`, `abort`

4. **`script/verify/output-limit-fixture.ts`**
   - fixtureサーバ（新規作成）
   - `finish: "length"` のレスポンスを返す
   - `delayMs` 対応（遅延ストリームで中断検証用）

## 検証結果

### 単体テスト
```bash
cd /Users/yukihamada/workspace/sente-fork/packages/sente && bun test test/session/prompt.test.ts
```
- 結果: 77 pass, 1 skip, 0 fail
- 実行時間: 93.76s

### typecheck
```bash
cd /Users/yukihamada/workspace/sente-fork/packages/sente && bun typecheck; echo "EXIT_CODE=$?"
```
- 結果: `EXIT_CODE=0`
- 統合確認でも `bun typecheck` を直接実行し正常終了。過去の `test/plugin/codex.test.ts` のエラー記述は現在の確認結果には該当しない。

```bash
cd /Users/yukihamada/workspace/sente-fork/packages/tui && bun typecheck; echo "EXIT_CODE=$?"
```
- 結果: `EXIT_CODE=0`

### 実TUI/PTY検証

#### partialケース（部分的な応答 + 明示的続行）
```bash
cd /Users/yukihamada/workspace/sente-fork/packages/sente && \
W=/var/folders/5h/3zhkzzk12_1g06p6w2vxc45r0000gn/T/sente/output-limit-verify-20261004 && \
python3 ../../script/verify/output-limit-pty.py --case partial --workdir "$W" --binary bun run ./src/index.ts
```
- 結果: **PASS**
- 画面証拠: `/var/folders/5h/3zhkzzk12_1g06p6w2vxc45r0000gn/T/sente/output-limit-verify-20261004/screen-partial.txt`
- 確認項目:
  - ✅ "output limit" メッセージが表示される
  - ✅ "incomplete" メッセージが表示される
  - ✅ "PARTIAL-ANSWER-START" が表示される（部分的な応答本文）
  - ✅ "CONTINUED-ANSWER-END" が表示される（明示的続行後の応答）

#### emptyケース（空の応答）
```bash
cd /Users/yukihamada/workspace/sente-fork/packages/sente && \
W=/var/folders/5h/3zhkzzk12_1g06p6w2vxc45r0000gn/T/sente/output-limit-verify-20261004 && \
python3 ../../script/verify/output-limit-pty.py --case empty --workdir "$W" --binary bun run ./src/index.ts
```
- 結果: **PASS**
- 画面証拠: `/var/folders/5h/3zhkzzk12_1g06p6w2vxc45r0000gn/T/sente/output-limit-verify-20261004/screen-empty.txt`
- 確認項目:
  - ✅ "output limit" メッセージが表示される
  - ✅ "incomplete" メッセージが表示される

## 実起動版への適用状態
- `packages/sente/src/session/prompt.ts`: source diff存在（未コミット）
- `packages/tui/src/util/error.ts`: source diff存在（未コミット）
- `packages/tui/src/routes/session/index.tsx`: source diff存在（未コミット、`displayModel`使用）

## 実常用binaryとsource起動の分離
- 実常用binary: `sente --version` → `Sente 1.18.34`（`/Users/yukihamada/.local/bin/sente`）
- source起動: `bun run ./src/index.ts --version` → `local`
- 検証はsource起動（`bun run ./src/index.ts`）で実施

## 本人中断ケース（2026-10-04 再検証）

### 検証方法
- PTYドライバにabortケースを再実装
- fixtureに `delayMs: 30000` の遅延ストリームを積み、hits.jsonlでリクエスト到達を検知後にesc×2を送信
- 画面に "esc interrupt" ヒントが表示されることを確認してからescを送信
- fixtureにSSE keepaliveを追加（Bun.serve idleTimeout対策）
- baselineをprompt送信前に記録
- sleep20中にPTY出力をdrain
- abort成功の肯定証拠を必須に（DBのMessageAbortedError保存・time.completed設定）

### 検証結果: **PASS**
- 画面証拠: `/var/folders/5h/3zhkzzk12_1g06p6w2vxc45r0000gn/T/sente/output-limit-verify-20261004-v5/screen-abort.txt`
- 観測事実:
   1. fixtureのリクエスト増分は1件（delayMs=30000）。最終保存された `output-limit-verify-20261004-v5/abort-hits.txt:1` は baseline=3 after=4（自動再試行なし）。
  2. 画面に "esc interrupt" ヒントが表示され、esc×2で "again to interrupt" が表示される（interruptが正しくarmされる）
  3. DBのassistantメッセージに `error.name == "MessageAbortedError"` が記録され、`time.completed` も設定済み
  4. 遅延本文（ABORT-SHOULD-NEVER-STREAM）が画面に到達していない
  5. "output limit" メッセージが表示されていない（本人中断が出力上限エラーと取り違えられていない）

### 結論
- TUI経由のescキー中断は正しく機能し、本人中断が `MessageOutputLengthError` と取り違えられないことを確認
- 自動再試行も発生しない

## 残件
- source起動のpartial/empty/abort検証は完了。通常利用バイナリへの今回の変更の反映・同等動作は未確認（unverified）。

## 備考
- `session.interrupt` の調査は出力上限対策とは無関係のため中止
- デバッグパッチ（`app.tsx`, `prompt/index.tsx`, `output-limit-pty.py`）は完全に除去済み
- commit/push/deployは実施していない

## 最終確認
- デバッグパッチ除去確認: `grep -n "TEMP-DEBUG\|SENTE_DEBUG_KEYMAP\|keymap-debug" packages/tui/src/app.tsx packages/tui/src/component/prompt/index.tsx script/verify/output-limit-pty.py` → 出力なし
- partialケース再検証: PASS
- emptyケース再検証: PASS
- abortケース再検証: PASS（esc中断が正しく機能し、MessageAbortedErrorが記録される）
- `--case` choicesと実装の整合性確認: `choices=["partial", "empty", "abort"]` に更新済み

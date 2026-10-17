# upstream_stream_error 自動再試行 — 2026-10-07 実施記録

## 変更

- `packages/sente/src/session/retry.ts:38–39`: `upstream_stream_error` を既存の一時障害判定へ追加。汎用の `Provider output blocked` / `Retry shortly` を条件にせず、ポリシーによる出力拒否を巻き込まない。
- `packages/sente/test/session/retry.test.ts:214`: プレーン文字列・JSON・途中で切れたJSON、Unknown/APIError/responseBodyを検証。別種の出力拒否と類似コードは対象外。
- `packages/sente/test/session/processor-effect.test.ts:754–793`: HTTP 400およびSSEエラーをローカルHTTP fixtureで再現し、同じ処理が2回目のリクエストで成功することを検証。
- 既存の上限5回・待機最大30秒・途中出力後の再送停止は変更なし。`packages/sente/src/session/retry.ts:26–31,222–247` / `packages/sente/src/session/processor.ts:690–725`。

## 実測

作業ディレクトリ: `packages/sente`。

1. 修正前: `bun run test test/session/retry.test.ts test/session/processor-effect.test.ts --test-name-pattern 'upstream stream failures|other output blocks|recovers from upstream_stream_error'`
   - 4 pass / 5 fail。文字列判定3件とHTTP/SSE復旧2件が失敗し、現象を再現。
2. 修正後: `bun run test test/session/retry.test.ts test/session/processor-effect.test.ts test/session/llm.test.ts`
   - 155 pass / 0 fail / 362 assertions、30.06秒。
   - 既存の部分応答再送禁止・最大5回・利用上限停止のテストを含む。
3. `bun typecheck`: exit 0。
4. リポジトリルートで `git diff --check -- packages/sente/src/session/retry.ts packages/sente/test/session/retry.test.ts packages/sente/test/session/processor-effect.test.ts`: exit 0。

## 反映範囲

ローカルソースのみ。既存の未コミット変更は保持。commit / push / 公開 / 利用中バイナリの差し替えは未実施。配布版・利用中アプリでの動作は unverified。実有料APIはこの検証に使用していない。

#!/bin/bash
# Package dist/* into release assets (same layout as prior releases: tar.gz with ./sente for darwin+linux, zip for windows), write SHA256SUMS.txt, create GitHub release.
# Usage: on branch headless-model-fallback (merge main into it first, push it), run
#   cd packages/sente && bun run script/build.ts      # all 12 targets, version=0.0.0-<branch>-<UTC ts>
#   ../../script/release-sente.sh                     # DRY_RUN=1 to only package
# `te update` on user machines pulls releases/latest/download/sente-<plat>-<arch>.tar.gz + SHA256SUMS.txt.
set -euo pipefail
WT="${SENTE_WT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$WT/packages/sente"
VERSION="$(python3 -c "import json;print(json.load(open('dist/sente-darwin-arm64/package.json'))['version'])")"
[ -n "$VERSION" ]
OUT="dist/release"; rm -rf "$OUT"; mkdir -p "$OUT"
for d in dist/sente-*/; do
  key="$(basename "$d")"; [ -d "$d/bin" ] || continue
  case "$key" in
    *windows*) (cd "$d/bin" && zip -q -r "$OLDPWD/$OUT/$key.zip" .) ;;
    # COPYFILE_DISABLE/--no-mac-metadata: macOS の拡張属性(com.apple.provenance 等)が ._sente として混入するのを防ぐ
    *) (cd "$d/bin" && COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -czf "$OLDPWD/$OUT/$key.tar.gz" ./sente) ;;
  esac
done
(cd "$OUT" && shasum -a 256 *.tar.gz *.zip > SHA256SUMS.txt)
ls -la "$OUT"; echo "VERSION=$VERSION"
TAG="sente-$VERSION"; SHA="$(git rev-parse HEAD)"
TS="$(echo "$VERSION" | sed -E 's/.*-([0-9]{12})$/\1/')"
TITLE="Sente ${TS:0:4}.${TS:4:2}.${TS:6:2} · ${TS:8:2}:${TS:10:2} UTC"
NOTES="$(cat <<N
## /login — teai.io の API キーを再起動なしで切り替え

- 入力欄で \`/login\`(別名 \`/signin\` \`/apikey\`)→ te_ キーを貼る → サーバで検証 → \`~/.config/teai/credentials\` に保存(0600・他行保持)→ 起動中のセッションがそのまま新キーで続行
- teai.io のアカウント系エラー(デモモード / キーの月次上限 / 残高不足 / 無効キー)の下に、次に打つ手を 1 行表示
- 検証: TUI テスト 210/210・typecheck・tmux 実機 E2E(無効キー → エラー+ヒント → /login → 同一セッションで応答)

インストール/更新: \`te update\`(\`curl -fsSL https://teai.io/te | sh\`)。target: $SHA
N
)"
echo "TAG=$TAG TITLE=$TITLE"
if [ "${DRY_RUN:-0}" = "1" ]; then exit 0; fi
gh release create "$TAG" -R yukihamada/opencode --target "$SHA" --title "$TITLE" --notes "$NOTES" --latest "$OUT"/*.tar.gz "$OUT"/*.zip "$OUT/SHA256SUMS.txt"

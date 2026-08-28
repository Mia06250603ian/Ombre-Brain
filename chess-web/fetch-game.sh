#!/bin/sh
# 从 player 仓库拉一份游戏进 game/，并打上「复制给晏」补丁。
#
# **每次部署都要跑这个。** game/ 刻意不入库——游戏的唯一可信源是
# Mia06250603ian/player，存两份日久必然一边改一边不改
# （照 dwell-bridge/fetch-frontend.sh 的同一条规矩）。
#
# 用法：./fetch-game.sh [分支名，默认 main]

set -e
BRANCH="${1:-main}"
HERE="$(dirname "$0")"
BASE="https://raw.githubusercontent.com/Mia06250603ian/player/${BRANCH}"
OUT="$HERE/game"

mkdir -p "$OUT"
echo "拉取 player@${BRANCH} …"

# 三个文件缺一不可：少了 float-window.js，弹窗最小化后浮窗不出现
for f in index.html flight-chess-popup.html float-window.js; do
  curl -fsSL "$BASE/$f" -o "$OUT/$f"
  echo "  ✓ $f ($(wc -c < "$OUT/$f") 字节)"
done

# 打补丁：找不到锚点会非零退出，部署当场失败，而不是悄悄上线坏页面
node "$HERE/inject-copy.mjs" \
  "$OUT/flight-chess-popup.html" \
  "$OUT/flight-chess-popup.html.patched" \
  "$HERE/copy-to-yan.js"
mv "$OUT/flight-chess-popup.html.patched" "$OUT/flight-chess-popup.html"

echo "好了：$OUT"

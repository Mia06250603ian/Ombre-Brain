#!/bin/sh
# 真浏览器演练。playwright 刻意不进 package.json（一次性工具，服务本身用不到）。
#
# 用法：
#   npm i playwright@1.49.1 --prefix /tmp/pw
#   PW=/tmp/pw/node_modules ./e2e-run.sh
#
# 换端口：PORT=8801 ./e2e-run.sh
#   （上一轮的服务会占着端口不退、新的静默 EADDRINUSE 退出，于是你打在旧服务上
#     看到的是旧行为 —— **换端口比 pkill 可靠**，dwell 手册和本次都踩过。）
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -d "$HERE/game" ] || { echo "game/ 还没拉，先跑 ./fetch-game.sh"; exit 1; }

# ESM 只会从「引用它的文件」往上找 node_modules，NODE_PATH 不管用。
# 所以临时软链一把，跑完撤掉（node_modules/ 在 .gitignore 里）。
LINKED=""
if [ -n "$PW" ] && [ ! -e "$HERE/node_modules" ]; then
  ln -s "$PW" "$HERE/node_modules"; LINKED=1
fi
cleanup() { [ -n "$LINKED" ] && rm -f "$HERE/node_modules"; }
trap cleanup EXIT

SHOT_DIR="${SHOT_DIR:-$HERE}" node "$HERE/e2e-browser.mjs"

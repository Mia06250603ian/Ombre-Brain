#!/usr/bin/env bash
# galaxy.html 的真浏览器演练(22 项)。只读:不碰线上 OB,起两个假 OB 在本地。
#   用法:bash tests/galaxy-e2e/run.sh
# 为什么要假 OB:真 OB 上是所有者的真实记忆,测试不该碰;而且要能演「没登录 401」那一路。
# 为什么要本地 three:容器里的浏览器上不了 CDN,所以把 three 下下来自己发
#   (只替换测试时发出去的那份 HTML,galaxy.html 本身一个字不动)。
set -euo pipefail
cd "$(dirname "$0")/../.."
WORK="${WORK:-/tmp/galaxy-e2e}"; mkdir -p "$WORK"
PORT_OK="${PORT_OK:-8791}"; PORT_401=$((PORT_OK+1))

[ -d "$WORK/node_modules/playwright" ] || (cd "$WORK" && npm i playwright@1.49.1 --silent --no-fund --no-audit)
[ -d "$WORK/package/build" ] || (cd "$WORK" && curl -sSL -o three.tgz \
  https://registry.npmjs.org/three/-/three-0.160.0.tgz && tar xzf three.tgz)
CHROME="${CHROME:-$(ls -d /opt/pw-browsers/chromium-*/chrome-linux/chrome 2>/dev/null | head -1)}"
[ -x "$CHROME" ] || { echo "找不到 chromium,设 CHROME=<路径>"; exit 1; }

VENDOR="$WORK/package" PORT=$PORT_OK  node tests/galaxy-e2e/fake-ob.mjs & P1=$!
VENDOR="$WORK/package" PORT=$PORT_401 AUTH=0 node tests/galaxy-e2e/fake-ob.mjs & P2=$!
trap 'kill $P1 $P2 2>/dev/null || true' EXIT
sleep 1
PW="$WORK/node_modules" PORT=$PORT_OK CHROME="$CHROME" node tests/galaxy-e2e/e2e.mjs

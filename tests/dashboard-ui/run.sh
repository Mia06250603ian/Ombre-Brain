#!/usr/bin/env bash
# dashboard.html 的真浏览器演练。只读:不碰线上 OB,起一个假 OB 在本地。
#   用法:bash tests/dashboard-ui/run.sh
# 为什么要假 OB:真 OB 上是所有者的真实记忆,测试不该碰(同 tests/galaxy-e2e/)。
# 截图落在 /tmp/dashboard-ui/(深浅色各一套),改完 UI 自己看一眼再说「好了」。
set -euo pipefail
cd "$(dirname "$0")/../.."
WORK="${WORK:-/tmp/dashboard-ui}"; mkdir -p "$WORK"
PORT="${PORT:-8801}"

[ -d "$WORK/node_modules/playwright" ] || (cd "$WORK" && npm i playwright@1.49.1 --silent --no-fund --no-audit)
CHROME="${CHROME:-$(ls -d /opt/pw-browsers/chromium-*/chrome-linux/chrome 2>/dev/null | head -1)}"
[ -x "$CHROME" ] || { echo "找不到 chromium,设 CHROME=<路径>"; exit 1; }

PORT=$PORT node tests/dashboard-ui/fake-ob.mjs & FAKE=$!
trap 'kill $FAKE 2>/dev/null || true' EXIT
sleep 0.6

PW="$WORK/node_modules" CHROME="$CHROME" BASE="http://127.0.0.1:$PORT" SHOTS="$WORK" \
  node tests/dashboard-ui/ui.mjs

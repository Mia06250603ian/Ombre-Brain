#!/usr/bin/env bash
# turbulence.html(记忆乱流)的真浏览器演练。只读:不碰线上 OB,起两个假 OB 在本地。
#   用法:bash tests/turbulence-e2e/run.sh
# 为什么要假 OB:真 OB 上是所有者的真实记忆,测试不该碰(同 tests/galaxy-e2e/)。
# 两个假 OB:一个正常、一个把 /api/network 打成 500(验降级路径)。
# ⚠️ 这一页不引任何外部东西,所以不像 galaxy 那样要先下 three;演练里有一条专门钉这个。
set -euo pipefail
cd "$(dirname "$0")/../.."
WORK="${WORK:-/tmp/turbulence-e2e}"; mkdir -p "$WORK"
PORT_OK="${PORT_OK:-8811}"; PORT_NONET=$((PORT_OK+1))

[ -d "$WORK/node_modules/playwright" ] || (cd "$WORK" && npm i playwright@1.49.1 --silent --no-fund --no-audit)
CHROME="${CHROME:-$(ls -d /opt/pw-browsers/chromium-*/chrome-linux/chrome 2>/dev/null | head -1)}"
[ -x "$CHROME" ] || { echo "找不到 chromium,设 CHROME=<路径>"; exit 1; }

PORT=$PORT_OK    AUTH=0            node tests/turbulence-e2e/fake-ob.mjs & P1=$!   # 要登录的那个
PORT=$PORT_NONET AUTH=1 NONET=1    node tests/turbulence-e2e/fake-ob.mjs & P2=$!   # 连线接口挂掉的那个
trap 'kill $P1 $P2 2>/dev/null || true' EXIT
sleep 1

PW="$WORK/node_modules" PORT=$PORT_OK CHROME="$CHROME" node tests/turbulence-e2e/e2e.mjs

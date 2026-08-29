#!/usr/bin/env bash
# 拿「真的 OB」跑同一套演练,外加验一件事:开星图会不会影响 OB。
#   用法:bash tests/galaxy-e2e/run-real-ob.sh
# 起的是一个本地 OB(临时空库、临时口令),线上那台一根手指都不碰。
# 为什么值得多这一份:假 OB 只能证明页面自己没问题;这份才能证明
#   ① /galaxy 这条路由真的挂上了 ② 逛一圈星图之后桶一个字节没变、/mcp 照样 200。
set -euo pipefail
cd "$(dirname "$0")/../.."
WORK="${WORK:-/tmp/galaxy-e2e}"; VAULT="${VAULT:-/tmp/galaxy-e2e-vault}"
OB_PORT="${OB_PORT:-8801}"; NOAPI_PORT="${NOAPI_PORT:-8792}"; PASS="${PASS:-test123}"
PY="${PY:-/tmp/obvenv/bin/python}"
[ -x "$PY" ] || { echo "需要一个装了 requirements.txt 的 python,设 PY=<路径>"; exit 1; }
[ -d "$WORK/node_modules/playwright" ] || (mkdir -p "$WORK"; cd "$WORK" && npm i playwright@1.49.1 --silent --no-fund --no-audit)
[ -d "$WORK/package/build" ] || (cd "$WORK" && curl -sSL -o three.tgz https://registry.npmjs.org/three/-/three-0.160.0.tgz && tar xzf three.tgz)
CHROME="${CHROME:-$(ls -d /opt/pw-browsers/chromium-*/chrome-linux/chrome 2>/dev/null | head -1)}"
[ -x "$CHROME" ] || { echo "找不到 chromium,设 CHROME=<路径>"; exit 1; }

# 造一个临时空库(六个桶,覆盖 permanent/dynamic/archive/feel 和「domain 为空」)
rm -rf "$VAULT"; mkdir -p "$VAULT"/{permanent,archive,feel} "$VAULT"/dynamic/{编程,日常}
w(){ printf -- "---\nid: %s\nname: %s\ndomain: [%s]\ntags: []\nimportance: %s\nvalence: 0.6\narousal: 0.4\nactivation_count: 3\nresolved: false\npinned: %s\ndigested: false\ncreated: '%s'\nlast_active: '%s'\ntype: %s\n---\n\n%s\n" "$2" "$3" "$4" "$5" "$6" "$7" "$7" "$8" "$9" > "$VAULT/$1"; }
LONG="相遇那天的全文。$(printf '这段是为了把正文撑到 200 字以上，好让预览截断，%.0s' $(seq 9))末尾这句只有取到全文才看得见：★全文到此★"
# ⚠️ 文件名必须是「名字_id.md」:OB 的 _find_bucket_file 是按文件名找桶的,不认 frontmatter 里的 id
w "permanent/真·相遇那天_b01.md"      b01 "真·相遇那天"   "恋爱"   10 true  2026-01-01T20:00:00+08:00 permanent "$LONG"
w "dynamic/编程/真·搭记忆库_b02.md" b02 "真·搭记忆库"   "编程, AI" 8 false 2026-02-08T14:00:00+08:00 dynamic '{"core_facts":["事实一","事实二"]}'
w "dynamic/日常/真·某个晚安_b03.md"   b03 "真·某个晚安"   "日常"    5 false 2026-03-20T23:40:00+08:00 dynamic "晚安全文"
w "archive/真·旧事_b04.md"        b04 "真·旧事"       "回忆"    3 false 2026-04-02T10:00:00+08:00 archive "旧事全文"
w "feel/真·他的自省_b05.md"           b05 "真·他的自省"   "自省"    6 false 2026-05-02T21:00:00+08:00 feel "自省全文"
w "dynamic/日常/真·没有域的桶_b06.md"   b06 "真·没有域的桶" ""        7 false 2026-06-10T15:00:00+08:00 dynamic "无域全文"

OMBRE_BUCKETS_DIR="$VAULT" OMBRE_DASHBOARD_PASSWORD="$PASS" OMBRE_PORT=$OB_PORT \
  OMBRE_TRANSPORT=streamable-http "$PY" server.py > "$WORK/ob.log" 2>&1 & OBPID=$!
VENDOR="$WORK/package" PORT=$NOAPI_PORT NOAPI=1 node tests/galaxy-e2e/fake-ob.mjs & P2=$!
PROXY_PORT="${PROXY_PORT:-8803}"
VENDOR="$WORK/package" OB="http://127.0.0.1:$OB_PORT" PORT=$PROXY_PORT node tests/galaxy-e2e/proxy.mjs & P3=$!
trap 'kill $OBPID $P2 $P3 2>/dev/null || true' EXIT
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$OB_PORT/health" >/dev/null && break; sleep 1; done

# 逛星图之前:把库和 OB 的状态拍个快照
BEFORE=$(find "$VAULT" -type f -exec md5sum {} \; | sort)
HB=$(curl -s "http://127.0.0.1:$OB_PORT/health")

PW="$WORK/node_modules" CHROME="$CHROME" PASS="$PASS" \
  OB_URL="http://127.0.0.1:$PROXY_PORT" NOAPI_URL="http://127.0.0.1:$NOAPI_PORT" \
  node tests/galaxy-e2e/e2e.mjs
E2E=$?

echo "F. 逛完星图,OB 有没有被影响"
fail=0
AFTER=$(find "$VAULT" -type f -exec md5sum {} \; | sort)
[ "$BEFORE" = "$AFTER" ] && echo "  ✓ 记忆库逐字节一模一样(md5 全等,连 last_active 都没被碰)" || { echo "  ✗ 记忆库变了!"; diff <(echo "$BEFORE") <(echo "$AFTER"); fail=1; }
MCP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:$OB_PORT/mcp" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}')
[ "$MCP" = "200" ] && echo "  ✓ 晏连记忆库那条 /mcp 照样 200" || { echo "  ✗ /mcp 回了 $MCP"; fail=1; }
[ "$(curl -s "http://127.0.0.1:$OB_PORT/health")" = "$HB" ] && echo "  ✓ /health 和逛之前一字不差" || echo "  ⚠ /health 变了(自己看是不是只有时间戳/懒启动那类正常变化)"
grep -qE "Traceback|ModuleNotFoundError" "$WORK/ob.log" && { echo "  ✗ OB 日志里有 Traceback"; fail=1; } || echo "  ✓ OB 日志零 Traceback"
echo "  ↳ OB 日志里星图这一趟打了什么:"; grep -oE "(GET|POST) /(galaxy|api/buckets|api/bucket/[a-z0-9]+|auth/login) HTTP/1.1\" [0-9]+" "$WORK/ob.log" | sort | uniq -c | sed 's/^/     /'
echo "G. 顺带记录一个 OB 本来就有的毛病(不是星图引入的,星图也修不了它)"
A=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:$OB_PORT/auth/login" -H 'Content-Type: application/json' -d '{"password":"wrongpass"}')
N=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:$OB_PORT/auth/login" -H 'Content-Type: application/json' -d '{"password":"错的口令"}')
echo "     纯英文错口令 → $A(应为 401)   含中文错口令 → $N"
if [ "$N" = "500" ]; then
  echo "  ⚠ 已知:口令里带非 ASCII 字符时 OB 回 500 并在日志里留一条 Traceback,而不是 401。"
  echo "     根因:server.py 的 _verify_any_password 用 hmac.compare_digest 直接比两个 str"
  echo "     (Python 对含非 ASCII 的 str 会抛 TypeError)。仅在用 OMBRE_DASHBOARD_PASSWORD 那条路上。"
  echo "     影响:记忆库后台的登录框同样如此;不是越权、不是数据问题,就是打错字时报错难看。"
  echo "     2026-08-29 实测。修不修等所有者点头 —— 改的是 OB,不在星图这次的范围里。"
elif [ "$N" = "401" ]; then
  echo "  ✓ 这个毛病已经被修好了 —— 把本段(G)从脚本里删掉即可。"
fi

[ $E2E -eq 0 ] && [ $fail -eq 0 ]

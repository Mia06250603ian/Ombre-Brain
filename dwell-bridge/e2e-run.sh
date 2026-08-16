#!/bin/sh
# 端到端演练：假 shim + 真 dwell-bridge，走一遍「登录 → 发话 → 收流 → 对账」。
# 不碰任何线上服务。跑法：./e2e-run.sh

set -e
cd "$(dirname "$0")"

node e2e-fake-shim.mjs 8791 &
FAKE=$!
SHIM_URL=http://127.0.0.1:8791 SHIM_KEY=testkey DWELL_PASS=hunter2 PORT=8790 node server.js &
BR=$!
trap 'kill $FAKE $BR 2>/dev/null || true' EXIT
sleep 1

fail=0
say() { printf '%s\n' "$1"; }
check() { if [ "$2" = "$3" ]; then say "  ✓ $1"; else say "  ✗ $1 — 实际[$2] 期望[$3]"; fail=1; fi; }
has()   { if printf '%s' "$2" | grep -q "$3"; then say "  ✓ $1"; else say "  ✗ $1 — 没找到[$3] 于 $2"; fail=1; fi; }
hasnt() { if printf '%s' "$2" | grep -q "$3"; then say "  ✗ $1 — 不该出现[$3]"; fail=1; else say "  ✓ $1"; fi; }

say "① 没登录时"
check "根路径给登录页" "$(curl -s localhost:8790/ | grep -c '口令')" "1"
check "接口一律 401" "$(curl -s -o /dev/null -w '%{http_code}' localhost:8790/api/messages)" "401"
check "发话也被挡" "$(curl -s -o /dev/null -w '%{http_code}' -X POST localhost:8790/api/send -H 'Content-Type: application/json' -d '{"text":"喂"}')" "401"

say "①b 图标与 manifest 不上锁，但不能顺带泄出页面"
check "图标不带口令能取" "$(curl -s -o /dev/null -w '%{http_code}' localhost:8790/icons/icon-180.png)" "200"
check "manifest 不带口令能取" "$(curl -s -o /dev/null -w '%{http_code}' localhost:8790/manifest.json)" "200"
check "/index.html 取不到（没把整个 web/ 静态化）" "$(curl -s -o /dev/null -w '%{http_code}' localhost:8790/index.html)" "404"
check "未登录的根路径不含真页面" "$(curl -s localhost:8790/ | grep -c 'function handle')" "0"

say "② 登录"
check "错口令被拒" "$(curl -s -o /dev/null -w '%{http_code}' -X POST localhost:8790/login -d 'pass=wrong')" "401"
curl -s -c /tmp/dwell-jar -o /dev/null -X POST localhost:8790/login -d 'pass=hunter2'
check "对口令拿到 cookie" "$(grep -c dwell /tmp/dwell-jar)" "1"
check "登录后接口放行" "$(curl -s -b /tmp/dwell-jar -o /dev/null -w '%{http_code}' localhost:8790/api/messages)" "200"

say "③ 发一句话，收整条流"
curl -s -b /tmp/dwell-jar -X POST localhost:8790/api/send \
  -H 'Content-Type: application/json' -d '{"text":"你还记得吗"}' > /dev/null
sleep 2
POLL=$(curl -s -b /tmp/dwell-jar 'localhost:8790/api/poll?since=0')
has   "回显了她的话"       "$POLL" 'echo'
has   "思考流到了"         "$POLL" 'thinking_delta'
has   "正文流到了"         "$POLL" 'text_delta'
has   "工具变成了卡片"     "$POLL" 'tool_use'
has   "工具名跨块拼对了"   "$POLL" 'ombre-brain__breath'
has   "工具当场收了尾"     "$POLL" 'tool_result'
has   "贴纸换成中文占位"   "$POLL" '贴纸：贴贴'
has   "语音提示在"         "$POLL" '语音'
has   "语音里的话留住了"   "$POLL" 'Good night'
has   "收尾事件到了"       "$POLL" '"type":"result"'
hasnt "裸贴纸标记没漏出去" "$POLL" '\[贴纸:'
hasnt "裸语音标记没漏出去" "$POLL" '\[/语音\]'
hasnt "裸工具标记没漏出去" "$POLL" '🔧'

say "④ 账本对得上"
MSG=$(curl -s -b /tmp/dwell-jar 'localhost:8790/api/messages?limit=400')
has "她那条记下了" "$MSG" '"kind":"me"'
has "他那条记下了" "$MSG" '"kind":"gu"'
has "思考记下了"   "$MSG" '"kind":"think"'
has "工具记下了"   "$MSG" '"kind":"tool"'

say "④b 历史给的游标必须是事件游标（否则实时流会被整段重放 → 对话重复）"
UPTO=$(curl -s -b /tmp/dwell-jar 'localhost:8790/api/messages?limit=400' | sed 's/.*"upto":\([0-9]*\).*/\1/')
CUR=$(curl -s -b /tmp/dwell-jar 'localhost:8790/api/poll?since=999999' | sed 's/.*"next":\([0-9]*\).*/\1/')
check "upto 等于事件游标而不是消息条数" "$UPTO" "$CUR"
check "拿 upto 去 poll 收不到旧事件" "$(curl -s -b /tmp/dwell-jar "localhost:8790/api/poll?since=$UPTO" | grep -c '"events":\[\]')" "1"

say "⑤ 游标不回头"
check "同一个游标不重复给" "$(curl -s -b /tmp/dwell-jar 'localhost:8790/api/poll?since=999999' | grep -c '"events":\[\]')" "1"

say "⑥ 转发给上游的辅助信息"
has "型号取自上游" "$(curl -s -b /tmp/dwell-jar localhost:8790/api/model)" 'claude-opus-4-6'
has "窗口占用取自守卫" "$(curl -s -b /tmp/dwell-jar localhost:8790/api/context)" '42000'

say ""
if [ "$fail" = "0" ]; then say "✓ 端到端全绿"; else say "✗ 有挂的"; fi
exit $fail

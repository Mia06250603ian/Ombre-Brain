#!/usr/bin/env bash
# e2e-run.sh — 端到端演练:起真的 agent-bridge + 假的 claude,走完整条路。
# **不联网、不碰线上、不烧额度。** 部署前必跑(和 test-agent.mjs 一起)。
#
# ⚠️ 两个坑照抄 dwell-bridge 第四次部署记录,别再吃一遍:
#   ① 后台进程活不过一次命令调用 → 起服务和打请求必须写在同一条命令里(本脚本就是干这个的)
#   ② 上一轮的服务会占着端口不退,新的静默 EADDRINUSE、测试打在旧的上 →
#      **换端口比 pkill 可靠**,所以端口默认带上时间戳的后两位。

set -uo pipefail
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-1$(date +%S)$((RANDOM % 9))}"
KEY="e2e-key"
fail=0
ok(){ printf '  ✓ %s\n' "$*"; }
bad(){ printf '  ✗ %s\n' "$*"; fail=1; }

# 假 claude 顶替真的;WORK_DIR 指向临时目录,免得去 clone 仓库
export AGENT_KEY="$KEY" PORT="$PORT" \
       CLAUDE_BIN="$PWD/fake-claude.sh" \
       WORK_DIR="$(mktemp -d)" GITHUB_TOKEN="" \
       GONG_WAIT_MS=4000 FAKE_GAP_MS=60

# claude 的启动参数里有 -p/--tools 之类,假货一律忽略,只读 stdin
cat > fake-claude.sh <<'SH'
#!/usr/bin/env bash
exec node "$(dirname "$0")/e2e-fake-claude.mjs"
SH
chmod +x fake-claude.sh

node server.mjs > /tmp/agent-e2e.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -f fake-claude.sh' EXIT

for i in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break
  sleep 0.25
done

H=(-H "x-agent-key: $KEY" -H "Content-Type: application/json")

echo "① 没带钥匙一律 401"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/gong")
[ "$code" = "401" ] && ok "裸访问 401" || bad "裸访问给了 $code,应该是 401"

echo "② 开工位:第一句话前面必须拼上开场白"
# 假 claude 会把收到的前 12 个字回显出来。第一轮收到的应当是 boot.md 的开头,
# **不是**她那句话 —— 那正好证明开场白喂进去了(没有它,接出去的会话不知道这套系统的任何规矩)。
r=$(curl -s "${H[@]}" -d '{"text":"看看晏还活着没"}' "http://127.0.0.1:$PORT/api/gong")
echo "$r" | grep -q '"reply"' && ok "有 reply 字段" || bad "没有 reply:$r"
echo "$r" | grep -q '维护会' && ok "第一轮拼上了 boot.md" || bad "开场白没喂进去:$r"

echo "②' 第二句话原样送达(开场白只拼第一次)"
r1b=$(curl -s "${H[@]}" -d '{"text":"看看晏还活着没"}' "http://127.0.0.1:$PORT/api/gong")
echo "$r1b" | grep -q '看看晏还活着没' && ok "原话送达,没有再拼开场白" || bad "内容对不上:$r1b"

echo "③ 工具行进了思考栏,没混进正文"
echo "$r" | grep -q '🔧' && ok "思考里有工具行" || bad "工具行丢了:$r"
echo "$r" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if "🔧" not in d["reply"] else 1)' \
  && ok "正文里没有工具行" || bad "工具行污染了正文"

echo "④ 历史回得出来,role 只有 her/gong"
g=$(curl -s "${H[@]}" "http://127.0.0.1:$PORT/api/gong")
echo "$g" | python3 -c '
import json,sys
d=json.load(sys.stdin); roles=[m["role"] for m in d["msgs"]]
assert roles[:2]==["her","gong"], roles
assert all(k in d["msgs"][0] for k in ("role","text","think")), d["msgs"][0]
' && ok "字段和顺序都对(前端 gongRow 直接读这几个键)" || bad "账本结构不对:$g"

echo "⑤ 它还在说的时候再发一句 = 叫停 + 插话(这一版的暂停键)"
# ⚠️ 这里只能 `wait $那一个 pid`。裸 `wait` 会连**服务进程**一起等,
#    而服务永远不退 —— 脚本就挂死在这行(2026-09-12 写这份 e2e 时当场踩到)。
curl -s "${H[@]}" -d '{"text":"慢慢说"}' "http://127.0.0.1:$PORT/api/gong" >/dev/null &
BG=$!
sleep 0.4
r2=$(curl -s "${H[@]}" -d '{"text":"别说了,换个方向"}' "http://127.0.0.1:$PORT/api/gong")
wait $BG 2>/dev/null
echo "$r2" | grep -q '换个方向' && ok "插的话确实喂进去了" || bad "插话没生效:$r2"
code=$(curl -s -o /dev/null -w '%{http_code}' "${H[@]}" -d '{"text":"x"}' "http://127.0.0.1:$PORT/api/gong")
[ "$code" = "200" ] && ok "忙的时候不回 409(那间屋没有按钮,回 409 等于没法叫停)" || bad "给了 $code"

echo "⑥ 工位状态看得见"
s=$(curl -s "${H[@]}" "http://127.0.0.1:$PORT/api/agent/state")
echo "$s" | grep -q '"open":true' && ok "工位开着" || bad "状态不对:$s"
echo "$s" | grep -q '"costUSD"' && ok "花了多少钱看得见(她要盯额度)" || bad "没有 costUSD:$s"

echo "⑦ 收工:进程退掉、账本清空"
curl -s "${H[@]}" -X POST "http://127.0.0.1:$PORT/api/agent/close" >/dev/null
sleep 0.6
s=$(curl -s "${H[@]}" "http://127.0.0.1:$PORT/api/agent/state")
echo "$s" | grep -q '"open":false' && ok "工位关了" || bad "还开着:$s"
g=$(curl -s "${H[@]}" "http://127.0.0.1:$PORT/api/gong")
echo "$g" | grep -q '"msgs":\[\]' && ok "账本清空了" || bad "账本还在:$g"

echo
[ "$fail" = 0 ] && echo "✅ e2e 全过(端口 $PORT)" || { echo "❌ e2e 有没过的,日志:/tmp/agent-e2e.log"; tail -20 /tmp/agent-e2e.log; }
exit $fail

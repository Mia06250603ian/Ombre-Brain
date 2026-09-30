#!/bin/bash
# e2e-recall-run.sh — 自动浮现(2026-09-30)整链路测试:真 server.js + 真 claude 二进制 + 假 Anthropic + 假 OB。
# 零额度、不碰线上。改 recall.mjs / server.js 里自动浮现那段之后跑一遍。
#
#   bash e2e-recall-run.sh
#
# 验的是这几件(每件都对着「晏实际收到的那句话」断言,不是对着日志猜):
#   1. observe 档:问了 OB、记下了,但**晏收到的话里没有**【系统·浮现】
#   2. observe 也记冷却:下一句同一件旧事,OB 被带上 exclude
#   3. 运行时 POST /recall 切 on:不重启(claude 只 spawn 一次)、**真递进去了**,她的原话还在后面
#   4. 等 OB 的那一下不许乱序:慢的那句先发,紧跟一句「嗯嗯」(不问 OB),晏收到的顺序不能反
#   5. OB 超时:照常发、不附、记 timeout
#   6. 晚安这类重置词不去问 OB;切 off 之后一概不问
#   7. /recall 要 key
# 全绿输出 "E2E RECALL ALL PASS"。
set -u
SHIM_DIR="$(cd "$(dirname "$0")" && pwd)"
VER="$(node -p "require('$SHIM_DIR/package.json').dependencies['@anthropic-ai/claude-code'].replace(/^[^0-9]*/,'')")"
PLAT="$(node -p "({'linux-x64':'linux-x64','linux-arm64':'linux-arm64','darwin-x64':'darwin-x64','darwin-arm64':'darwin-arm64'})[process.platform+'-'+process.arch]||''")"
[ -n "$PLAT" ] || { echo "不支持的平台"; exit 1; }
CACHE="${TMPDIR:-/tmp}/kelivo-shim-e2e-cli/$VER-$PLAT"
BIN="$CACHE/package/claude"
if [ ! -x "$BIN" ]; then
  echo "[e2e] 下载 claude $VER ($PLAT) ..."
  mkdir -p "$CACHE" && cd "$CACHE"
  npm pack "@anthropic-ai/claude-code-$PLAT@$VER" --silent >/dev/null || { echo "下载失败"; exit 1; }
  tar xzf ./*.tgz && rm -f ./*.tgz && chmod +x "$BIN"
fi
DEPS="${TMPDIR:-/tmp}/kelivo-shim-e2e-deps"
if [ ! -d "$DEPS/node_modules/express" ]; then
  mkdir -p "$DEPS" && (cd "$DEPS" && npm install --silent --no-save express >/dev/null) || { echo "express 安装失败"; exit 1; }
fi

WORK="${TMPDIR:-/tmp}/kelivo-shim-e2e-recall-work"
rm -rf "$WORK" && mkdir -p "$WORK" && cd "$WORK"
# ⚠️ server.js 每 import 一个新模块,这行就得跟着加(踩坑 20)
cp "$SHIM_DIR"/server.js "$SHIM_DIR"/ctxguard.mjs "$SHIM_DIR"/senses.mjs "$SHIM_DIR"/keepalive.mjs "$SHIM_DIR"/apierror.mjs "$SHIM_DIR"/sysprompt.mjs "$SHIM_DIR"/toolvis.mjs "$SHIM_DIR"/auth-env.mjs "$SHIM_DIR"/cli-bin.mjs "$SHIM_DIR"/think-translate.mjs "$SHIM_DIR"/flagfallback.mjs "$SHIM_DIR"/recall.mjs .
cp "$SHIM_DIR"/shim-settings.json "$SHIM_DIR"/precompact-note.txt "$SHIM_DIR"/base.md .
sed -i "s#/src/precompact-note.txt#$WORK/precompact-note.txt#" shim-settings.json
ln -s "$DEPS/node_modules" node_modules
echo '{ "mcpServers": {} }' > mcp-empty.json
printf '%s' "{\"hasCompletedOnboarding\":true,\"projects\":{\"$WORK\":{\"hasTrustDialogAccepted\":true,\"hasCompletedProjectOnboarding\":true}}}" > .claude.json

E2E_DIR="$WORK" node "$SHIM_DIR/e2e-recall-api.mjs" 2>fake.log &
FPID=$!
# ⚠️ `env -i` 必须留着(同 e2e-run.sh:别让外面的真令牌混进来烧真额度)
env -i HOME="$WORK" PATH="$PATH" \
  PORT=8510 CLAUDE_BIN="$BIN" SHIM_KEY=k \
  ANTHROPIC_BASE_URL=http://127.0.0.1:8511 ANTHROPIC_AUTH_TOKEN=fake \
  RECALL_MODE=observe RECALL_URL=http://127.0.0.1:8512/api/recall RECALL_TOKEN=e2e-recall RECALL_TIMEOUT_MS=1000 \
  MCP_CONFIG=mcp-empty.json MCP_WARMUP_MS=300 KA_ON=0 TIME_HINT=0 CTX_GUARD_ON=0 \
  BUILTIN_TOOLS=Read ALLOWED_TOOLS=Read \
  DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  node "$WORK/server.js" >shim.log 2>&1 &
SPID=$!
trap 'kill $SPID $FPID 2>/dev/null' EXIT
sleep 2

send() {  # 同步发一句(等回完)
  curl -sS -X POST http://127.0.0.1:8510/v1/messages -H 'Content-Type: application/json' -H 'x-api-key: k' \
    -d "{\"model\":\"claude-opus-4-6\",\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"$1\"}]}" >/dev/null
}
mode() { curl -sS -X POST "http://127.0.0.1:8510/recall?key=k" -H 'Content-Type: application/json' -d "{\"mode\":\"$1\"}" >/dev/null; }

send "团子今天又吐了"                       # 1 observe:挑中团子,但不递
send "团子今天还是不吃"                     # 2 observe 记过冷却 → exclude 带团子 → 不挑
mode on
send "阿蟹被我压扁了"                       # 3 on:真递
# 4 乱序:小雅那句 OB 要拖 800ms;紧跟一句「嗯」(太短不问 OB),必须排在它后面
send "小雅又惹我生气了" & P1=$!; sleep 0.2; send "嗯" & P2=$!; wait $P1 $P2   # 只等这两句:光写 wait 会连假服务一起等,永远不返回
send "慢死了今天"                           # 5 OB 拖 3000ms > 超时 1000ms
send "晚安"                                 # 6 重置词不问
mode off
send "团子团子团子"                         # 6 off 不问
curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:8510/recall" > noauth.txt
curl -sS "http://127.0.0.1:8510/recall?key=k" > recall.json
curl -sS "http://127.0.0.1:8510/debug" > debug.json
sleep 0.5

E2E_WORK="$WORK" node - <<'EOF'
const fs = require("fs");
const W = process.env.E2E_WORK;
const seen = JSON.parse(fs.readFileSync(`${W}/seen.json`, "utf8"));
const obseen = JSON.parse(fs.readFileSync(`${W}/obseen.json`, "utf8"));
const rec = JSON.parse(fs.readFileSync(`${W}/recall.json`, "utf8"));
const dbg = JSON.parse(fs.readFileSync(`${W}/debug.json`, "utf8"));
const slog = fs.readFileSync(`${W}/shim.log`, "utf8");
let bad = 0;
const ok = (c, name) => { if (!c) { bad++; console.error("FAIL:", name); } };
const find = (kw) => seen.findIndex((s) => s.includes(kw));
const HINT = "【系统·浮现】";

// 1 observe 不递
const i1 = find("团子今天又吐了");
ok(i1 >= 0 && !seen[i1].includes(HINT), "observe:晏收到的话里没有浮现行");
const log1 = rec.log.find((o) => o.preview.startsWith("团子今天又吐了"));
ok(log1 && log1.pick && log1.pick.name === "团子去宠物医院" && log1.injected === false, "observe:记录里有「本来会递团子」、injected=false");
// 2 observe 也记冷却
const q2 = obseen.find((o) => o.q === "团子今天还是不吃");
ok(q2 && q2.exclude.includes("tuanzi000001"), "observe 记了冷却:第二句带 exclude");
ok(!seen[find("团子今天还是不吃")].includes(HINT), "冷却中不递");
ok(q2 && q2.n === "240" && q2.minAge === "24", "带上摘录上限与最小桶龄(默认 240 / 24)");
// 3 切 on 真递,原话在后
const s3 = seen[find("阿蟹被我压扁了")];
ok(s3.includes(HINT) && s3.includes("她给螃蟹玩偶起名叫阿蟹。") && s3.includes('dream(detail_ids="axie00000001")'), "on:浮现行真递进去了");
ok(s3.indexOf(HINT) < s3.indexOf("阿蟹被我压扁了"), "浮现行在她的话前面");
ok(s3.trim().endsWith("阿蟹被我压扁了"), "她的原话原样在末尾");
ok(/\[recall\] mode -> on/.test(slog), "日志记了切档");
// 4 不乱序
const iA = find("小雅又惹我生气了"), iB = seen.findIndex((s) => s.trim() === "嗯");
ok(iA >= 0 && iB >= 0 && iA < iB, `等 OB 的那句先到(小雅 ${iA} < 嗯 ${iB})`);
ok(seen[iA].includes(HINT), "小雅那句等到了、递了");
ok(!obseen.some((o) => o.q === "嗯"), "「嗯」太短,没问 OB(走的是「不问但排队」那条路)");
// 5 超时
const i5 = find("慢死了今天");
ok(i5 >= 0 && !seen[i5].includes("超时了还递进去就是 bug"), "OB 超时:照常发、不附");
ok(rec.log.some((o) => o.preview.startsWith("慢死了今天") && o.reason === "timeout"), "记录里写着 timeout");
// 6 重置词 / off 不问
ok(!obseen.some((o) => o.q.includes("晚安")), "晚安不问 OB");
ok(!obseen.some((o) => o.q.includes("团子团子团子")), "off 之后不问 OB");
ok(find("团子团子团子") >= 0, "off 之后消息照常到");
// 全程不重启
ok((slog.match(/\[claude\] spawned/g) || []).length === 1, "claude 只 spawn 一次(切档不丢窗口)");
// 7 鉴权 / 观察口
ok(fs.readFileSync(`${W}/noauth.txt`, "utf8").trim() === "401", "/recall 不带 key = 401");
ok(rec.mode === "off" && rec.configuredMode === "observe", "/recall 报当前档与变量档");
ok(dbg.recall && dbg.recall.mode === "off" && !("log" in dbg.recall), "/debug 只给摘要、不带记录");
ok(!JSON.stringify(rec).includes("团子连着吐了两天"), "观察记录里不存记忆正文");
// 每窗计数 = 阿蟹 + 小雅 = 2。observe 那次团子也 +1 了,但它是这个窗口的第一句:随后 spawn 新进程把计数清零。
// 即「每个窗口第一句不计数」,上限最多松一条,无害;别为它改 spawn 的清零时机。
ok(rec.windowCount === 2, `每窗计数(got ${rec.windowCount})`);

if (bad) { console.error(`\n${bad} 项断言失败(shim.log / fake.log / seen.json / obseen.json 在 ${W})`); process.exit(1); }
console.log("E2E RECALL ALL PASS");
EOF

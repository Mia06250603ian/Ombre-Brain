#!/bin/bash
# e2e-apierror-run.sh — 上游报错整链路测试:真 server.js + 真 claude 二进制 + 一直 401 的假后端。
# 零额度、不碰线上。2026-08-11 新增,验的是那场「空回复」事故的那一格:
#   上游断了 → CLI 发 system/api_retry(报错不走流事件)+ 常驻模式下 result 仍报 success
#   → shim 必须认出来、对她发起的回合说一句人话、对系统/保温回合只记账不出声、
#     并且**不**把这一轮当成功(否则断链检测永不醒)。
#
#   bash e2e-apierror-run.sh
#
# ⚠️ 慢:CLI 对 401 会重试十次左右(指数退避),**一轮就要两三分钟**,两轮五六分钟是正常的。
# 全绿输出 "E2E-APIERROR ALL PASS"。临时文件和 CLI 二进制缓存都在 /tmp,不进部署目录。
set -u
SHIM_DIR="$(cd "$(dirname "$0")" && pwd)"
VER="${E2E_CLI_VERSION:-$(node -p "require('$SHIM_DIR/package.json').dependencies['@anthropic-ai/claude-code'].replace(/^[^0-9]*/,'')")}"
PLAT="$(node -p "({'linux-x64':'linux-x64','linux-arm64':'linux-arm64','darwin-x64':'darwin-x64','darwin-arm64':'darwin-arm64'})[process.platform+'-'+process.arch]||''")"
[ -n "$PLAT" ] || { echo "不支持的平台:$(node -p 'process.platform+"-"+process.arch')"; exit 1; }

CACHE="${TMPDIR:-/tmp}/kelivo-shim-e2e-cli/$VER-$PLAT"
BIN="$CACHE/package/claude"
if [ ! -x "$BIN" ]; then
  echo "[e2e] 下载 claude $VER ($PLAT) ..."
  mkdir -p "$CACHE" && cd "$CACHE"
  npm pack "@anthropic-ai/claude-code-$PLAT@$VER" --silent >/dev/null || { echo "下载失败"; exit 1; }
  tar xzf ./*.tgz && rm -f ./*.tgz && chmod +x "$BIN"
fi
echo "[e2e] CLI: $("$BIN" --version)"

DEPS="${TMPDIR:-/tmp}/kelivo-shim-e2e-deps"
if [ ! -d "$DEPS/node_modules/express" ]; then
  mkdir -p "$DEPS" && (cd "$DEPS" && npm install --silent --no-save express >/dev/null) || { echo "express 安装失败"; exit 1; }
fi

WORK="${TMPDIR:-/tmp}/kelivo-shim-e2e-apierror"
rm -rf "$WORK" && mkdir -p "$WORK" && cd "$WORK"
cp "$SHIM_DIR"/server.js "$SHIM_DIR"/ctxguard.mjs "$SHIM_DIR"/senses.mjs "$SHIM_DIR"/keepalive.mjs "$SHIM_DIR"/apierror.mjs .
cp "$SHIM_DIR"/shim-settings.json "$SHIM_DIR"/precompact-note.txt .
sed -i "s#/src/precompact-note.txt#$WORK/precompact-note.txt#" shim-settings.json
ln -s "$DEPS/node_modules" node_modules
echo '{ "mcpServers": {} }' > mcp-empty.json
printf '%s' "{\"hasCompletedOnboarding\":true,\"projects\":{\"$WORK\":{\"hasTrustDialogAccepted\":true,\"hasCompletedProjectOnboarding\":true}}}" > .claude.json

E2E_DIR="$WORK" E2E_API_PORT=8503 node "$SHIM_DIR/e2e-apierror-api.mjs" 2>fake.log &
FPID=$!
env -i HOME="$WORK" PATH="$PATH" \
  PORT=8502 CLAUDE_BIN="$BIN" \
  ANTHROPIC_BASE_URL=http://127.0.0.1:8503 ANTHROPIC_AUTH_TOKEN=fake \
  MCP_CONFIG=mcp-empty.json MCP_WARMUP_MS=300 KA_ON=0 TIME_HINT=0 \
  BUILTIN_TOOLS=Read ALLOWED_TOOLS=Read \
  DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  node "$WORK/server.js" >shim.log 2>&1 &
SPID=$!
trap 'kill $SPID $FPID 2>/dev/null' EXIT
sleep 2

echo "[e2e] 第一轮(非流式,模拟 Kelivo)——CLI 要重试十次左右,请等两三分钟 ..."
curl -sS --max-time 600 -X POST http://127.0.0.1:8502/v1/messages -H 'Content-Type: application/json' \
  -d '{"model":"claude-opus-4-6","stream":false,"messages":[{"role":"user","content":"在吗"}]}' > json-resp.json
curl -sS http://127.0.0.1:8502/debug > debug-1.json

echo "[e2e] 第二轮(流式,模拟 telegram-bridge)..."
curl -sS --max-time 600 -N -X POST http://127.0.0.1:8502/v1/messages -H 'Content-Type: application/json' \
  -d '{"model":"claude-opus-4-6","stream":true,"messages":[{"role":"user","content":"你还在吗"}]}' > sse-resp.txt
curl -sS http://127.0.0.1:8502/debug > debug-2.json

# 第三轮:系统回合(bridge 的查岗/写信提醒走这条,带 x-system-turn: 1)。
# 上游断着的时候这一轮必须**一个字都不发**——否则宵禁那几个钟头她会被报错反复吵。
echo "[e2e] 第三轮(系统回合 x-system-turn:1,必须静默)..."
curl -sS --max-time 600 -X POST http://127.0.0.1:8502/v1/messages -H 'Content-Type: application/json' \
  -H 'x-system-turn: 1' \
  -d '{"model":"claude-opus-4-6","stream":false,"messages":[{"role":"user","content":"【系统·查岗】"}]}' > sys-resp.json
sleep 1

node - <<'EOF'
const fs = require("fs");
const W = process.env.E2E_WORK || process.cwd();
const rd = (f) => fs.readFileSync(`${W}/${f}`, "utf8");
let bad = 0;
const ok = (c, name) => { if (!c) { bad++; console.error("FAIL:", name); } else console.log("  ok:", name); };

// ---- 非流式(Kelivo 那条路):正文里必须有人话,不能是空的 ----
const j = JSON.parse(rd("json-resp.json"));
const text = (j.content || []).map((c) => c.text || "").join("");
ok(text.length > 0, `非流式回包必须有正文(事故当天这里是空的)got=${JSON.stringify(text).slice(0, 90)}`);
ok(text.includes("⚠️[shim]"), "正文带 shim 前缀");
ok(text.includes("401"), "正文带上游状态码 401");
ok(text.includes("不是他不理你"), "正文说清不是他的问题");

// ---- 流式(bridge 那条路):SSE 里必须有 text_delta,否则 bridge 又会回落成「空回复」----
const sse = rd("sse-resp.txt");
ok(/"type":"text_delta"/.test(sse), "SSE 里有 text_delta(bridge 靠它攒正文)");
ok(sse.includes("401"), "SSE 正文里带 401");
ok(/event: message_stop/.test(sse), "SSE 正常收尾");

// ---- /debug 的新观察口 ----
const d1 = JSON.parse(rd("debug-1.json")), d2 = JSON.parse(rd("debug-2.json"));
ok(d1.lastApiError && typeof d1.lastApiError.at === "string", "/debug 记下了 lastApiError");
ok(d1.lastApiError && d1.lastApiError.kind.includes("401"), `lastApiError.kind 认出 401(got ${d1.lastApiError && d1.lastApiError.kind})`);
// text 来自 api_retry(结构化),留的是错误类型 + 重试次数——
// 「打满 10/10 = 真断了 / 只有 1/10 = 那一下是抖动」全靠这个数分辨,比上游那句英文散文有用。
ok(d1.lastApiError && /retry \d+\/\d+/.test(d1.lastApiError.text), `lastApiError.text 留了重试次数(got ${d1.lastApiError && d1.lastApiError.text})`);
ok(d1.lastApiError && d1.lastApiError.text.includes("authentication_failed"), "lastApiError.text 留了上游给的错误类型");
ok(d2.lastApiError.at >= d1.lastApiError.at, "第二轮刷新了 lastApiError");

// ---- 系统回合:记账但不出声 ----
const sysj = JSON.parse(rd("sys-resp.json"));
const systext = (sysj.content || []).map((c) => c.text || "").join("");
ok(systext === "", `系统回合必须静默(got ${JSON.stringify(systext).slice(0, 80)})`);

// ---- 日志:必须进 [result-error],不能被当成功回合 ----
const slog = rd("shim.log");
ok((slog.match(/\[result-error\]/g) || []).length >= 3, "三轮都进了 [result-error](系统回合也记账)");
ok(/静默(非她发起的回合)/.test(slog) || /静默/.test(slog), "日志里留下了「静默」那一行(证明是不出声,不是没发现)");
ok(/\[result-error\].*上游/.test(slog), "日志里带上上游报错的短标识");
ok((slog.match(/\[claude\] spawned/g) || []).length === 1, "进程只 spawn 一次(报错不该把晏重启掉)");
ok(!/\[window\] restart/.test(slog), "不换窗口");

if (bad) { console.error(`\n${bad} 项断言失败(工作目录 ${W})`); process.exit(1); }
console.log("E2E-APIERROR ALL PASS");
EOF
RC=$?
exit $RC

#!/bin/bash
# e2e-run.sh — 上下文守卫整链路测试:真 server.js + 真 claude 二进制 + 假 Anthropic 后端。
# 零额度、不碰线上。用途:改守卫相关代码后、或【升级 CLI 版本前】,跑一遍确认整条链路没坏。
#
#   bash e2e-run.sh                    # 用 package.json 里钉死的 CLI 版本测(常规回归)
#   E2E_CLI_VERSION=2.1.220 bash e2e-run.sh   # 试装候选新版本测(升级前验证,见手册「CLI 升级指南」)
#
# 全绿输出 "E2E ALL PASS";任何一条断言失败退出码非 0 并打印差异。
# 临时文件和 CLI 二进制缓存都在 /tmp,不会混进部署目录。
set -u
SHIM_DIR="$(cd "$(dirname "$0")" && pwd)"
VER="${E2E_CLI_VERSION:-$(node -p "require('$SHIM_DIR/package.json').dependencies['@anthropic-ai/claude-code'].replace(/^[^0-9]*/,'')")}"
PLAT="$(node -p "({'linux-x64':'linux-x64','linux-arm64':'linux-arm64','darwin-x64':'darwin-x64','darwin-arm64':'darwin-arm64'})[process.platform+'-'+process.arch]||''")"
[ -n "$PLAT" ] || { echo "不支持的平台:$(node -p 'process.platform+"-"+process.arch')"; exit 1; }

# ---- 取 CLI 二进制(按版本缓存在 /tmp,重复跑不重复下载)----
CACHE="${TMPDIR:-/tmp}/kelivo-shim-e2e-cli/$VER-$PLAT"
BIN="$CACHE/package/claude"
if [ ! -x "$BIN" ]; then
  echo "[e2e] 下载 claude $VER ($PLAT) ..."
  mkdir -p "$CACHE" && cd "$CACHE"
  npm pack "@anthropic-ai/claude-code-$PLAT@$VER" --silent >/dev/null || { echo "下载失败:@anthropic-ai/claude-code-$PLAT@$VER"; exit 1; }
  tar xzf ./*.tgz && rm -f ./*.tgz && chmod +x "$BIN"
fi
echo "[e2e] CLI: $("$BIN" --version)"

# ---- 依赖缓存(express,server.js 要用;装一次反复用)----
DEPS="${TMPDIR:-/tmp}/kelivo-shim-e2e-deps"
if [ ! -d "$DEPS/node_modules/express" ]; then
  mkdir -p "$DEPS" && (cd "$DEPS" && npm install --silent --no-save express >/dev/null) || { echo "express 安装失败"; exit 1; }
fi

# ---- 工作目录(全在 /tmp;shim 源码拷副本进来跑,不动仓库目录)----
WORK="${TMPDIR:-/tmp}/kelivo-shim-e2e-work"
rm -rf "$WORK" && mkdir -p "$WORK" && cd "$WORK"
cp "$SHIM_DIR"/server.js "$SHIM_DIR"/ctxguard.mjs "$SHIM_DIR"/senses.mjs "$SHIM_DIR"/keepalive.mjs .
ln -s "$DEPS/node_modules" node_modules
echo '{ "mcpServers": {} }' > mcp-empty.json
echo "probe file content" > probe.txt
printf '%s' "{\"hasCompletedOnboarding\":true,\"projects\":{\"$WORK\":{\"hasTrustDialogAccepted\":true,\"hasCompletedProjectOnboarding\":true}}}" > .claude.json

E2E_DIR="$WORK" E2E_API_PORT=8501 node "$SHIM_DIR/e2e-fake-api.mjs" 2>fake.log &
FPID=$!
env -i HOME="$WORK" PATH="$PATH" \
  PORT=8500 CLAUDE_BIN="$BIN" \
  ANTHROPIC_BASE_URL=http://127.0.0.1:8501 ANTHROPIC_AUTH_TOKEN=fake \
  MCP_CONFIG=mcp-empty.json MCP_WARMUP_MS=300 KA_ON=0 TIME_HINT=0 \
  BUILTIN_TOOLS=Read ALLOWED_TOOLS=Read \
  CTX_SOFT_TOKENS=30000 CTX_HARD_TOKENS=60000 CTX_ARCHIVE_EVERY_TOKENS=20000 \
  DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  node "$WORK/server.js" >shim.log 2>&1 &
SPID=$!
trap 'kill $SPID $FPID 2>/dev/null' EXIT
sleep 2

msg() {
  curl -sS -X POST http://127.0.0.1:8500/v1/messages -H 'Content-Type: application/json' \
    -d "{\"model\":\"claude-opus-4-6\",\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"$1\"}]}" >/dev/null
  sleep 1.5
  curl -sS http://127.0.0.1:8500/debug >> debug-snaps.jsonl; echo >> debug-snaps.jsonl
}
: > debug-snaps.jsonl
msg "hello one"; msg "hello two"; msg "hello three"; msg "hello four"; msg "hello five"
msg "hello six"; msg "hello seven"; msg "hello eight"; msg "hello nine"
sleep 1

# ---- 断言 ----
node - <<'EOF'
const fs = require("fs");
const W = process.env.E2E_WORK || process.cwd();
const snaps = fs.readFileSync(`${W}/debug-snaps.jsonl`, "utf8").trim().split("\n").map(JSON.parse);
const seen = JSON.parse(fs.readFileSync(`${W}/seen.json`, "utf8"));
let bad = 0;
const ok = (c, name) => { if (!c) { bad++; console.error("FAIL:", name); } };

// 每条消息后的 /debug:[tokens, softFired, lastArchiveTokens, compactions]
const want = [
  [20505, false, 0, 0, "msg1 工具轮:读真实 20505(总和 40510 是老 bug),不误报"],
  [35515, false, 0, 0, "msg2 后窗口 35515(下一条才注软提示)"],
  [20005, false, 0, 0, "msg3 带软提示;结果回落 20005 → softFired 已自动复位"],
  [65010, false, 0, 0, "msg4 后窗口 65010(下一条才注硬提示)"],
  [65115, false, 65010, 0, "msg5 带硬提示归档(不换窗),归档基线记 65010"],
  [86000, true, 65010, 0, "msg6 带第二轮软提示(复位后重臂),硬线间隔未满不催"],
  [21000, false, 0, 1, "msg7 带增量归档提示;读数暴跌 → 判定压缩,守卫记账复位"],
  [31000, false, 0, 1, "msg8 压缩后新周期,未到软线无提示"],
  [31200, true, 0, 1, "msg9 带第二轮周期的软提示(压缩后守卫复活)"],
];
ok(snaps.length === 9, `9 份 /debug 快照(got ${snaps.length})`);
want.forEach(([tok, fired, arch, comp, name], i) => {
  const s = snaps[i]; if (!s) return ok(false, name);
  ok(s.contextTokens === tok, `${name}(tokens got ${s.contextTokens}, want ${tok})`);
  ok(s.ctxGuard.trusted === true, `${name}(trusted 应为 true)`);
  ok(s.ctxGuard.softFired === fired, `${name}(softFired got ${s.ctxGuard.softFired}, want ${fired})`);
  ok(s.ctxGuard.lastArchiveTokens === arch, `${name}(lastArchiveTokens got ${s.ctxGuard.lastArchiveTokens}, want ${arch})`);
  ok(s.ctxGuard.compactions === comp, `${name}(compactions got ${s.ctxGuard.compactions}, want ${comp})`);
});

// 各次 API 调用的 prompt:软提示在 call4/call7/call10,硬提示在 call6/call8
ok(seen.length === 10, `共 10 次 API 调用(msg1 两次 + 其余各一,got ${seen.length})`);
seen.forEach((s, i) => {
  const soft = s.includes("先别自己动手存"), hard = s.includes("archive_session");
  if (i === 3) { ok(soft && !hard, "call4 应带软提示"); }
  else if (i === 5) { ok(hard && !soft, "call6 应带硬提示归档指令(首归)"); }
  else if (i === 6) { ok(soft && !hard, "call7 应带第二轮软提示(复位重臂)"); }
  else if (i === 7) { ok(hard && !soft, "call8 应带增量归档提示(涨满间隔)"); }
  else if (i === 9) { ok(soft && !hard, "call10 应带压缩后新周期的软提示"); }
  else ok(!s.includes("【系统·上下文】"), `call${i + 1} 不应带上下文提示`);
});

// 归档提示不换窗:整个流程 claude 进程只 spawn 一次,从无 [window] restart
const slog = fs.readFileSync(`${W}/shim.log`, "utf8");
ok(!slog.includes("[window] restart"), "全程不应出现 [window] restart(守卫不换窗)");
ok((slog.match(/\[claude\] spawned/g) || []).length === 1, "claude 进程只 spawn 一次(窗口全程存活)");
// 新守卫的硬文案不再教他收尾/换窗口
ok(!seen.some((s) => s.includes("下一句起就是新窗口")), "任何 prompt 不再出现「下一句起就是新窗口」");

if (bad) { console.error(`\n${bad} 项断言失败(shim.log/fake.log 在工作目录里)`); process.exit(1); }
console.log("E2E ALL PASS");
EOF
RC=$?
exit $RC

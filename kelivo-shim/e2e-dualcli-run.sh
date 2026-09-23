#!/bin/bash
# e2e-dualcli-run.sh — 双引擎 + 思考翻中文的整链路测试(2026-09-23):
# 真 server.js + **两份**真 claude 二进制 + 假 Anthropic 后端。零额度、不碰线上。
#
#   bash e2e-dualcli-run.sh
#   E2E_NEXT_VERSION=2.1.290 bash e2e-dualcli-run.sh   # 换新版那份的候选版本
#
# 三个阶段:
#   A 两份都在 —— 4.6 逐字走 2.1.215、5.5 走新版;5.5 的思考被翻成中文、4.6 的不翻;
#   B 新版不在 —— 5.5 从菜单消失,报 5.5 的请求留在 4.6,/health 报出来(看门狗靠它);
#   C 翻译开关清空 —— 5.5 的思考原样英文(急救开关管用)。
# 全绿输出 "E2E DUALCLI ALL PASS"。
set -u
SHIM_DIR="$(cd "$(dirname "$0")" && pwd)"
PLAT="$(node -p "({'linux-x64':'linux-x64','linux-arm64':'linux-arm64','darwin-x64':'darwin-x64','darwin-arm64':'darwin-arm64'})[process.platform+'-'+process.arch]||''")"
[ -n "$PLAT" ] || { echo "不支持的平台"; exit 1; }
MAIN_VER="$(node -p "require('$SHIM_DIR/package.json').dependencies['@anthropic-ai/claude-code'].replace(/^[^0-9]*/,'')")"
NEXT_VER="${E2E_NEXT_VERSION:-$(node -p "require('$SHIM_DIR/package.json').dependencies['claude-code-next'].replace(/^.*@/,'')")}"

fetch_bin() {  # $1=版本 → 打印二进制路径(按版本缓存在 /tmp,和别的 e2e 共用)
  local c="${TMPDIR:-/tmp}/kelivo-shim-e2e-cli/$1-$PLAT"
  if [ ! -x "$c/package/claude" ]; then
    mkdir -p "$c" && (cd "$c" && npm pack "@anthropic-ai/claude-code-$PLAT@$1" --silent >/dev/null && tar xzf ./*.tgz && rm -f ./*.tgz) >&2 || { echo "下载失败 $1" >&2; exit 1; }
  fi
  echo "$c/package/claude"
}
BIN="$(fetch_bin "$MAIN_VER")"; NBIN="$(fetch_bin "$NEXT_VER")"
echo "[e2e] main CLI: $("$BIN" --version)  next CLI: $("$NBIN" --version)"

DEPS="${TMPDIR:-/tmp}/kelivo-shim-e2e-deps"
if [ ! -d "$DEPS/node_modules/express" ]; then
  mkdir -p "$DEPS" && (cd "$DEPS" && npm install --silent --no-save express >/dev/null) || { echo "express 安装失败"; exit 1; }
fi

WORK="${TMPDIR:-/tmp}/kelivo-shim-e2e-dualcli-work"
rm -rf "$WORK" && mkdir -p "$WORK" && cd "$WORK"
# ⚠️ server.js 每 import 一个新模块,这行就得跟着加(踩坑 20:漏了的现象是满屏 connect refused)。
cp "$SHIM_DIR"/server.js "$SHIM_DIR"/ctxguard.mjs "$SHIM_DIR"/senses.mjs "$SHIM_DIR"/keepalive.mjs "$SHIM_DIR"/apierror.mjs "$SHIM_DIR"/sysprompt.mjs "$SHIM_DIR"/toolvis.mjs "$SHIM_DIR"/auth-env.mjs "$SHIM_DIR"/cli-bin.mjs "$SHIM_DIR"/think-translate.mjs .
cp "$SHIM_DIR"/shim-settings.json "$SHIM_DIR"/precompact-note.txt "$SHIM_DIR"/base.md .
sed -i "s#/src/precompact-note.txt#$WORK/precompact-note.txt#" shim-settings.json
ln -s "$DEPS/node_modules" node_modules
echo '{ "mcpServers": {} }' > mcp-empty.json
printf '%s' "{\"hasCompletedOnboarding\":true,\"projects\":{\"$WORK\":{\"hasTrustDialogAccepted\":true,\"hasCompletedProjectOnboarding\":true}}}" > .claude.json

M46=claude-opus-4-6
M55=claude-opus-5-5

start_shim() {  # $1=阶段名 $2=CLAUDE_BIN_NEXT(空=新版不在) $3=THINK_TRANSLATE_MODELS
  rm -f "$WORK/calls.json"
  E2E_DIR="$WORK" E2E_API_PORT=8701 node "$SHIM_DIR/e2e-dualcli-api.mjs" 2>"fake-$1.log" &
  FPID=$!
  # ⚠️ `env -i` 必须留着(理由同 e2e-run.sh:外面的真令牌会让 e2e 改打真 API)。
  # ⚠️⚠️ 注释只能写在这一行**之前**,写进续行会截断整条命令。
  env -i HOME="$WORK" PATH="$PATH" \
    PORT=8700 CLAUDE_BIN="$BIN" CLAUDE_BIN_NEXT="$2" THINK_TRANSLATE_MODELS="$3" \
    ANTHROPIC_BASE_URL=http://127.0.0.1:8701 ANTHROPIC_AUTH_TOKEN=fake \
    BRAIN_MODEL="$M46" BRAIN_MODELS="$M46 $M55" SYS_PROMPT_MODE=replace \
    MCP_CONFIG=mcp-empty.json MCP_WARMUP_MS=300 KA_ON=0 TIME_HINT=0 CTX_GUARD_ON=0 \
    BUILTIN_TOOLS=Read ALLOWED_TOOLS=Read \
    DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    node "$WORK/server.js" >"shim-$1.log" 2>&1 &
  SPID=$!
  sleep 2
}
stop_shim() { kill $SPID $FPID 2>/dev/null; sleep 1; }
trap 'kill ${SPID:-0} ${FPID:-0} 2>/dev/null' EXIT

# $1=文本 $2=模型 $3=输出文件(流式 SSE,模拟 Kelivo/Telegram 桥)
say() {
  curl -sS -N --max-time 90 -X POST http://127.0.0.1:8700/v1/messages -H 'Content-Type: application/json' \
    -d "{\"model\":\"$2\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"$1\"}]}" > "$WORK/$3"
  sleep 1
}

# ---- 阶段 A:两份都在,翻译开着 ----
start_shim A "$NBIN" "$M55"
curl -sS http://127.0.0.1:8700/v1/models > models-A.json
say "a1" "$M46" sse-a1.txt
curl -sS http://127.0.0.1:8700/health > health-A1.json
say "a2" "$M55" sse-a2.txt
curl -sS http://127.0.0.1:8700/health > health-A2.json
say "a3" "$M46" sse-a3.txt
cp calls.json calls-A.json
stop_shim

# ---- 阶段 B:新版不在 ----
start_shim B "" "$M55"
curl -sS http://127.0.0.1:8700/v1/models > models-B.json
say "b1" "$M55" sse-b1.txt
curl -sS http://127.0.0.1:8700/health > health-B.json
cp calls.json calls-B.json
stop_shim

# ---- 阶段 C:翻译急救开关 ----
start_shim C "$NBIN" ""
say "c1" "$M55" sse-c1.txt
cp calls.json calls-C.json
stop_shim

E2E_WORK="$WORK" MAIN_VER="$MAIN_VER" NEXT_VER="$NEXT_VER" node - <<'EOF'
const fs = require("fs");
const W = process.env.E2E_WORK, MAIN = process.env.MAIN_VER, NEXT = process.env.NEXT_VER;
const rd = (f) => fs.readFileSync(`${W}/${f}`, "utf8");
const js = (f) => JSON.parse(rd(f));
const M46 = "claude-opus-4-6", M55 = "claude-opus-5-5";
let bad = 0, n = 0;
const ok = (c, name) => { n++; if (!c) { bad++; console.error("FAIL:", name); } else console.log("  ok:", name); };
// 从 SSE 里按顺序拼出 [类型, 文本]
const blocks = (f) => {
  const out = [];
  for (const m of rd(f).matchAll(/^data: (.*)$/gm)) {
    let d; try { d = JSON.parse(m[1]); } catch { continue; }
    if (d.type === "content_block_delta" && d.delta.type === "thinking_delta") out.push(["think", d.delta.thinking]);
    if (d.type === "content_block_delta" && d.delta.type === "text_delta") out.push(["text", d.delta.text]);
  }
  return out;
};

// ── A ──
const mA = js("models-A.json").data.map((x) => x.id);
ok(mA.includes(M55), "A:新版在,5.5 进菜单");
const cA = js("calls-A.json"), main = cA.filter((c) => !c.translator), tr = cA.filter((c) => c.translator);
ok(main.length === 3, `A:三条消息三次主调用(got ${main.length})`);
ok(main[0].model === M46 && main[0].ver === MAIN, `A:4.6 走 ${MAIN}(got ${main[0].model}@${main[0].ver})`);
ok(main[1].model === M55 && main[1].ver === NEXT, `A:5.5 走 ${NEXT}(got ${main[1].model}@${main[1].ver})`);
ok(main[2].model === M46 && main[2].ver === MAIN, `A:切回 4.6 又回到 ${MAIN}(got ${main[2].model}@${main[2].ver})`);
ok(!main[1].tt, "A:5.5 的消息里没有 <total_tokens> 那行(新版额外变量生效)");
ok(!main[0].tt && !main[2].tt, "A:4.6 的消息里也没有(本来就没有)");
ok(JSON.stringify(main[0].thinking) === JSON.stringify(main[2].thinking), "A:4.6 前后两次的思考参数逐字相同");
ok(tr.length === 1, `A:只翻了 5.5 那一段(4.6 的思考不翻,got ${tr.length} 次翻译)`);
ok(tr[0] && tr[0].model === "claude-sonnet-4-6" && tr[0].ver === MAIN, `A:翻译走主力 CLI + sonnet-4-6(got ${tr[0]?.model}@${tr[0]?.ver})`);
ok(tr[0] && tr[0].tools === 0, `A:翻译子进程一个工具都没有(got ${tr[0]?.tools})`);
ok(tr[0] && /I should answer warmly/.test(tr[0].user), "A:送去翻的正是 5.5 那段思考");
const b1 = blocks("sse-a1.txt"), b2 = blocks("sse-a2.txt");
ok(b1.some(([k, t]) => k === "think" && /I should answer warmly \(claude-opus-4-6\)/.test(t)), "A:4.6 的思考原样英文(没被翻)");
ok(!b1.some(([, t]) => /【译】/.test(t)), "A:4.6 的流里没有译文");
const i2t = b2.findIndex(([k, t]) => k === "think" && /【译】/.test(t)), i2x = b2.findIndex(([k]) => k === "text");
ok(i2t >= 0, "A:5.5 的思考变成了译文");
ok(!b2.some(([k, t]) => k === "think" && /^I should answer/.test(t)), "A:5.5 的英文原文没有另外再发一遍");
ok(i2t >= 0 && i2x > i2t, "A:顺序没乱 —— 先想(译文)后说(正文)");
ok(b2.some(([k, t]) => k === "text" && t === "reply-claude-opus-5-5"), "A:5.5 的正文照常到达");
const h1 = js("health-A1.json"), h2 = js("health-A2.json");
ok(h1.cli === "main" && h2.cli === "next", `A:/health 的 cli 跟着切(got ${h1.cli} → ${h2.cli})`);
ok(h2.cliNext === "ready" && h2.modelsDropped.length === 0, "A:/health 报新版在、没拿掉任何模型");
const logA = rd("shim-A.log");
ok(/spawned claude-opus-4-6 .*cli main/.test(logA) && /spawned claude-opus-5-5 .*cli next/.test(logA), "A:日志里每次起进程都标了用哪一份");

// ── B ──
const mB = js("models-B.json").data.map((x) => x.id);
ok(!mB.includes(M55), "B:新版不在,5.5 不进菜单(她点不到一个会哑掉的选项)");
const cB = js("calls-B.json").filter((c) => !c.translator);
ok(cB.length === 1 && cB[0].model === M46 && cB[0].ver === MAIN, `B:报 5.5 的请求留在 4.6(got ${cB[0]?.model}@${cB[0]?.ver})`);
const hB = js("health-B.json");
ok(hB.cliNext === "missing", "B:/health 报新版不在");
ok(JSON.stringify(hB.modelsDropped) === JSON.stringify([M55]), `B:/health 报出被拿掉的 5.5(看门狗靠它,got ${JSON.stringify(hB.modelsDropped)})`);
ok(/新版 CLI 不在,这些模型已从菜单拿掉/.test(rd("shim-B.log")), "B:开机日志里留了一行警告");

// ── C ──
const cC = js("calls-C.json");
ok(!cC.some((c) => c.translator), "C:翻译开关清空 = 一次都不翻");
ok(cC.some((c) => !c.translator && c.model === M55 && c.ver === NEXT), "C:5.5 照常走新版");
ok(blocks("sse-c1.txt").some(([k, t]) => k === "think" && /I should answer warmly/.test(t)), "C:5.5 的思考原样英文显示(急救开关管用)");

if (bad) { console.error(`\n${bad}/${n} 项断言失败(工作目录 ${W})`); process.exit(1); }
console.log(`E2E DUALCLI ALL PASS (${n} checks)`);
EOF

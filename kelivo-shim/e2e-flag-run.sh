#!/bin/bash
# e2e-flag-run.sh — 「5.5 被安全审查拦了 → 原地换 4.6 接着聊」的整链路测试(2026-09-29):
# 真 server.js + 两份真 claude 二进制 + 假 Anthropic 后端(e2e-flag-api.mjs,5.5 见 FLAGME 就回 refusal)。零额度、不碰线上。
#
#   bash e2e-flag-run.sh
#
# 四个阶段:
#   A 默认开着 —— 被拦 → 同一进程换 4.6 → 她那句重发、4.6 回上;正文开头一行提示;
#     之后 Kelivo 还报 5.5 也留在 4.6、不开新窗口;改选别的模型才开新窗口、锁解开;
#   B 急救开关 FLAG_FALLBACK_MODEL="" —— 回到老样子:报错(措辞改成「安全审查拦了」),不换;
#   C 说到一半被拦 —— 半截话 + 空一行 + 提示 + 4.6 的回话;
#   D 系统回合(x-system-turn:1)被拦 —— 照样换,但不出提示(同报错的 speak 规则)。
# 全绿输出 "E2E FLAG ALL PASS"。
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

WORK="${TMPDIR:-/tmp}/kelivo-shim-e2e-flag-work"
rm -rf "$WORK" && mkdir -p "$WORK" && cd "$WORK"
# ⚠️ server.js 每 import 一个新模块,这行就得跟着加(踩坑 20:漏了的现象是满屏 connect refused)。
cp "$SHIM_DIR"/server.js "$SHIM_DIR"/ctxguard.mjs "$SHIM_DIR"/senses.mjs "$SHIM_DIR"/keepalive.mjs "$SHIM_DIR"/apierror.mjs "$SHIM_DIR"/sysprompt.mjs "$SHIM_DIR"/toolvis.mjs "$SHIM_DIR"/auth-env.mjs "$SHIM_DIR"/cli-bin.mjs "$SHIM_DIR"/think-translate.mjs "$SHIM_DIR"/flagfallback.mjs .
cp "$SHIM_DIR"/shim-settings.json "$SHIM_DIR"/precompact-note.txt "$SHIM_DIR"/base.md .
sed -i "s#/src/precompact-note.txt#$WORK/precompact-note.txt#" shim-settings.json
ln -s "$DEPS/node_modules" node_modules
echo '{ "mcpServers": {} }' > mcp-empty.json
printf '%s' "{\"hasCompletedOnboarding\":true,\"projects\":{\"$WORK\":{\"hasTrustDialogAccepted\":true,\"hasCompletedProjectOnboarding\":true}}}" > .claude.json

M46=claude-opus-4-6
M48=claude-opus-4-8
M55=claude-opus-5-5

start_shim() {  # $1=阶段名 $2=FLAG_FALLBACK_MODEL $3=E2E_FLAG_PARTIAL
  rm -f "$WORK/calls.json"
  E2E_DIR="$WORK" E2E_API_PORT=8711 E2E_FLAG_PARTIAL="$3" node "$SHIM_DIR/e2e-flag-api.mjs" 2>"fake-$1.log" &
  FPID=$!
  # ⚠️ `env -i` 必须留着(理由同 e2e-run.sh:外面的真令牌会让 e2e 改打真 API)。
  # 翻译关掉(THINK_TRANSLATE_MODELS=""):这里只测换模型,翻译层 e2e-dualcli 已经测过。
  # ⚠️⚠️ 注释只能写在这一行**之前**,写进续行会截断整条命令。
  env -i HOME="$WORK" PATH="$PATH" \
    PORT=8710 CLAUDE_BIN="$BIN" CLAUDE_BIN_NEXT="$NBIN" THINK_TRANSLATE_MODELS="" FLAG_FALLBACK_MODEL="$2" \
    ANTHROPIC_BASE_URL=http://127.0.0.1:8711 ANTHROPIC_AUTH_TOKEN=fake \
    BRAIN_MODEL="$M55" BRAIN_MODELS="$M46 $M48 $M55" SYS_PROMPT_MODE=replace \
    MCP_CONFIG=mcp-empty.json MCP_WARMUP_MS=300 KA_ON=0 TIME_HINT=0 CTX_GUARD_ON=0 \
    BUILTIN_TOOLS=Read ALLOWED_TOOLS=Read \
    DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    node "$WORK/server.js" >"shim-$1.log" 2>&1 &
  SPID=$!
  sleep 2
}
stop_shim() { kill $SPID $FPID 2>/dev/null; sleep 1; }
trap 'kill ${SPID:-0} ${FPID:-0} 2>/dev/null' EXIT

# $1=文本 $2=模型 $3=输出文件 [$4=额外请求头](流式 SSE,模拟 Kelivo/Telegram 桥)
say() {
  curl -sS -N --max-time 120 -X POST http://127.0.0.1:8710/v1/messages -H 'Content-Type: application/json' ${4:+-H "$4"} \
    -d "{\"model\":\"$2\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"$1\"}]}" > "$WORK/$3"
  sleep 1
}

# ---- 阶段 A:默认开着 ----
start_shim A "$M46" ""
say "turn-a1" "$M55" sse-a1.txt
say "turn-a2 FLAGME" "$M55" sse-a2.txt
curl -sS http://127.0.0.1:8710/health > health-A2.json
curl -sS http://127.0.0.1:8710/debug > debug-A2.json
say "turn-a3" "$M55" sse-a3.txt
curl -sS http://127.0.0.1:8710/health > health-A3.json
say "turn-a4" "$M48" sse-a4.txt
curl -sS http://127.0.0.1:8710/health > health-A4.json
cp calls.json calls-A.json
stop_shim

# ---- 阶段 B:急救开关 ----
start_shim B "" ""
say "turn-b1" "$M55" sse-b1.txt
say "turn-b2 FLAGME" "$M55" sse-b2.txt
curl -sS http://127.0.0.1:8710/health > health-B.json
cp calls.json calls-B.json
stop_shim

# ---- 阶段 C:说到一半被拦 ----
start_shim C "$M46" "1"
say "turn-c1 FLAGME" "$M55" sse-c1.txt
cp calls.json calls-C.json
stop_shim

# ---- 阶段 D:系统回合被拦 ----
start_shim D "$M46" ""
say "turn-d1 FLAGME" "$M55" sse-d1.txt "x-system-turn: 1"
curl -sS http://127.0.0.1:8710/health > health-D.json
cp calls.json calls-D.json
stop_shim

E2E_WORK="$WORK" node - <<'EOF'
const fs = require("fs");
const W = process.env.E2E_WORK;
const rd = (f) => fs.readFileSync(`${W}/${f}`, "utf8");
const js = (f) => JSON.parse(rd(f));
const M46 = "claude-opus-4-6", M48 = "claude-opus-4-8", M55 = "claude-opus-5-5";
let bad = 0, n = 0;
const ok = (c, name) => { n++; if (!c) { bad++; console.error("FAIL:", name); } else console.log("  ok:", name); };
const text = (f) => [...rd(f).matchAll(/^data: (.*)$/gm)].map((m) => { try { return JSON.parse(m[1]); } catch { return {}; } })
  .filter((d) => d.type === "content_block_delta" && d.delta.type === "text_delta").map((d) => d.delta.text).join("");
const NOTE = "⚠️ 5.5 拦了这句,已经自动换成 4.6 接着聊,窗口没丢。\n\n";

// ── A ──
const cA = js("calls-A.json");
ok(text("sse-a1.txt") === "reply-" + M55, "A:被拦之前 5.5 照常回");
const a2 = text("sse-a2.txt");
ok(a2 === NOTE + "reply-" + M46, `A:被拦那句 = 一行提示 + 4.6 的回话(got ${JSON.stringify(a2)})`);
ok(!/上游断了|安全审查/.test(a2), "A:她没看到报错");
ok(/"thinking":"想一想\(claude-opus-4-6\)"/.test(rd("sse-a2.txt")), "A:换过去之后思考流照常显示");
const refused = cA.filter((c) => c.refused), after = cA.filter((c) => c.model === M46);
ok(refused.length === 1 && refused[0].model === M55, `A:5.5 被拦了恰好一次(got ${refused.length})`);
const a2re = after.find((c) => /turn-a2/.test(c.user));
ok(!!a2re, "A:她那句到了 4.6 手里");
ok(a2re && a2re.flagCount === 1, `A:她那句只有一份(没被重发成两遍,got ${a2re?.flagCount})`);
ok(a2re && a2re.nudge && /FLAGME[\s\S]*【系统·补发】/.test(a2re.user), "A:补发提示跟在她那句后面(同一条消息),4.6 据此开口");
ok(a2re && a2re.turns.some((t) => /turn-a1/.test(t)), "A:4.6 看得到被拦之前的对话(窗口没丢)");
ok(a2re && a2re.thinkingBlocks >= 0, `A:(记录)5.5 的思考块随对话转给 4.6 的条数 = ${a2re?.thinkingBlocks}`);
const h2 = js("health-A2.json"), d2 = js("debug-A2.json");
ok(h2.model === M46 && h2.cli === "next", `A:/health 报换过去了(got ${h2.model} / ${h2.cli})`);
ok(h2.flagLock && h2.flagLock.from === M55 && h2.flagLock.to === M46, "A:/health 报这个窗口锁在 4.6");
ok(h2.flagFallback === M46, "A:/health 报功能开着、换到 4.6");
ok(d2.flag && d2.flag.count === 1, `A:/debug 记了换过一次(got ${d2.flag?.count})`);
ok(d2.lastApiError && d2.lastApiError.kind === "flagged" && /safeguards flagged/.test(d2.lastApiError.text), "A:/debug 的 lastApiError 留着被拦的原文(数被拦几次用)");
ok(text("sse-a3.txt") === "reply-" + M46, "A:之后 Kelivo 还报 5.5 → 留在 4.6");
const a3 = after.find((c) => /turn-a3/.test(c.user));
ok(a3 && a3.turns.some((t) => /turn-a1/.test(t)) && a3.turns.some((t) => /turn-a2/.test(t)), "A:再下一句仍是同一个窗口(前两轮都在)");
ok(a3 && a3.flagCount === 1, `A:再下一句里她被拦那句仍只有一份(got ${a3?.flagCount})`);
const logA = rd("shim-A.log");
ok((logA.match(/\[claude\] spawned/g) || []).length === 2, `A:整个阶段只起过两次进程(开头 5.5 + 她改选 4.8)`);
ok(/\[flag\] 已换到 claude-opus-4-6/.test(logA), "A:日志留了 [flag] 已换到");
ok(cA.some((c) => c.validate && c.model === M46), "A:换模型前 CLI 先验了一下 4.6(非流式的 Hi)");
ok(js("health-A3.json").flagLock !== null, "A:锁一直在(直到换窗口)");
ok(text("sse-a4.txt") === "reply-" + M48, "A:她改选 4.8 = 真想换,照常换");
const h4 = js("health-A4.json");
ok(h4.model === M48 && h4.flagLock === null, `A:换到 4.8 = 新窗口,锁解开(got ${h4.model} / ${JSON.stringify(h4.flagLock)})`);

// ── B ──
const b2 = text("sse-b2.txt");
ok(/Opus 5\.5 的安全审查拦了这句/.test(b2) && /切到 4\.x/.test(b2), `B:开关关着 = 老样子报错,措辞换成安全审查(got ${JSON.stringify(b2)})`);
ok(!b2.includes("链路修好"), "B:不再说「链路修好就能接着聊」");
const hB = js("health-B.json");
ok(hB.model === M55 && hB.flagLock === null && hB.flagFallback === null, "B:没换、没锁、/health 报功能关");
ok(!js("calls-B.json").some((c) => c.model === M46), "B:一次都没打 4.6");

// ── C ──
const c1 = text("sse-c1.txt");
ok(c1 === "half-\n\n" + NOTE + "reply-" + M46, `C:半截话 + 空一行 + 提示 + 4.6 的回话(got ${JSON.stringify(c1)})`);

// ── D ──
const d1 = text("sse-d1.txt");
ok(d1 === "reply-" + M46, `D:系统回合被拦也换,但不出提示(got ${JSON.stringify(d1)})`);
ok(js("health-D.json").flagLock !== null, "D:系统回合换过去也锁上");

if (bad) { console.error(`\n${bad}/${n} 项断言失败(工作目录 ${W})`); process.exit(1); }
console.log(`E2E FLAG ALL PASS (${n} checks)`);
EOF

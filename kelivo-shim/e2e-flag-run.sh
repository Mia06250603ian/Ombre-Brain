#!/bin/bash
# e2e-flag-run.sh — 「5.5 被安全审查拦了」的整链路测试(2026-09-29):先撤回,再被拦才原地换 4.6。
# 真 server.js + 两份真 claude 二进制 + 假 Anthropic 后端(e2e-flag-api.mjs,5.5 见 FLAGME 就回 refusal)。零额度、不碰线上。
#
#   bash e2e-flag-run.sh
#
# 五个阶段:
#   A 默认(撤回 + 换 4.6 都开)—— 被拦 → 撤回(被拦那轮从会话里没了,还是 5.5)→ 换个说法成功 →
#     再被拦 → 再撤回 → 紧接着又被拦 → 换 4.6、她那句只有一份、之后锁在 4.6;改选 4.8 才开新窗口;
#   B 两个急救开关都关 —— 回到老样子:报错(措辞改成「安全审查拦了」);
#   C 只关撤回(FLAG_ROLLBACK=0)—— 被拦直接换 4.6;说到一半被拦:半截话 + 空一行 + 提示 + 回话;
#   D 窗口第一句就被拦(没有可退回的点)+ 系统回合 —— 直接换 4.6、不出提示;
#   F 菜单里的 `claude-opus-4-6-next`(新版上的 4.6)—— 5.5 窗口里点它 = 原地换、窗口不丢;点回 5.5 也原地;
#     点普通的 4.6(旧版)才开新窗口。
#   E 撤回重起失败(会话记录被删,撤回点找不到)—— 先退一步不截断地接回;被拦那句跟着回来,她下一句再被拦 → 换 4.6。不卡死、不丢窗口。
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
A46=claude-opus-4-6-next
M48=claude-opus-4-8
M55=claude-opus-5-5

start_shim() {  # $1=阶段名 $2=FLAG_FALLBACK_MODEL $3=E2E_FLAG_PARTIAL $4=FLAG_ROLLBACK
  rm -f "$WORK/calls.json"
  E2E_DIR="$WORK" E2E_API_PORT=8711 E2E_FLAG_PARTIAL="$3" node "$SHIM_DIR/e2e-flag-api.mjs" 2>"fake-$1.log" &
  FPID=$!
  # ⚠️ `env -i` 必须留着(理由同 e2e-run.sh:外面的真令牌会让 e2e 改打真 API)。
  # 翻译关掉(THINK_TRANSLATE_MODELS=""):这里只测换模型,翻译层 e2e-dualcli 已经测过。
  # ⚠️⚠️ 注释只能写在这一行**之前**,写进续行会截断整条命令。
  env -i HOME="$WORK" PATH="$PATH" \
    PORT=8710 CLAUDE_BIN="$BIN" CLAUDE_BIN_NEXT="$NBIN" THINK_TRANSLATE_MODELS="" FLAG_FALLBACK_MODEL="$2" FLAG_ROLLBACK="$4" \
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

# ---- 阶段 A:默认(撤回 + 换 4.6)----
start_shim A "$M46" "" 1
say "turn-a1" "$M55" sse-a1.txt
say "turn-a2 FLAGME" "$M55" sse-a2.txt
curl -sS http://127.0.0.1:8710/health > health-A2.json
curl -sS http://127.0.0.1:8710/debug > debug-A2.json
say "turn-a3" "$M55" sse-a3.txt
curl -sS http://127.0.0.1:8710/debug > debug-A3.json
say "turn-a4 FLAGME" "$M55" sse-a4.txt
say "turn-a5 FLAGME" "$M55" sse-a5.txt
curl -sS http://127.0.0.1:8710/health > health-A5.json
curl -sS http://127.0.0.1:8710/debug > debug-A5.json
say "turn-a6" "$M55" sse-a6.txt
say "turn-a7" "$M48" sse-a7.txt
curl -sS http://127.0.0.1:8710/health > health-A7.json
cp calls.json calls-A.json
stop_shim

# ---- 阶段 B:两个急救开关都关 ----
start_shim B "" "" 0
say "turn-b1" "$M55" sse-b1.txt
say "turn-b2 FLAGME" "$M55" sse-b2.txt
curl -sS http://127.0.0.1:8710/health > health-B.json
cp calls.json calls-B.json
stop_shim

# ---- 阶段 C:只关撤回;说到一半被拦 ----
start_shim C "$M46" "1" 0
say "turn-c1" "$M55" sse-c0.txt
say "turn-c2 FLAGME" "$M55" sse-c1.txt
cp calls.json calls-C.json
stop_shim

# ---- 阶段 D:第一句就被拦 + 系统回合 ----
start_shim D "$M46" "" 1
say "turn-d1 FLAGME" "$M55" sse-d1.txt "x-system-turn: 1"
curl -sS http://127.0.0.1:8710/health > health-D.json
cp calls.json calls-D.json
stop_shim

# ---- 阶段 F:菜单里手动选 4.6-next ----
start_shim F "$M46" "" 1
curl -sS http://127.0.0.1:8710/v1/models > models-F.json
say "turn-f1" "$M55" sse-f1.txt
say "turn-f2" "$A46" sse-f2.txt
curl -sS http://127.0.0.1:8710/health > health-F2.json
say "turn-f3" "$M55" sse-f3.txt
say "turn-f4" "$M46" sse-f4.txt
curl -sS http://127.0.0.1:8710/health > health-F4.json
cp calls.json calls-F.json
stop_shim

# ---- 阶段 E:撤回重起失败 ----
start_shim E "$M46" "" 1
say "turn-e1" "$M55" sse-e1.txt
rm -f "$WORK"/.claude/projects/*/*.jsonl
say "turn-e2 FLAGME" "$M55" sse-e2.txt
sleep 5
say "turn-e3" "$M55" sse-e3.txt
cp calls.json calls-E.json
stop_shim

E2E_WORK="$WORK" node - <<'EOF'
const fs = require("fs");
const W = process.env.E2E_WORK;
const rd = (f) => fs.readFileSync(`${W}/${f}`, "utf8");
const js = (f) => JSON.parse(rd(f));
const M46 = "claude-opus-4-6", M48 = "claude-opus-4-8", M55 = "claude-opus-5-5", A46 = "claude-opus-4-6-next";
let bad = 0, n = 0;
const ok = (c, name) => { n++; if (!c) { bad++; console.error("FAIL:", name); } else console.log("  ok:", name); };
const text = (f) => [...rd(f).matchAll(/^data: (.*)$/gm)].map((m) => { try { return JSON.parse(m[1]); } catch { return {}; } })
  .filter((d) => d.type === "content_block_delta" && d.delta.type === "text_delta").map((d) => d.delta.text).join("");
const NOTE = "⚠️ 5.5 拦了这句,已经自动换成 4.6-next 接着聊,窗口没丢。\n\n";

const RB = "⚠️ 5.5 拦了这句,已经撤回了(他没看到)。换个说法再说一次吧;要是还被拦,会自动换成 4.6-next 接着聊。";
const callsFor = (cs, tag) => cs.filter((c) => !c.validate && c.user.includes(tag));

// ── A ──
const cA = js("calls-A.json");
ok(text("sse-a1.txt") === "reply-" + M55, "A:被拦之前 5.5 照常回");
ok(text("sse-a2.txt") === RB, `A:第一次被拦 → 撤回提示(got ${JSON.stringify(text("sse-a2.txt"))})`);
const h2 = js("health-A2.json"), d2 = js("debug-A2.json");
ok(h2.model === M55 && h2.flagLock === null, "A:撤回之后还是 5.5、没上锁");
ok(d2.flag.rollbacks === 1 && d2.flag.justRolledBack === true && d2.flag.count === 0, `A:/debug 记了撤回一次、还没换模型(got ${JSON.stringify(d2.flag)})`);
ok(d2.lastApiError && d2.lastApiError.kind === "flagged", "A:/debug 的 lastApiError 留着被拦的原文");
ok(text("sse-a3.txt") === "reply-" + M55, "A:换个说法 → 5.5 照常回");
const a3 = callsFor(cA, "turn-a3")[0];
ok(a3 && a3.model === M55, "A:撤回后还是 5.5 在回");
ok(a3 && a3.turns.some((t) => /turn-a1/.test(t)) && !a3.turns.some((t) => /turn-a2/.test(t)), `A:被拦那轮从会话里没了、之前的都在(got ${JSON.stringify(a3?.turns)})`);
ok(a3 && a3.flagCount === 0, "A:5.5 再也看不到被拦那句");
ok(js("debug-A3.json").flag.justRolledBack === false, "A:成功一轮之后「刚撤回过」清掉");
ok(text("sse-a4.txt") === RB, "A:之后又被拦(中间成功过)→ 还是先撤回");
const a5 = text("sse-a5.txt");
ok(a5 === NOTE + "reply-" + M46, `A:撤回后紧接着又被拦 → 换 4.6(got ${JSON.stringify(a5)})`);
ok(!/上游断了|安全审查/.test(text("sse-a2.txt") + a5), "A:她一次都没看到报错");
ok(/"thinking":"想一想\(claude-opus-4-6\)"/.test(rd("sse-a5.txt")), "A:换过去之后思考流照常显示");
const a5re = cA.find((c) => c.model === M46 && !c.validate && c.user.includes("turn-a5"));
ok(!!a5re, "A:她那句到了 4.6 手里");
ok(a5re && a5re.flagCount === 1, `A:她那句只有一份(a4 已撤回、a5 没被重发,got ${a5re?.flagCount})`);
ok(a5re && a5re.nudge && /FLAGME[\s\S]*【系统·补发】/.test(a5re.user), "A:补发提示跟在她那句后面,4.6 据此开口");
ok(a5re && a5re.turns.some((t) => /turn-a1/.test(t)) && a5re.turns.some((t) => /turn-a3/.test(t)), "A:4.6 看得到之前成功的几轮(窗口没丢)");
ok(cA.some((c) => c.validate && c.model === M46), "A:换模型前 CLI 先验了一下 4.6(非流式的 Hi)");
const h5 = js("health-A5.json"), d5 = js("debug-A5.json");
ok(h5.model === A46 && h5.cli === "next" && h5.flagLock && h5.flagLock.from === M55 && h5.flagLock.to === A46, `A:/health 报换过去了、锁在菜单里那项 4.6-next(got ${h5.model})`);
ok(h5.flagFallback === A46, "A:/health 报被拦后换到 4.6-next");
ok(d5.flag.count === 1 && d5.flag.rollbacks === 2, `A:/debug 撤回两次、换一次(got ${JSON.stringify(d5.flag)})`);
ok(text("sse-a6.txt") === "reply-" + M46, "A:之后 Kelivo 还报 5.5 → 留在 4.6");
ok(text("sse-a7.txt") === "reply-" + M48 && js("health-A7.json").flagLock === null, "A:她改选 4.8 = 新窗口、锁解开");
const logA = rd("shim-A.log");
ok((logA.match(/\[claude\] spawned/g) || []).length === 4, `A:起过四次进程(开头 5.5 + 两次撤回重起 + 改选 4.8,got ${(logA.match(/\[claude\] spawned/g) || []).length})`);
ok((logA.match(/resume truncate/g) || []).length === 2, "A:两次撤回都是「截断续上」");
ok(/\[flag\] 被拦了,撤回这一轮/.test(logA) && /\[flag\] 已换到 claude-opus-4-6/.test(logA), "A:日志留了 [flag] 撤回 / 已换到");

// ── B ──
const b2 = text("sse-b2.txt");
ok(/Opus 5\.5 的安全审查拦了这句/.test(b2) && /切到 4\.x/.test(b2), `B:两个开关都关 = 老样子报错,措辞换成安全审查(got ${JSON.stringify(b2)})`);
ok(!b2.includes("链路修好"), "B:不再说「链路修好就能接着聊」");
const hB = js("health-B.json");
ok(hB.model === M55 && hB.flagLock === null && hB.flagFallback === null && hB.flagRollback === false, "B:没换、没锁、/health 报两个都关");
ok(!js("calls-B.json").some((c) => c.model === M46), "B:一次都没打 4.6");
ok(!/resume/.test(rd("shim-B.log")), "B:没撤回");

// ── C ──
const c1 = text("sse-c1.txt");
ok(c1 === "half-\n\n" + NOTE + "reply-" + M46, `C:只关撤回 → 直接换 4.6;半截话 + 空一行 + 提示 + 回话(got ${JSON.stringify(c1)})`);
ok(!/resume/.test(rd("shim-C.log")), "C:没撤回");

// ── D ──
ok(text("sse-d1.txt") === "reply-" + M46, `D:第一句就被拦(无处可退)→ 直接换 4.6;系统回合不出提示(got ${JSON.stringify(text("sse-d1.txt"))})`);
ok(js("health-D.json").flagLock !== null, "D:换过去也锁上");

// ── F ──
const mF = js("models-F.json").data.map((x) => x.id);
ok(mF.includes(A46) && mF.includes(M46), `F:菜单里 4.6 和 4.6-next 分成两项(got ${JSON.stringify(mF)})`);
const cF = js("calls-F.json"), logF = rd("shim-F.log");
ok(text("sse-f2.txt") === "reply-" + M46, "F:5.5 窗口里点 4.6-next → 4.6 回(上游收到的是真名 claude-opus-4-6)");
const f2 = callsFor(cF, "turn-f2")[0];
ok(f2 && f2.model === M46 && f2.turns.some((t) => /turn-f1/.test(t)), "F:原地换过去,前面那轮还在(窗口没丢)");
ok(/\[model\] 原地换模型\(新版 CLI,窗口不丢\): claude-opus-5-5 -> claude-opus-4-6-next/.test(logF), "F:日志留了原地换模型");
const hF2 = js("health-F2.json");
ok(hF2.model === A46 && hF2.cli === "next" && hF2.flagLock === null, "F:/health 报 4.6-next、新版、没上锁(手动换的不锁)");
ok(text("sse-f3.txt") === "reply-" + M55, "F:再点回 5.5 → 原地换回");
const f3 = callsFor(cF, "turn-f3")[0];
ok(f3 && f3.model === M55 && f3.turns.some((t) => /turn-f1/.test(t)) && f3.turns.some((t) => /turn-f2/.test(t)), "F:换回 5.5 仍是同一个窗口");
ok(text("sse-f4.txt") === "reply-" + M46, "F:点普通的 4.6 → 旧版回");
const f4 = callsFor(cF, "turn-f4")[0];
ok(f4 && !f4.turns.some((t) => /turn-f1/.test(t)), "F:普通的 4.6 = 旧版 = 开了新窗口(和以前一样)");
ok(js("health-F4.json").cli === "main", "F:/health 报旧版(main)");
ok((logF.match(/\[claude\] spawned/g) || []).length === 2, `F:只起过两次进程(开头 + 点普通 4.6),got ${(logF.match(/\[claude\] spawned/g) || []).length}`);

// ── E ──
const logE = rd("shim-E.log");
ok(text("sse-e2.txt") === RB, "E:撤回提示照常发出");
ok(/撤回重起没成,改成不截断地接回原会话/.test(logE), "E:截断续上失败 → 先退一步不截断地接回");
ok(/resume full/.test(logE) && !/只能开新窗口/.test(logE), "E:不截断地接回成功了(窗口没丢)");
// 接回来的会话里带着被拦那句 → 她下一句又被拦 → 刚撤回过,所以换 4.6 —— 正是设计的退路
ok(text("sse-e3.txt") === NOTE + "reply-" + M46, `E:她下一句照样有人回、不卡死(被拦那句跟着回来 → 换 4.6,got ${JSON.stringify(text("sse-e3.txt"))})`);

if (bad) { console.error(`\n${bad}/${n} 项断言失败(工作目录 ${W})`); process.exit(1); }
console.log(`E2E FLAG ALL PASS (${n} checks)`);
EOF

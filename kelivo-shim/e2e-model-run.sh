#!/bin/bash
# e2e-model-run.sh — 「Kelivo 菜单里自己切模型」(方案 B)的整链路测试:
# 真 server.js + 真 claude 二进制 + 假 Anthropic 后端。零额度、不碰线上。
#
#   bash e2e-model-run.sh
#
# 两个阶段:
#   A 名单开着(BRAIN_MODELS=4.6,4.5)—— 验切换真的发生、且**只在报了名单里的模型时**发生;
#   B 名单不设 ——            验 7.1 的「默认休眠」:报任何模型都不该重开进程。
# 全绿输出 "E2E MODEL ALL PASS"。
set -u
SHIM_DIR="$(cd "$(dirname "$0")" && pwd)"
VER="$(node -p "require('$SHIM_DIR/package.json').dependencies['@anthropic-ai/claude-code'].replace(/^[^0-9]*/,'')")"
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

WORK="${TMPDIR:-/tmp}/kelivo-shim-e2e-model-work"
rm -rf "$WORK" && mkdir -p "$WORK" && cd "$WORK"
# ⚠️ server.js 每 import 一个新模块,这行就得跟着加(踩坑 20:漏了的现象是满屏 connect refused)。
cp "$SHIM_DIR"/server.js "$SHIM_DIR"/ctxguard.mjs "$SHIM_DIR"/senses.mjs "$SHIM_DIR"/keepalive.mjs "$SHIM_DIR"/apierror.mjs "$SHIM_DIR"/sysprompt.mjs .
cp "$SHIM_DIR"/shim-settings.json "$SHIM_DIR"/precompact-note.txt "$SHIM_DIR"/base.md .
sed -i "s#/src/precompact-note.txt#$WORK/precompact-note.txt#" shim-settings.json
ln -s "$DEPS/node_modules" node_modules
echo '{ "mcpServers": {} }' > mcp-empty.json
printf '%s' "{\"hasCompletedOnboarding\":true,\"projects\":{\"$WORK\":{\"hasTrustDialogAccepted\":true,\"hasCompletedProjectOnboarding\":true}}}" > .claude.json

M46=claude-opus-4-6
M45=claude-opus-4-5-20251101

start_shim() {  # $1=阶段名 $2=BRAIN_MODELS 值(空=休眠)
  : > "$WORK/models.json"
  E2E_DIR="$WORK" E2E_API_PORT=8601 node "$SHIM_DIR/e2e-model-api.mjs" 2>"fake-$1.log" &
  FPID=$!
  env -i HOME="$WORK" PATH="$PATH" \
    PORT=8600 CLAUDE_BIN="$BIN" \
    ANTHROPIC_BASE_URL=http://127.0.0.1:8601 ANTHROPIC_AUTH_TOKEN=fake \
    BRAIN_MODEL="$M46" BRAIN_MODELS="$2" \
    MCP_CONFIG=mcp-empty.json MCP_WARMUP_MS=300 KA_ON=1 KA_CHECK_MIN=999 TIME_HINT=0 \
    CTX_GUARD_ON=1 CTX_SOFT_TOKENS=30000 CTX_HARD_TOKENS=90000 CTX_ARCHIVE_EVERY_TOKENS=0 \
    BUILTIN_TOOLS=Read ALLOWED_TOOLS=Read \
    DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    node "$WORK/server.js" >"shim-$1.log" 2>&1 &
  SPID=$!
  sleep 2
}
stop_shim() { kill $SPID $FPID 2>/dev/null; sleep 1; }
trap 'kill ${SPID:-0} ${FPID:-0} 2>/dev/null' EXIT

# $1=文本 $2=模型(空=整个字段都不发,模拟改造后的两个桥)
msg() {
  if [ -z "$2" ]; then
    curl -sS -X POST http://127.0.0.1:8600/v1/messages -H 'Content-Type: application/json' \
      -d "{\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"$1\"}]}" >/dev/null
  else
    curl -sS -X POST http://127.0.0.1:8600/v1/messages -H 'Content-Type: application/json' \
      -d "{\"model\":\"$2\",\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"$1\"}]}" >/dev/null
  fi
  sleep 1.5
}

# ---- 阶段 A:名单开着 ----
start_shim A "$M46,$M45"
curl -sS http://127.0.0.1:8600/v1/models > "$WORK/models-list-A.json"
msg "a1 默认" "$M46"                 # 起步:4.6
msg "a2 不报模型" ""                  # 两个桥改造后的形态 → 不该重开
msg "a3 切到45" "$M45"                # 真切 → 该重开
msg "a4 不报模型" ""                  # 乒乓球那道锁:不该被拽回 4.6
msg "a5 名单外" "claude-opus-4-9-nope" # 白名单外 → 沿用当前,不该重开
# ⚠️ 最要紧的一条:**Kelivo 每条消息都会带上她选中的模型名**,所以「反复报同一个模型」
# 才是日常最常见的形态。它要是也重开进程,她在 Kelivo 每说一句话就丢一个窗口。
msg "a6 再报45" "$M45"
msg "a7 又报45" "$M45"
# ⚠️ 同样致命的一条:保温/心跳回合每 ~55 分钟来一次,它要是也重开进程,晏每小时丢一个窗口。
curl -sS -X POST http://127.0.0.1:8600/hb >/dev/null; sleep 2
curl -sS http://127.0.0.1:8600/debug > "$WORK/debug-A.json"
curl -sS http://127.0.0.1:8600/health > "$WORK/health-A.json"
cp "$WORK/models.json" "$WORK/models-A.json"
stop_shim

# ---- 阶段 B:名单不设(默认休眠) ----
start_shim B ""
curl -sS http://127.0.0.1:8600/v1/models > "$WORK/models-list-B.json"
msg "b1 默认" "$M46"
msg "b1b 再报同一个" "$M46"   # 休眠状态下的日常形态,同样不许重开
msg "b2 报45" "$M45"                  # 名单里没有它 → 该被无视,不重开
msg "b3 不报" ""
curl -sS http://127.0.0.1:8600/health > "$WORK/health-B.json"
cp "$WORK/models.json" "$WORK/models-B.json"
stop_shim

# ---- 断言 ----
E2E_WORK="$WORK" node - <<'EOF'
const fs = require("fs");
const W = process.env.E2E_WORK;
const rd = (f) => JSON.parse(fs.readFileSync(`${W}/${f}`, "utf8"));
const M46 = "claude-opus-4-6", M45 = "claude-opus-4-5-20251101";
let bad = 0, n = 0;
const ok = (c, name) => { n++; if (!c) { bad++; console.error("FAIL:", name); } };
const spawns = (log) => [...fs.readFileSync(`${W}/${log}`, "utf8").matchAll(/\[claude\] spawned (\S+)/g)].map((m) => m[1]);

// ── 阶段 A:名单开着 ──
const listA = rd("models-list-A.json");
ok(listA.data.length === 2, `A:/v1/models 吐两项(Kelivo 菜单就是从这来的,got ${listA.data.length})`);
ok(listA.data[0].id === M46 && listA.data[1].id === M45, "A:/v1/models 的 id 就是名单本身");

const spA = spawns("shim-A.log");
ok(spA.length === 2, `A:整个阶段只重开一次进程(got ${spA.length} 次 spawn)——不报模型、报名单外、**反复报同一个模型**都不该触发`);
ok(spA[0] === M46, `A:第一个进程用 4.6(got ${spA[0]})`);
ok(spA[1] === M45, `A:切换后的新进程用 4.5(got ${spA[1]})`);

// CLI 真发上去的模型 —— 这是「真的切到了」的硬证据
const mA = rd("models-A.json");
ok(mA.length === 8, `A:七条消息 + 一次心跳 = 八次上游调用(got ${mA.length})`);
ok(mA[0] === M46 && mA[1] === M46, "A:前两条走 4.6(第二条没报模型 → 沿用当前)");
ok(mA[2] === M45, `A:切过去之后 CLI 真的发的是 4.5(got ${mA[2]})`);
ok(mA[3] === M45, "A:**没报模型的下一条仍是 4.5** —— 两个桥拽不回去(乒乓球那道锁)");
ok(mA[4] === M45, "A:报了名单外的模型被无视,沿用 4.5(白名单)");
ok(mA[5] === M45 && mA[6] === M45, "A:**反复报同一个模型仍走 4.5**(Kelivo 每条都会报,这是日常形态)");
ok(mA[7] === M45, "A:**心跳回合沿用当前模型**,不把她切过去的模型顶回 4.6");

// 7.2 ⑤:切模型 = 新进程 = 窗口归零。守卫的记账必须跟着复位,且**不许**把这次
// 「读数从 6 万暴跌到 1 千」误判成一次静默压缩(误判会让 compactions 虚增、软线提前重臂)。
const dA = rd("debug-A.json");
ok(dA.ctxGuard.compactions === 0, `A:换模型的读数暴跌不该被记成压缩(compactions got ${dA.ctxGuard.compactions})`);
ok(dA.ctxGuard.softFired === false, "A:切过去之后守卫记账已复位(4.6 那边烧到过软线,新窗口不该继承)");
ok(dA.ctxGuard.lastArchiveTokens === 0, "A:归档基线也跟着新窗口清零");
ok(dA.ctxGuard.trusted === true, "A:守卫读数仍可信");
ok(dA.contextTokens < 30000, `A:/debug 报的是新窗口的低位占用(got ${dA.contextTokens})`);

const hA = rd("health-A.json");
ok(hA.model === M45, `A:/health 报的是切换后的模型(got ${hA.model})——漏改会让下一个人误判成没切成功`);
ok(Array.isArray(hA.models) && hA.models.length === 2, "A:/health 也把名单摆出来,排查时一眼看见");

// ── 阶段 B:默认休眠(7.1,这是能过「4.6 绝对安全」的关键)──
const listB = rd("models-list-B.json");
ok(listB.data.length === 1 && listB.data[0].id === M46, "B:不设 BRAIN_MODELS 时菜单只有当前模型一个");
const spB = spawns("shim-B.log");
ok(spB.length === 1, `B:**报任何模型都不重开进程**(got ${spB.length} 次 spawn)——休眠时行为与改动前逐字相同`);
const mB = rd("models-B.json");
ok(mB.length === 4 && mB.every((m) => m === M46), `B:四条全走 4.6(got ${mB.join(",")})`);

if (bad) { console.error(`\n${bad}/${n} 项断言失败(shim-*.log / fake-*.log 在 ${W})`); process.exit(1); }
console.log(`E2E MODEL ALL PASS (${n} checks)`);
EOF
RC=$?
exit $RC

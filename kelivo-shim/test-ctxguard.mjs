// test-ctxguard.mjs — 上下文守卫决策单测,部署前跑一遍:node test-ctxguard.mjs
// 全绿输出 "ALL PASS";不碰网络、不碰 claude 进程。
import { ctxTokensOf, ctxDecide, ctxSoftNote, ctxHardNote, ctxPct } from "./ctxguard.mjs";

let n = 0, bad = 0;
function ok(cond, name) {
  n++;
  if (!cond) { bad++; console.error("FAIL:", name); }
}
function eq(got, want, name) {
  ok(got === want, `${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

const SOFT = 140000, HARD = 170000;
function dec(contextTokens, softFired = false) {
  return ctxDecide({ contextTokens, softTokens: SOFT, hardTokens: HARD, softFired }).level;
}

// ============ ctxTokensOf:三项求和,缺字段/脏值按 0 ============
eq(ctxTokensOf({ input_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 }), 5300, "三项求和");
eq(ctxTokensOf({ input_tokens: 100 }), 100, "只有 input");
eq(ctxTokensOf({ cache_read_input_tokens: 8000 }), 8000, "只有 cache_read");
eq(ctxTokensOf({ output_tokens: 999 }), 0, "output 不计入窗口占用");
eq(ctxTokensOf({ input_tokens: "abc", cache_read_input_tokens: null }), 0, "脏值/ null 按 0");
eq(ctxTokensOf(null), 0, "null usage → 0");
eq(ctxTokensOf(undefined), 0, "undefined usage → 0");
eq(ctxTokensOf("nope"), 0, "非对象 → 0");

// ============ ctxDecide:分段与优先级 ============
eq(dec(0), "none", "0 → none");
eq(dec(-5), "none", "负数 → none");
eq(dec(139999), "none", "软线下一格 → none");
eq(dec(140000), "soft", "正好到软线 → soft");
eq(dec(150000), "soft", "软硬之间 → soft");
eq(dec(169999), "soft", "硬线下一格仍 soft");
eq(dec(170000), "hard", "正好到硬线 → hard");
eq(dec(190000), "hard", "远超硬线 → hard");

// 软线只触发一次:softFired 后软区间归于 none,但硬线不受 softFired 影响
eq(dec(150000, true), "none", "软已触发 → 软区间不再触发");
eq(dec(140000, true), "none", "软已触发 → 正好软线也不再");
eq(dec(170000, true), "hard", "软已触发不挡硬线");
eq(dec(200000, true), "hard", "软已触发,超硬线仍 hard");

// 阈值为 0/无效 = 关掉对应段
eq(ctxDecide({ contextTokens: 999999, softTokens: 0, hardTokens: 0, softFired: false }).level, "none", "阈值全 0 = 守卫关");
eq(ctxDecide({ contextTokens: 150000, softTokens: 0, hardTokens: HARD, softFired: false }).level, "none", "软阈值 0 = 只留硬线(未到硬线)");
eq(ctxDecide({ contextTokens: 175000, softTokens: 0, hardTokens: HARD, softFired: false }).level, "hard", "软阈值 0 仍能触发硬线");

// ============ 文案 ============
ok(ctxSoftNote("佳佳").startsWith("【系统·上下文】"), "软文案带系统标注");
ok(ctxSoftNote("佳佳").includes("先别自己动手存"), "软文案:先别自己存");
ok(ctxSoftNote("佳佳").includes("佳佳"), "软文案代入称呼");
ok(ctxSoftNote().includes("她"), "软文案缺省称呼=她");
ok(!ctxSoftNote("佳佳").includes("archive_session"), "软文案不含归档指令");
ok(ctxHardNote().startsWith("【系统·上下文】"), "硬文案带系统标注");
ok(ctxHardNote().includes("archive_session"), "硬文案含归档工具名");
ok(ctxHardNote().includes("新窗口"), "硬文案说明换窗口");

// ============ ctxPct ============
eq(ctxPct(140000, 200000), 70, "140k/200k = 70%");
eq(ctxPct(170000, 200000), 85, "170k/200k = 85%");
eq(ctxPct(0, 200000), 0, "0 → 0%");
eq(ctxPct(100000), 50, "缺省 limit=20万 → 50%");
eq(ctxPct(100000, 0), 50, "limit 0 回落 20万");

if (bad) { console.error(`\n${bad}/${n} FAILED`); process.exit(1); }
else console.log(`ALL PASS (${n} checks)`);

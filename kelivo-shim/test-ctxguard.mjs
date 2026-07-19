// test-ctxguard.mjs — 上下文守卫决策单测,部署前跑一遍:node test-ctxguard.mjs
// 全绿输出 "ALL PASS";不碰网络、不碰 claude 进程。
import { ctxTokensOf, ctxWindowTokensOf, ctxReading, ctxDecide, ctxSoftNote, ctxHardNote, ctxPct, ctxSoftShouldReset } from "./ctxguard.mjs";

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

// ============ ctxWindowTokensOf:取 iterations 末条,不取整轮总和 ============
// 2026-07-19 实测回归:一轮多次工具调用,顶层总和 138934(重复计前缀),
// iterations 末条才是真实窗口 ~36.6K。总和当占用会假撞软线(见维护手册)。
const realWorld = {
  input_tokens: 6, cache_creation_input_tokens: 5158, cache_read_input_tokens: 133770,
  iterations: [{ input_tokens: 1, cache_read_input_tokens: 35833, cache_creation_input_tokens: 757 }],
};
eq(ctxWindowTokensOf(realWorld), 36591, "实测回归:取末条 36591,不取总和 138934");
ok(ctxDecide({ contextTokens: ctxWindowTokensOf(realWorld), softTokens: SOFT, hardTokens: HARD, softFired: false }).level === "none",
   "实测回归:真实占用不触发软线");
eq(ctxWindowTokensOf({
  input_tokens: 10, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0,
  iterations: [
    { input_tokens: 2, cache_read_input_tokens: 30000, cache_creation_input_tokens: 500 },
    { input_tokens: 3, cache_read_input_tokens: 30500, cache_creation_input_tokens: 400 },
  ],
}), 30903, "多条 iterations 取最后一条");
eq(ctxWindowTokensOf({
  input_tokens: 5, cache_read_input_tokens: 40000,
  iterations: [{ input_tokens: 2, cache_read_input_tokens: 30000 }, { output_tokens: 99 }],
}), 30002, "末条无输入侧字段(算 0)→ 往前找最近有效一条");
eq(ctxWindowTokensOf({ input_tokens: 5, cache_read_input_tokens: 40000, iterations: [] }), 40005, "iterations 空数组 → 回落顶层总和");
eq(ctxWindowTokensOf({ input_tokens: 5, cache_read_input_tokens: 40000 }), 40005, "无 iterations(老版 CLI)→ 回落顶层总和");
eq(ctxWindowTokensOf({ input_tokens: 5, cache_read_input_tokens: 40000, iterations: "nope" }), 40005, "iterations 非数组 → 回落顶层总和");
eq(ctxWindowTokensOf(null), 0, "null usage → 0");
eq(ctxWindowTokensOf(undefined), 0, "undefined usage → 0");

// ============ ctxReading:流事件首选 → iterations 次选 → 总和只作估计(trusted:false) ============
// 2026-07-19(晚)线上实测回归:iterations 是上游可选字段,第六次部署后线上一直为空,
// 守卫静默退回虚高总和、37% 就 softFired。可信读数必须首选 shim 自己抓的流事件 usage。
const streamU = { input_tokens: 3, cache_read_input_tokens: 72935, cache_creation_input_tokens: 1364, output_tokens: 323 };
const inflatedResult = { input_tokens: 12, cache_read_input_tokens: 145000, cache_creation_input_tokens: 3000, iterations: [] };
{
  const r = ctxReading({ streamUsage: streamU, resultUsage: inflatedResult });
  eq(r.tokens, 74302, "流事件 usage 优先(实测 74302,不取虚高总和 148012)");
  eq(r.trusted, true, "流事件读数 trusted");
}
{
  const r = ctxReading({ streamUsage: null, resultUsage: realWorld });
  eq(r.tokens, 36591, "无流事件 → iterations 末条");
  eq(r.trusted, true, "iterations 读数 trusted");
}
{
  const r = ctxReading({ streamUsage: null, resultUsage: inflatedResult });
  eq(r.tokens, 148012, "两级可信源都空 → 总和只作展示估计");
  eq(r.trusted, false, "总和估计 trusted:false");
}
{
  const r = ctxReading({ streamUsage: { output_tokens: 99 }, resultUsage: inflatedResult });
  eq(r.trusted, false, "流事件 usage 无输入侧字段(算 0)→ 跳过,落到估计");
}
eq(ctxReading({}).tokens, 0, "全空 → 0");
eq(ctxReading().tokens, 0, "无参 → 0");

// trusted:false 时任何读数都不触发(宁可不吭声,不拿虚高数误报/误归档)
eq(ctxDecide({ contextTokens: 148012, softTokens: SOFT, hardTokens: HARD, softFired: false, trusted: false }).level, "none",
   "估计值超软线 → 不触发");
eq(ctxDecide({ contextTokens: 190000, softTokens: SOFT, hardTokens: HARD, softFired: false, trusted: false }).level, "none",
   "估计值超硬线 → 也不触发(误归档是最坏结果)");
eq(ctxDecide({ contextTokens: 150000, softTokens: SOFT, hardTokens: HARD, softFired: false }).level, "soft",
   "trusted 缺省 = true(老调用方行为不变)");

// ============ ctxSoftShouldReset:虚高误触发后,可信读数回落到软线九成以下即复位 ============
ok(ctxSoftShouldReset({ contextTokens: 74302, softTokens: SOFT, softFired: true }), "误触发后回落 37% → 复位");
ok(!ctxSoftShouldReset({ contextTokens: 135000, softTokens: SOFT, softFired: true }), "回落但仍在九成线上(96%)→ 不复位");
ok(!ctxSoftShouldReset({ contextTokens: 125999, softTokens: SOFT, softFired: false }), "没触发过 → 无事可复位");
ok(!ctxSoftShouldReset({ contextTokens: 74302, softTokens: SOFT, softFired: true, trusted: false }), "估计值不作复位依据");
ok(!ctxSoftShouldReset({ contextTokens: 0, softTokens: SOFT, softFired: true }), "读数 0(无数据)→ 不复位");
ok(!ctxSoftShouldReset({ contextTokens: 74302, softTokens: 0, softFired: true }), "软阈值 0(段关闭)→ 不复位");
eq(SOFT * 0.9, 126000, "九成线基准自检(140000 → 126000)");
ok(!ctxSoftShouldReset({ contextTokens: 126000, softTokens: SOFT, softFired: true }), "恰在九成线 → 不复位(需严格低于)");
ok(ctxSoftShouldReset({ contextTokens: 125999, softTokens: SOFT, softFired: true }), "九成线下一格 → 复位");

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

// test-ctxguard.mjs — 上下文守卫决策单测,部署前跑一遍:node test-ctxguard.mjs
// 全绿输出 "ALL PASS";不碰网络、不碰 claude 进程。
import { ctxTokensOf, ctxWindowTokensOf, ctxReading, ctxDecide, ctxCompacted, ctxSoftNote, ctxHardNote, ctxFinalNote, ctxPct, ctxSoftShouldReset } from "./ctxguard.mjs";

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

// ============ 增量归档(2026-07-20):归过档后涨到 max(硬线, 上次+every) 再催 ============
const EVERY = 25000;
function decInc(t, last, every = EVERY, softFired = true) {
  return ctxDecide({ contextTokens: t, softTokens: SOFT, hardTokens: HARD, archiveEveryTokens: every, softFired, lastArchiveTokens: last }).level;
}
eq(decInc(175000, 170000), "none", "刚在 170K 归过档,175K 未到下一档 → none");
eq(decInc(194999, 170000), "none", "增量线下一格(194999)→ none");
eq(decInc(195000, 170000), "hard", "涨满一个间隔(170K+25K)→ 再催增量归档");
eq(decInc(220000, 195000), "hard", "第三档(195K+25K)照样催,循环不封顶");
eq(decInc(170000, 60000), "hard", "手动早归档(60K)不提前吃掉首催:硬线 170K 照催");
eq(decInc(169999, 60000), "none", "手动早归档:硬线之前不打扰");
eq(decInc(185000, 160000), "hard", "手动晚归档(160K):催点是 max(170K, 185K)=185K");
eq(decInc(170000, 160000), "none", "手动晚归档:170K 不足 185K → none(不紧跟着再催)");
eq(decInc(999999, 170000, 0), "none", "every=0 = 关增量:归过一次不再催");
// ---- 2026-08-10 回归:every=0 不该把硬线本身那一次也关掉 ----
// 线上真实场景:soft 155000 / hard 161500 / every 0,软线存完日记①(last=155396)之后,
// 旧写法让 161500 永久静音(日志实测一个窗口 28 条消息、fire hard 零条)。
// ⚠️ 用线上阈值,别套 decInc 的 HARD=170000。
eq(decInc(170000, 155396, 0), "hard", "every=0 + 上次归档在硬线之前 → 硬线仍催日记②(08-10 实测 bug)");
eq(decInc(169999, 155396, 0), "none", "every=0:没到硬线不催");
eq(decInc(180000, 155396, 0), "hard", "every=0:超过硬线也照催(还没在硬线之后归过)");
eq(decInc(180000, 170000, 0), "none", "every=0:已在硬线处归过档 → 不再催,增量确实是关的");
eq(decInc(999999, 175000, 0), "none", "every=0:硬线之后归过档就彻底安静(不退化成每轮都催)");
eq(decInc(170000, 160000), "none", "every>0 的老行为不受影响:手动晚归档仍按 max(硬线,上次+间隔)");
eq(decInc(150000, 145000, EVERY, false), "soft", "归档基线不挡软线:softFired 复位后软区间照常提醒");
eq(dec(170000), "hard", "老调用方不传 last/every:首催行为与旧版一致");

// ============ ctxCompacted:可信读数从软线以上暴跌过半 = CLI 静默压缩,守卫该复位 ============
ok(ctxCompacted({ contextTokens: 40000, prevTokens: 190000, softTokens: SOFT }), "190K→40K 暴跌 → 认定压缩");
ok(ctxCompacted({ contextTokens: 95000, prevTokens: 190000, softTokens: SOFT }), "恰跌到一半(95K)→ 认定压缩(<=)");
ok(!ctxCompacted({ contextTokens: 95001, prevTokens: 190000, softTokens: SOFT }), "跌不过半 → 不算压缩");
ok(!ctxCompacted({ contextTokens: 40000, prevTokens: 139999, softTokens: SOFT }), "prev 在软线之下 → 低位抖动不算压缩");
ok(ctxCompacted({ contextTokens: 60000, prevTokens: 140000, softTokens: SOFT }), "prev 恰在软线 → 参与判定");
ok(!ctxCompacted({ contextTokens: 40000, prevTokens: 190000, softTokens: SOFT, trusted: false }), "读数不可信 → 不判压缩");
ok(!ctxCompacted({ contextTokens: 0, prevTokens: 190000, softTokens: SOFT }), "新读数 0(无数据)→ 不判");
ok(!ctxCompacted({ contextTokens: 40000, prevTokens: 0, softTokens: SOFT }), "prev 0(新窗/前值不可信)→ 不判");
ok(!ctxCompacted({ contextTokens: 40000, prevTokens: 190000, softTokens: 0 }), "软阈值 0 → 检测关闭");

// ============ 文案 ============
ok(ctxSoftNote("佳佳").startsWith("【系统·上下文】"), "软文案带系统标注");
ok(ctxSoftNote("佳佳").includes("先别自己动手存"), "软文案:先别自己存");
ok(ctxSoftNote("佳佳").includes("佳佳"), "软文案代入称呼");
ok(ctxSoftNote().includes("她"), "软文案缺省称呼=她");
ok(!ctxSoftNote("佳佳").includes("archive_session"), "软文案不含归档指令");
ok(ctxHardNote().startsWith("【系统·上下文】"), "硬文案带系统标注");
ok(ctxHardNote().includes("archive_session"), "硬文案含归档工具名");
ok(!ctxHardNote().includes("新窗口"), "硬文案不再提换窗口(2026-07-20 起守卫不换窗)");
ok(ctxHardNote().includes("窗口不换"), "硬文案言明窗口不换、继续聊");
ok(ctxHardNote().includes("上次归档之后"), "硬文案交代增量归档(只写上次归档之后的新内容)");
ok(ctxHardNote().includes("不要从头重写"), "硬文案明说别从头重写(2026-08-03:防他把整段重存一遍)");
ok(ctxHardNote().includes("append=True"), "硬文案给出追加的调法");
ok(ctxHardNote().includes("别新建第二个"), "硬文案明说别新建第二个桶(同周期合并进一个桶)");
ok(ctxHardNote().includes("bucket_id 在上次 archive_session 的返回里"), "硬文案交代 bucket_id 从哪来");
ok(ctxHardNote().includes("breath"), "硬文案给出找不到桶时的兜底查法");
// 终线文案:2026-08-10 新增的时间顺序约束(他把靠前的一段挪到了桶末尾,所有者读出时间线乱)
ok(ctxFinalNote().includes("按时间顺序抄"), "终线文案:明确要求按时间顺序");
ok(ctxFinalNote().includes("不要把靠前的话挪到后面去"), "终线文案:点名禁止挪动次序(08-10 实际发生的错法)");
ok(ctxFinalNote().includes("只砍最早的那几句"), "终线文案:超长只许从最早处砍");
ok(ctxFinalNote().includes("保持原来的先后顺序"), "终线文案:砍完仍保持原次序");

// ============ 终线 final(2026-08-09):压缩前最后一次,存原话 ============
// 线上取值:soft 155000 / hard 161500 / every 0 / final 164000(压缩点实测 166933)
const L = { softTokens: 155000, hardTokens: 161500, archiveEveryTokens: 0, finalTokens: 164000 };
const live = (t, o = {}) => ctxDecide({ contextTokens: t, ...L, ...o }).level;

eq(live(150000), "none", "终线:15 万还没到软线");
eq(live(155000), "soft", "终线:软线照旧先响");
eq(live(161500, { softFired: true }), "hard", "终线:硬线照旧催日记");
eq(live(163999, { softFired: true, lastArchiveTokens: 161500 }), "none", "终线:没到终线不响(every=0 已关增量)");
// 2026-08-10:软线存完日记①(155396)之后,硬线该在 161500 补一次日记②,再到终线
eq(live(161500, { softFired: true, lastArchiveTokens: 155396 }), "hard", "线上时间线:软线之后硬线补日记②");
eq(live(163999, { softFired: true, lastArchiveTokens: 155396 }), "hard", "线上时间线:日记②没存成的话,到终线之前一直催");
eq(live(164000, { softFired: true, lastArchiveTokens: 161500 }), "final", "终线:到线催存原话");
eq(live(166000, { softFired: true, lastArchiveTokens: 161500 }), "final", "终线:超过也照响");
eq(live(166000, { softFired: true, lastArchiveTokens: 161500, finalFired: true }), "none", "终线:一个压缩周期只响一次");

// 优先级:final > hard > soft(到了终线就只干这一件,别让日记提示抢余量)
eq(live(164000), "final", "终线优先于软线(软线没响过也先走终线)");
eq(ctxDecide({ contextTokens: 164000, softTokens: 155000, hardTokens: 161500,
               archiveEveryTokens: 5000, lastArchiveTokens: 158000, finalTokens: 164000 }).level, "final",
   "终线优先于增量催档(即使增量催点也已到)");
// 同一组参数、只把终线关掉 → 落回增量催档,证明上一条确实是终线抢到的优先级
eq(ctxDecide({ contextTokens: 164000, softTokens: 155000, hardTokens: 161500,
               archiveEveryTokens: 5000, lastArchiveTokens: 158000, finalTokens: 0 }).level, "hard",
   "对照:终线关掉时同一组参数落回增量催档");

// 关闭开关:finalTokens=0 → 行为与本次改动前完全一致
eq(ctxDecide({ contextTokens: 164000, softTokens: 155000, hardTokens: 161500, softFired: true,
               lastArchiveTokens: 161500, archiveEveryTokens: 0, finalTokens: 0 }).level, "none",
   "终线关闭(0)时不触发,回到改动前行为");
// 旧调用方(完全不传 finalTokens/finalFired)行为逐字不变:没归过档 + 超硬线 = hard,永不 final
eq(ctxDecide({ contextTokens: 200000, softTokens: 155000, hardTokens: 161500, softFired: true }).level, "hard",
   "不传 finalTokens 时旧调用方行为不变(仍是 hard)");
ok(["none", "soft", "hard"].includes(
     ctxDecide({ contextTokens: 200000, softTokens: 155000, hardTokens: 161500 }).level),
   "不传 finalTokens 时永远不会冒出 final");

// trusted 门闩对终线同样生效(误报比漏报糟)
eq(live(164000, { trusted: false }), "none", "终线:读数不可信一律不触发");
eq(live(0), "none", "终线:读数 0 不触发");

// ============ ctxFinalNote 文案的机械约束 ============
ok(ctxFinalNote().includes("archive_session"), "终线文案给出建桶的调法");
ok(ctxFinalNote().includes("单独新建一个桶"), "终线文案明说独立新桶(追加进日记桶会被 awaken 截断)");
ok(ctxFinalNote().includes("原话一字不差"), "终线文案要求逐字,不是转述");
ok(!ctxFinalNote().includes("append=True"), "终线文案不能给追加调法(那会让原话进日记桶被截断)");
ok(ctxFinalNote().includes("不抄什么"), "终线文案交代不抄思考");
ok(ctxFinalNote().includes("思考"), "终线文案点名别抄内心独白(抄了 token 翻倍)");
ok(ctxFinalNote().includes("不适用"), "终线文案明说本次豁免「不写逐句对话复述」那条守则");
ok(ctxFinalNote().includes("窗口还是这个窗口"), "终线文案言明不换窗、不收尾");
ok(ctxFinalNote(1200).includes("1200"), "终线文案带出字数上限(默认 1200)");
ok(ctxFinalNote(800).includes("800"), "终线文案字数上限可配");
ok(!ctxFinalNote().includes("新窗口"), "终线文案不提换窗口");

// ============ ctxPct ============
eq(ctxPct(140000, 200000), 70, "140k/200k = 70%");
eq(ctxPct(170000, 200000), 85, "170k/200k = 85%");
eq(ctxPct(0, 200000), 0, "0 → 0%");
eq(ctxPct(100000), 50, "缺省 limit=20万 → 50%");
eq(ctxPct(100000, 0), 50, "limit 0 回落 20万");

if (bad) { console.error(`\n${bad}/${n} FAILED`); process.exit(1); }
else console.log(`ALL PASS (${n} checks)`);

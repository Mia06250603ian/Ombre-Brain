// test-recall.mjs — 自动浮现(recall.mjs)单测,部署前跑一遍:node test-recall.mjs
// 全绿输出 "ALL PASS";不碰网络、不碰 claude 进程。
import { recallMode, skipReason, coolingIds, buildUrl, formatHint, fetchRecall, observation, pushRing } from "./recall.mjs";

let n = 0, bad = 0;
function ok(cond, name) { n++; if (!cond) { bad++; console.error("FAIL:", name); } }
function eq(got, want, name) { ok(got === want, `${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

// ---- 模式:不设 / 写错 = off ----
eq(recallMode(undefined), "off", "不设 = off");
eq(recallMode(""), "off", "空 = off");
eq(recallMode("ON"), "on", "大小写");
eq(recallMode(" observe "), "observe", "去空格");
eq(recallMode("yes"), "off", "写错 = off(宁可关着)");

// ---- 该不该问 ----
const base = { mode: "on", configured: true, text: "团子今天又吐了", reset: null, systemTurn: false, windowCount: 0, windowMax: 30 };
eq(skipReason(base), "", "正常一句该问");
eq(skipReason({ ...base, mode: "off" }), "off", "off 不问");
eq(skipReason({ ...base, configured: false }), "not_configured", "没配 URL/token 不问");
eq(skipReason({ ...base, systemTurn: true }), "system_turn", "系统回合不问");
eq(skipReason({ ...base, reset: "goodnight" }), "reset", "晚安不问");
eq(skipReason({ ...base, text: "嗯" }), "too_short", "一个字不问");
eq(skipReason({ ...base, text: "   " }), "too_short", "空白不问");
eq(skipReason({ ...base, windowCount: 30 }), "window_full", "每窗上限");
eq(skipReason({ ...base, windowCount: 99, windowMax: 0 }), "", "上限 0 = 不封顶");
eq(skipReason({ ...base, mode: "observe" }), "", "observe 也要问(才有记录)");

// ---- 冷却 ----
{
  const cd = new Map([["a", 0], ["b", 10 * 3600e3]]);
  const now = 13 * 3600e3;
  const ids = coolingIds(cd, now, 12);
  eq(ids.join(","), "b", "12 小时内的还在冷却");
  ok(!cd.has("a"), "过期的顺手清掉");
}

// ---- URL ----
{
  const u = new URL(buildUrl("https://ob.example/api/recall", { q: "团子 吐了", n: 240, exclude: ["x", "y"], minAgeH: 24 }));
  eq(u.searchParams.get("q"), "团子 吐了", "q 原样");
  eq(u.searchParams.get("exclude"), "x,y", "exclude 逗号拼");
  eq(u.searchParams.get("n"), "240", "n");
  eq(u.searchParams.get("min_age_hours"), "24", "min_age_hours");
  const u2 = new URL(buildUrl("https://ob.example/api/recall", { q: "x".repeat(5000) }));
  eq(u2.searchParams.get("q").length, 2000, "q 截到 2000");
  ok(!u2.searchParams.has("exclude"), "没冷却就不带 exclude");
}

// ---- 提示行 ----
{
  const h = formatHint({ id: "abc123def456", name: "团子去宠物医院", created: "2026-09-18", excerpt: "团子连着吐了两天。" });
  ok(h.startsWith("【系统·浮现】"), "以【系统·浮现】开头");
  ok(h.includes("不是她说的") && h.includes("别提这行标注"), "标注自带用法");
  ok(h.includes("2026-09-18 「团子去宠物医院」团子连着吐了两天。"), "日期+名字+摘录");
  ok(h.includes('dream(detail_ids="abc123def456")'), "给出取全文的办法");
  ok(!h.includes("\n"), "只占一行");
  eq(formatHint(null), "", "没挑中 = 空");
  eq(formatHint({}), "", "缺 id = 空");
}

// ---- 调 OB:各种失败都不抛 ----
{
  const good = async () => ({ ok: true, json: async () => ({ pick: { id: "p1" }, reason: "ok", candidates: [] }) });
  const r1 = await fetchRecall({ url: "http://x", token: "t", timeoutMs: 100, fetchImpl: good });
  eq(r1.pick?.id, "p1", "正常返回");
  ok(typeof r1.ms === "number", "记耗时");

  const r401 = await fetchRecall({ url: "http://x", token: "t", timeoutMs: 100, fetchImpl: async () => ({ ok: false, status: 401 }) });
  eq(r401.error, "http_401", "401 不抛");

  const boom = await fetchRecall({ url: "http://x", token: "t", timeoutMs: 100, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  eq(boom.error, "fetch_failed", "连不上不抛");

  const slow = (_u, { signal }) => new Promise((_res, rej) => signal.addEventListener("abort", () => rej(signal.reason)));
  const t0 = Date.now();
  // AbortSignal.timeout 的计时器是 unref 的:单测里没别的东西撑着事件循环,得自己挂一个(线上 express 一直撑着)
  const hold = setTimeout(() => {}, 2000);
  const to = await fetchRecall({ url: "http://x", token: "t", timeoutMs: 50, fetchImpl: slow });
  clearTimeout(hold);
  eq(to.error, "timeout", "超时不抛");
  ok(Date.now() - t0 < 1000, "超时真的按时放手");

  const badJson = await fetchRecall({ url: "http://x", token: "t", timeoutMs: 100, fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError("x"); } }) });
  eq(badJson.error, "fetch_failed", "回的不是 JSON 不抛");

  let sentAuth = "";
  await fetchRecall({ url: "http://x", token: "tok", timeoutMs: 100, fetchImpl: async (_u, o) => { sentAuth = o.headers.Authorization; return { ok: true, json: async () => ({}) }; } });
  eq(sentAuth, "Bearer tok", "带 Bearer token");
}

// ---- 观察记录 ----
{
  const o = observation({ mode: "observe", text: "团子今天又不吃饭了,我好担心,要不要再带去医院看看", res: { reason: "ok", ms: 80, pick: { id: "p", name: "团子去宠物医院", rare: ["团子"], excerpt: "正文不该进记录" }, candidates: [{ name: "团子去宠物医院", score: 59, skip: "" }] }, injected: false });
  eq(o.preview.length, 24, "只留开头 24 字");
  eq(o.pick.name, "团子去宠物医院", "记下挑中的是哪件");
  ok(!JSON.stringify(o).includes("正文不该进记录"), "记录里不存记忆正文");
  eq(o.injected, false, "observe 不递");
  const s = observation({ mode: "on", text: "嗯", skip: "too_short" });
  eq(s.skip, "too_short", "没问的也记原因");
  eq(s.pick, null, "没问就没挑");
  const ring = [];
  for (let i = 0; i < 60; i++) pushRing(ring, i, 50);
  eq(ring.length, 50, "环形只留 50 条");
  eq(ring[0], 10, "丢最老的");
}

console.log(bad ? `${bad}/${n} FAILED` : `ALL PASS (${n})`);
process.exit(bad ? 1 : 0);

// test-senses.mjs — 感官模块单测,部署前跑一遍:node test-senses.mjs
// 全绿输出 "ALL PASS";不碰网络、不碰 claude 进程(踩坑 3 无关)。
import { isWeatherAsk, buildWeatherNote, detectPeriodEvent, buildPeriodNote } from "./senses.mjs";

let n = 0, bad = 0;
function ok(cond, name) {
  n++;
  if (!cond) { bad++; console.error("FAIL:", name); }
}
function eq(got, want, name) {
  ok(got === want, `${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

// ================= 经期:事件识别 =================
eq(detectPeriodEvent("姨妈来了"), "start", "start 基本");
eq(detectPeriodEvent("大姨妈驾到"), "start", "start 大姨妈");
eq(detectPeriodEvent("来例假了好烦"), "start", "start 来X了");
eq(detectPeriodEvent("月经结束了"), "end", "end 基本");
eq(detectPeriodEvent("姨妈走了"), "end", "end 走了");
eq(detectPeriodEvent("例假干净了"), "end", "end 干净了");
eq(detectPeriodEvent("姨妈来了吗"), "mention", "疑问不当 start");
eq(detectPeriodEvent("姨妈来了没"), "mention", "疑问2不当 start");
eq(detectPeriodEvent("姨妈还没来"), "mention", "否定不当 start");
eq(detectPeriodEvent("姨妈快来了"), "mention", "将来时不当 start");
eq(detectPeriodEvent("今天痛经好难受"), "mention", "痛经=提及");
eq(detectPeriodEvent("今天吃了火锅"), null, "无关消息");
eq(detectPeriodEvent(""), null, "空消息");

// ================= 经期:提醒节奏 =================
// 基线:6-25 来,7-1 结束,周期 25,经期 7 天 → 下次预计 7-20,问询窗口 7-17 ~ 7-22
const cfg = { last_period_start: "2026-06-25", last_period_end: "2026-07-01", cycle_days: 25, period_length: 7 };

let r = buildPeriodNote({ todayISO: "2026-07-16", cfg, notes: {} });
eq(r.note, "", "7-16 距预计还有4天,不吱声");

r = buildPeriodNote({ todayISO: "2026-07-17", cfg, notes: {} });
ok(r.note.includes("预计2026-07-20前后"), "7-17 进入窗口,问一次来了没");
eq(r.notesPatch?.arrival_asked_for, "2026-07-20", "问过要记账");

r = buildPeriodNote({ todayISO: "2026-07-18", cfg, notes: { arrival_asked_for: "2026-07-20" } });
eq(r.note, "", "问过一次后闭嘴");

// 她说「来了」→ 自动记录 + 当天关心额度用掉
r = buildPeriodNote({ todayISO: "2026-07-20", cfg, notes: {}, event: "start", userName: "佳佳" });
eq(r.cfgPatch?.last_period_start, "2026-07-20", "start 更新开始日");
eq(r.cfgPatch?.last_period_end, null, "start 清掉旧结束日");
eq(r.notesPatch?.care_date, "2026-07-20", "start 当天不再重复关心");
ok(r.note.includes("已自动记下"), "start 有确认注入");

// 更新后的 cfg 走后续节奏
const cfg2 = { ...cfg, last_period_start: "2026-07-20", last_period_end: null };
r = buildPeriodNote({ todayISO: "2026-07-21", cfg2: null, cfg: cfg2, notes: { care_date: "2026-07-20" } });
ok(r.note.includes("经期第2天"), "第2天再关心一次");
r = buildPeriodNote({ todayISO: "2026-07-21", cfg: cfg2, notes: { care_date: "2026-07-21" } });
eq(r.note, "", "同一天不重复关心");

r = buildPeriodNote({ todayISO: "2026-07-26", cfg: cfg2, notes: { care_date: "2026-07-21" } });
ok(r.note.includes("快结束"), "第7天问结束了没");
r = buildPeriodNote({ todayISO: "2026-07-27", cfg: cfg2, notes: { end_check_date: "2026-07-26" } });
eq(r.note, "", "隔天不追问");
r = buildPeriodNote({ todayISO: "2026-07-28", cfg: cfg2, notes: { end_check_date: "2026-07-26" } });
ok(r.note.includes("快结束"), "隔两天可再问一次");

// 她说「结束了」
r = buildPeriodNote({ todayISO: "2026-07-26", cfg: cfg2, notes: {}, event: "end" });
eq(r.cfgPatch?.last_period_end, "2026-07-26", "end 记结束日");

// 守卫:距上次开始 <15 天的「来了」不改记录
r = buildPeriodNote({ todayISO: "2026-07-25", cfg: cfg2, notes: {}, event: "start" });
eq(r.cfgPatch, null, "5天内的「来了」不当新周期");
ok(r.note.includes("经期记录"), "降级为提及");
// 守卫:已记过结束的「结束了」不重复改
r = buildPeriodNote({ todayISO: "2026-07-10", cfg, notes: {}, event: "end" });
eq(r.cfgPatch, null, "已结束再说结束不改记录");

// 提及:经期中给天数,经期外给预测
r = buildPeriodNote({ todayISO: "2026-07-21", cfg: cfg2, notes: {}, event: "mention" });
ok(r.note.includes("今天第2天"), "经期中提及给天数");
r = buildPeriodNote({ todayISO: "2026-07-10", cfg, notes: {}, event: "mention" });
ok(r.note.includes("下次预计2026-07-20"), "经期外提及给预测");

// 空配置:永远沉默
r = buildPeriodNote({ todayISO: "2026-07-16", cfg: {}, notes: {} });
eq(r.note, "", "无基线沉默");
r = buildPeriodNote({ todayISO: "bad-date", cfg, notes: {} });
eq(r.note, "", "非法日期沉默");

// ================= 天气 =================
ok(isWeatherAsk("明天下雨吗"), "问雨=问天气");
ok(isWeatherAsk("外面冷不冷"), "冷不冷=问天气");
ok(!isWeatherAsk("我好想你"), "普通消息不是问天气");

function mkWx({ code = 113, temp = 25, feels = 26, rainToday = 5, rainTom = 5, codeTom = 113, min = 20, max = 28, minTom = 20, maxTom = 28 }) {
  const hour = (c, rain) => ({ weatherCode: String(c), chanceofrain: String(rain), weatherDesc: [{ value: "x" }] });
  return {
    current_condition: [{ weatherCode: String(code), temp_C: String(temp), FeelsLikeC: String(feels), weatherDesc: [{ value: "x" }] }],
    weather: [
      { mintempC: String(min), maxtempC: String(max), hourly: Array(8).fill(hour(code, rainToday)) },
      { mintempC: String(minTom), maxtempC: String(maxTom), hourly: Array(8).fill(hour(codeTom, rainTom)) },
    ],
  };
}

let w = buildWeatherNote({ data: mkWx({ code: 113, temp: 34, max: 35 }), mode: "day" });
ok(w.note.includes("晴") && w.note.includes("34℃"), "晴天基本格式");
ok(w.note.includes("多喝水"), "高温提补水");
ok(!w.changed, "无上次基准不算突变");

w = buildWeatherNote({ data: mkWx({ code: 296, rainToday: 80 }), mode: "day", last: { desc: "晴", temp: 25 } });
ok(w.note.includes("带伞"), "下雨提带伞");
ok(w.changed, "晴转雨算突变");

w = buildWeatherNote({ data: mkWx({ temp: 30 }), mode: "day", last: { desc: "晴", temp: 25 } });
ok(w.changed, "温差5℃算突变");
w = buildWeatherNote({ data: mkWx({ temp: 27 }), mode: "day", last: { desc: "晴", temp: 25 } });
ok(!w.changed, "温差2℃不算突变");

w = buildWeatherNote({ data: mkWx({ min: 20, minTom: 14, maxTom: 22, max: 28 }), mode: "night" });
ok(w.note.includes("明天") && w.note.includes("降温"), "夜间模式提明天降温");
w = buildWeatherNote({ data: mkWx({ codeTom: 302, rainTom: 70 }), mode: "night" });
ok(w.note.includes("包里放把伞"), "夜间模式提明天带伞");
w = buildWeatherNote({ data: mkWx({ min: 8, max: 11 }), mode: "day" });
ok(w.note.includes("穿暖"), "低温提加衣");

eq(buildWeatherNote({ data: {}, mode: "day" }), null, "空数据返回 null");
eq(buildWeatherNote({ data: null, mode: "day" }), null, "null 数据返回 null");

// 真实结构兜底:未知 code 回退英文
w = buildWeatherNote({ data: mkWx({ code: 999 }), mode: "day" });
ok(w.note.includes("x"), "未知code回退原文");

console.log(bad === 0 ? `ALL PASS (${n} checks)` : `${bad}/${n} FAILED`);
process.exit(bad === 0 ? 0 : 1);

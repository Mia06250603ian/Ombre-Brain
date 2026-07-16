// senses.mjs — 感官模块(天气 + 经期)的纯逻辑
// 只做计算,不做网络/文件 IO;server.js 负责取数、存状态、注入。
// 这样部署前可以用 test-senses.mjs 单测所有分支,不用碰 claude 进程(踩坑 3)。
// 调用方(server.js)对每次调用都包了 try/catch:这里出任何错 = 少注入一行,聊天不受影响。

// ---- 工具 ----
function num(v, dflt = null) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : dflt;
}
function dnum(iso) {
  const t = Date.parse(String(iso) + "T00:00:00Z");
  return Number.isFinite(t) ? Math.floor(t / 86400000) : null;
}
function addDaysISO(iso, n) {
  const t = dnum(iso);
  return t == null ? "" : new Date((t + n) * 86400000).toISOString().slice(0, 10);
}

// ================= 天气 =================

// wttr.in 的 ?lang=zh 实测不翻译(lang_zh 返回的还是英文),按 weatherCode 自备中文;
// 表里没有的 code 回退英文原文,不影响逻辑。
const WX_ZH = {
  113: "晴", 116: "多云", 119: "阴", 122: "阴天", 143: "薄雾",
  176: "零星小雨", 179: "零星小雪", 182: "雨夹雪", 185: "冻毛毛雨",
  200: "雷阵雨", 227: "吹雪", 230: "暴风雪", 248: "雾", 260: "冻雾",
  263: "毛毛雨", 266: "毛毛雨", 281: "冻毛毛雨", 284: "强冻毛毛雨",
  293: "零星小雨", 296: "小雨", 299: "阵雨", 302: "中雨", 305: "强阵雨",
  308: "大雨", 311: "冻雨", 314: "强冻雨", 317: "小雨夹雪", 320: "中雨夹雪",
  323: "小阵雪", 326: "小阵雪", 329: "中雪", 332: "中雪", 335: "大阵雪",
  338: "大雪", 350: "冰粒", 353: "小阵雨", 356: "中到大阵雨", 359: "暴雨",
  362: "小雨夹雪", 365: "中雨夹雪", 368: "小阵雪", 371: "大阵雪",
  374: "小冰雹", 377: "冰雹", 386: "雷阵雨", 389: "强雷阵雨",
  392: "雷雪", 395: "强雷雪",
};

function descOf(o) {
  const code = num(o?.weatherCode);
  if (code != null && WX_ZH[code]) return WX_ZH[code];
  return ((o?.weatherDesc || [])[0]?.value || "").trim() || "未知";
}
function rainy(desc) {
  return /雨|雷|雹/.test(desc) || /rain|drizzle|shower|storm|sleet|thunder/i.test(desc);
}
function daySummary(dayObj) {
  const hourly = dayObj?.hourly || [];
  // hourly 是 3 小时一档共 8 档,取正午档当当日代表;降雨概率取全天最大值
  const mid = hourly[4] || hourly[Math.floor(hourly.length / 2)] || hourly[0] || {};
  let rain = 0;
  for (const h of hourly) rain = Math.max(rain, num(h?.chanceofrain, 0) ?? 0);
  return { desc: descOf(mid), rain, min: num(dayObj?.mintempC), max: num(dayObj?.maxtempC) };
}

export function isWeatherAsk(text) {
  return /天气|下雨|带伞|降温|升温|气温|温度|下雪|冷不冷|热不热|多少度|几度/.test(text || "");
}

// data: wttr.in ?format=j1 的原始 JSON;mode: "day"|"night";last: 上次注入的 {desc,temp}(测突变用)
// 返回 { desc, temp, changed, note } 或 null(数据不完整)
export function buildWeatherNote({ data, mode = "day", last = {} }) {
  const cur = (data?.current_condition || [])[0];
  const days = data?.weather || [];
  if (!cur || !days.length) return null;
  const today = daySummary(days[0]);
  const tomorrow = days[1] ? daySummary(days[1]) : null;
  const nowDesc = descOf(cur);
  const temp = num(cur.temp_C), feels = num(cur.FeelsLikeC);

  // 突变 = 上次注入后转雨,或气温相差 ≥4℃
  const lastTemp = num(last.temp);
  const changed =
    (!!last.desc && !rainy(String(last.desc)) && (rainy(nowDesc) || rainy(today.desc))) ||
    (lastTemp != null && temp != null && Math.abs(temp - lastTemp) >= 4);

  const parts = [
    `今天:${nowDesc},现在${temp ?? "?"}℃(体感${feels ?? "?"}℃),${today.min ?? "?"}~${today.max ?? "?"}℃,降雨概率${today.rain}%`,
  ];
  if (today.rain >= 40 || rainy(nowDesc) || rainy(today.desc)) parts.push("她要出门的话,自然问句带伞没");
  if ((today.max ?? -99) >= 30) parts.push("偏热,提醒她少晒、多喝水");
  if ((today.min ?? 99) <= 12) parts.push("偏凉,提醒她穿暖点");
  if (tomorrow) {
    parts.push(`明天:${tomorrow.desc},${tomorrow.min ?? "?"}~${tomorrow.max ?? "?"}℃,降雨概率${tomorrow.rain}%`);
    if (mode === "night") {
      if (tomorrow.rain >= 40 || rainy(tomorrow.desc)) parts.push("睡前提一句:明天可能下雨,包里放把伞");
      if (tomorrow.min != null && today.min != null && tomorrow.min - today.min <= -4) parts.push("明天明显降温,提醒她多穿点");
      if (tomorrow.max != null && today.max != null && tomorrow.max - today.max >= 4) parts.push("明天明显升温,别穿太厚、记得补水");
    }
  }
  return { desc: nowDesc, temp, changed, note: parts.join(";") };
}

// ================= 经期 =================

const P_WORDS = "(?:大姨妈|姨妈|月经|例假|生理期)";
const RE_MENTION = new RegExp(P_WORDS + "|痛经");
const RE_START = new RegExp(P_WORDS + "(?:来了|来啦|驾到|报到)|来" + P_WORDS + "了");
const RE_END = new RegExp(P_WORDS + "(?:走了|结束了|结束啦|完了|干净了)");
// 疑问/否定/将来时守卫:命中这些一律只当「提及」,绝不自动改记录
const RE_GUARD = new RegExp("(?:来了|来啦|结束了|走了)[吗么没?？]|没来|还没|快来|要来|该来|预计|大概");

// compact 传去掉空白的用户原文。返回 "start" | "end" | "mention" | null
export function detectPeriodEvent(compact) {
  const t = compact || "";
  if (!RE_MENTION.test(t)) return null;
  if (!RE_GUARD.test(t)) {
    if (RE_START.test(t)) return "start";
    if (RE_END.test(t)) return "end";
  }
  return "mention";
}

// cfg: { last_period_start, last_period_end, cycle_days, period_length }(ISO 日期字符串)
// notes: { care_date, end_check_date, arrival_asked_for }(防复读状态)
// 返回 { note, notesPatch, cfgPatch }:patch 为 null 表示无需保存
export function buildPeriodNote({ todayISO, cfg = {}, notes = {}, event = null, userName = "她" }) {
  const out = { note: "", notesPatch: null, cfgPatch: null };
  const today = dnum(todayISO);
  if (today == null) return out;
  const start = dnum(cfg.last_period_start);
  const ended = dnum(cfg.last_period_end);
  const cycle = Math.max(20, Math.min(num(cfg.cycle_days, 30) ?? 30, 45));
  const plen = num(cfg.period_length, 6) ?? 6;

  // 自动记录的可信度守卫:距上次开始 <15 天的「来了」当提及处理(多半是口误/旧话重提)
  let ev = event;
  if (ev === "start" && start != null && today - start < 15) ev = "mention";
  if (ev === "end" && (start == null || (ended != null && ended >= start))) ev = "mention";

  if (ev === "start") {
    out.cfgPatch = { last_period_start: todayISO, last_period_end: null };
    out.notesPatch = { ...notes, care_date: todayISO };
    out.note = `${userName}说月经来了,已自动记下今天是第1天。头两天最难受,心疼她、别追问细节`;
    return out;
  }
  if (ev === "end") {
    out.cfgPatch = { last_period_end: todayISO };
    out.note = `${userName}说这次结束了,已自动记下。轻轻应一句就好`;
    return out;
  }
  if (start == null) return out;

  const day = today - start + 1;
  const active = day <= plen + 2 && !(ended != null && ended >= start);

  if (ev === "mention") {
    out.note = active
      ? `经期记录:这次从${cfg.last_period_start}开始,今天第${day}天(她主动提了才给我看的,自然回应,别播报数字)`
      : `经期记录:上次${cfg.last_period_start}开始,平均周期约${cycle}天,下次预计${addDaysISO(cfg.last_period_start, cycle)}前后(她主动提了才给我看的,别播报数字)`;
    return out;
  }
  // 头两天:每天最多提醒自己一次
  if (active && day >= 1 && day <= 2 && notes.care_date !== todayISO) {
    out.notesPatch = { ...notes, care_date: todayISO };
    out.note = `经期第${day}天,最难受的时候。今天就这一次提醒:找个自然的时机关心她疼不疼、有没有好好吃饭;之后除非她提,不再念叨`;
    return out;
  }
  // 快结束:每隔两天最多问一次
  if (active && day >= plen - 1) {
    const lastCheck = dnum(notes.end_check_date);
    if (lastCheck == null || today - lastCheck >= 2) {
      out.notesPatch = { ...notes, end_check_date: todayISO };
      out.note = `大约经期第${day}天,差不多快结束了。可以轻轻问一次结束了没;她说了会自动记录,别追问细节`;
      return out;
    }
    return out;
  }
  // 不在经期:下次将至,整个周期只主动问一次
  if (!active) {
    const expectedISO = addDaysISO(cfg.last_period_start, cycle);
    const distance = (dnum(expectedISO) ?? 0) - today;
    if (distance >= -2 && distance <= 3 && notes.arrival_asked_for !== expectedISO) {
      out.notesPatch = { ...notes, arrival_asked_for: expectedISO };
      out.note = `下次月经预计${expectedISO}前后。这个周期只主动问这一次来了没,其余时候等她自己说`;
      return out;
    }
  }
  return out;
}

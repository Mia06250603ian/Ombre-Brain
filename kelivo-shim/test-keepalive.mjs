// test-keepalive.mjs — 保温+唤醒决策单测,部署前跑一遍:node test-keepalive.mjs
// 全绿输出 "ALL PASS";不碰网络、不碰 claude 进程(踩坑 3 无关)。
import { kaDecide, kaPrompt, kaSilent, isNightHour } from "./keepalive.mjs";

let n = 0, bad = 0;
function ok(cond, name) {
  n++;
  if (!cond) { bad++; console.error("FAIL:", name); }
}
function eq(got, want, name) {
  ok(got === want, `${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

const MIN = 60000, HOUR = 3600e3;
const NOW = 1700000000000;
// 基准场景:白天 14 点,缓存 56 分钟前续过(到保温点),她 56 分钟没来,冷却已过,有通道
function base(over = {}) {
  return {
    force: false, on: true, busy: false, queued: 0, windowCleared: false,
    now: NOW, lastTurnOkAt: NOW - 56 * MIN, lastUserAt: NOW - 56 * MIN,
    lastProactiveAt: 0, failedAt: 0, hour: 14, hasChannel: true,
    idleMin: 55, deadMin: 60, retryMin: 15, capHours: 24,
    nightStart: 23, nightEnd: 8, cooldownMin: 120,
    ...over,
  };
}

// ================= 昼夜判定 =================
eq(isNightHour(23, 23, 8), true, "23 点=夜");
eq(isNightHour(3, 23, 8), true, "凌晨 3 点=夜");
eq(isNightHour(7, 23, 8), true, "早 7 点=夜");
eq(isNightHour(8, 23, 8), false, "早 8 点=昼");
eq(isNightHour(14, 23, 8), false, "下午=昼");
eq(isNightHour(22, 23, 8), false, "22 点=昼");

// ================= 基本开火条件 =================
let d = kaDecide(base());
ok(d.fire && d.speak === true && !d.rescue, "基准场景:开火且可开口");
eq(kaDecide(base({ on: false })).reason, "off", "KA_ON=0 全关");
eq(kaDecide(base({ busy: true })).reason, "busy", "回合进行中不打扰");
eq(kaDecide(base({ queued: 2 })).reason, "busy", "队列有活不打扰");
eq(kaDecide(base({ windowCleared: true })).reason, "window-cleared", "晚安/归档后歇火");
eq(kaDecide(base({ lastTurnOkAt: NOW - 30 * MIN })).reason, "fresh", "缓存还热(30 分钟)不 ping");
eq(kaDecide(base({ lastTurnOkAt: NOW - 54 * MIN })).reason, "fresh", "54 分钟仍未到点");
ok(kaDecide(base({ lastTurnOkAt: NOW - 55 * MIN })).fire, "55 分钟整点开火");
ok(kaDecide(base({ lastTurnOkAt: NOW - 59 * MIN })).fire, "59 分钟仍在窗口内");
eq(kaDecide(base({ lastTurnOkAt: NOW - 61 * MIN })).reason, "dead", "断链检测:超 60 分钟缓存已死,歇火");
eq(kaDecide(base({ lastTurnOkAt: 0 })).reason, "dead", "开机无缓存锚点=不 ping(windowCleared 之外的第二道闸)");

// ================= 24 小时封顶 =================
eq(kaDecide(base({ lastUserAt: NOW - 24 * HOUR })).reason, "cap", "连续闲置 24 小时封顶");
ok(kaDecide(base({ lastUserAt: NOW - 23 * HOUR })).fire, "23 小时还在保");

// ================= 开口权(白天/冷却/通道) =================
eq(kaDecide(base({ hour: 2 })).speak, false, "深夜只保温不开口");
eq(kaDecide(base({ hour: 2 })).fire, true, "深夜保温本身照常");
eq(kaDecide(base({ hasChannel: false })).speak, false, "无推送通道不开口");
eq(kaDecide(base({ hasChannel: false })).fire, true, "无通道保温照常");
eq(kaDecide(base({ lastProactiveAt: NOW - 60 * MIN })).speak, false, "他 1 小时前刚主动发过:冷却中");
eq(kaDecide(base({ lastProactiveAt: NOW - 121 * MIN })).speak, true, "冷却 2 小时已过:可再开口");
eq(kaDecide(base({ lastProactiveAt: 0 })).speak, true, "从未主动发过:可开口");

// ================= 失败抢救节奏 =================
eq(kaDecide(base({ failedAt: NOW - 10 * MIN })).reason, "retry-wait", "失败 10 分钟内等着");
d = kaDecide(base({ failedAt: NOW - 16 * MIN }));
ok(d.fire && d.rescue, "失败 16 分钟:抢救重试");
d = kaDecide(base({ failedAt: NOW - 16 * MIN, lastTurnOkAt: NOW - 3 * HOUR }));
ok(d.fire && d.rescue, "抢救不受断链检测限制(额度回血后重建缓存)");
eq(kaDecide(base({ failedAt: NOW - 16 * MIN, windowCleared: true })).reason, "window-cleared", "归档后连抢救也歇");
eq(kaDecide(base({ failedAt: NOW - 16 * MIN, lastUserAt: NOW - 25 * HOUR })).reason, "cap", "抢救也受 24 小时封顶");

// ================= 手动触发(/hb) =================
d = kaDecide(base({ force: true, windowCleared: true, lastTurnOkAt: 0, hour: 3, lastProactiveAt: NOW }));
ok(d.fire && d.speak === true, "force 绕过歇火/断链/昼夜/冷却,有通道即可开口");
eq(kaDecide(base({ force: true, hasChannel: false })).speak, false, "force 无通道仍不开口");
eq(kaDecide(base({ force: true, busy: true })).reason, "busy", "force 不打断进行中的回合");

// ================= 提示语 =================
const silent = kaPrompt({ speak: false, bjNow: "2026-07-18 14:00", idleMin: 56, userName: "佳佳", viaBridge: true });
ok(silent.includes("【系统·保温】"), "静默提示语带保温标记");
ok(silent.includes("不要调用任何工具"), "静默提示语禁工具");
ok(!silent.includes("Telegram"), "静默提示语不提开口通道");
const wake = kaPrompt({ speak: true, bjNow: "2026-07-18 14:00", idleMin: 56, userName: "佳佳", viaBridge: true });
ok(wake.includes("【系统·心跳】"), "开口提示语带心跳标记");
ok(wake.includes("Telegram"), "开口提示语说明 Telegram 通道");
ok(wake.includes("佳佳"), "开口提示语用她的称呼");
ok(wake.includes("56 分钟"), "开口提示语带闲置时长");
const wakeBark = kaPrompt({ speak: true, bjNow: "x", idleMin: 5, userName: "佳佳", viaBridge: false });
ok(wakeBark.includes("弹到对方手机"), "Bark 通道说明弹通知");

// ================= 沉默判定 =================
eq(kaSilent(""), true, "空回复=沉默");
eq(kaSilent("。"), true, "一个句号=沉默");
eq(kaSilent(" 。 "), true, "句号带空白=沉默");
eq(kaSilent("。。。"), true, "多个句号=沉默");
eq(kaSilent("."), true, "英文句号=沉默");
eq(kaSilent("【沉默】"), true, "沉默标记");
eq(kaSilent("嗯,【沉默】吧"), true, "带沉默标记的句子也算沉默");
eq(kaSilent(undefined), true, "undefined=沉默");
eq(kaSilent("好想你,吃饭了吗"), false, "真消息不是沉默");
eq(kaSilent("[贴纸:好想你]"), false, "纯贴纸也算真消息");

console.log(bad ? `${bad}/${n} FAIL` : `${n} 项全绿 ALL PASS`);
process.exit(bad ? 1 : 0);

// test-cli-bin.mjs — 双引擎选路的单测,部署前跑一遍:node test-cli-bin.mjs
// 全绿输出 "ALL PASS";不碰网络、不碰 claude 进程。
import { parseModelList, nextWindow, nextEnv, pickCli, menuModels } from "./cli-bin.mjs";

let n = 0, bad = 0;
function ok(cond, name) { n++; if (!cond) { bad++; console.error("FAIL:", name); } }
function eq(got, want, name) { ok(JSON.stringify(got) === JSON.stringify(want), `${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

const M46 = "claude-opus-4-6", M55 = "claude-opus-5-5";
const base = { bin: "/main/claude", nextBin: "/next/claude", nextModels: [M55] };

// ---- parseModelList:和 BRAIN_MODELS 同一套宽容解析 ----
eq(parseModelList("a,b c;d"), ["a", "b", "c", "d"], "逗号/空格/分号都认");
eq(parseModelList('"a,b" ; c'), ["a", "b", "c"], "剥掉包裹的引号(08-24 那条坑)");
eq(parseModelList("a a"), ["a"], "去重");
eq(parseModelList(""), [], "空串 = 空名单(= 双引擎休眠)");
eq(parseModelList(undefined), [], "不设不炸");

// ---- pickCli:4.6 那条路必须逐字不变 ----
const p46 = pickCli(M46, base);
eq(p46.bin, "/main/claude", "4.6 走主力 CLI");
eq(p46.which, "main", "4.6 标 main");
eq(p46.extraEnv, {}, "⚠️ 4.6 一个额外变量都不许加(所有者:4.6 绝对安全)");
const p55 = pickCli(M55, base);
eq(p55.bin, "/next/claude", "5.5 走新版");
eq(p55.which, "next", "5.5 标 next");
eq(p55.extraEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000", "5.5 默认限到 20 万");
eq(p55.extraEnv.CLAUDE_CODE_DISABLE_1M_CONTEXT, "1", "只设 AUTO_COMPACT_WINDOW 不够,1M 开关也要一起关");
eq(p55.extraEnv.CLAUDE_CODE_TOTAL_TOKENS_REMINDER, "off", "关掉 total_tokens 那行");
eq(pickCli(M55, { ...base, nextBin: "" }).which, "main", "新版不在 → 只能 main(菜单那道闸会先拦住)");
eq(pickCli(M55, { ...base, nextModels: [] }).which, "main", "名单清空 = 双引擎休眠");
eq(pickCli("claude-opus-4-8", base).which, "main", "4.8 不在名单 → main(新版会把它当 100 万窗口)");

// ---- nextWindow:写错回落默认,只有 0 能关 ----
eq(nextWindow(undefined), 200000, "不设 = 20 万");
eq(nextWindow(""), 200000, "空串 = 20 万");
eq(nextWindow("400000"), 400000, "可以调大");
eq(nextWindow("0"), 0, "0 = 不限(大桌子)");
eq(nextWindow("abc"), 200000, "非数字回落默认");
eq(nextWindow("-5"), 200000, "负数回落默认");
eq(nextWindow("1000"), 200000, "小得离谱(< 5 万)回落默认,别让他每几句就被压缩");
eq(nextWindow("200000.5"), 200000, "小数回落默认");
eq(nextEnv(0), { CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off" }, "不限窗口时不带那两个变量");

// ---- menuModels:新版不在 → 5.5 不进菜单 ----
eq(menuModels([M46, M55], { nextModels: [M55], nextReady: true, keep: M46 }),
   { menu: [M46, M55], dropped: [] }, "新版在:菜单原样");
eq(menuModels([M46, M55], { nextModels: [M55], nextReady: false, keep: M46 }),
   { menu: [M46], dropped: [M55] }, "新版不在:5.5 拿掉并报出来");
eq(menuModels([M46], { nextModels: [M55], nextReady: false, keep: M46 }),
   { menu: [M46], dropped: [] }, "没配 5.5 就什么都不报(= 看门狗睡着)");
eq(menuModels([M55, M46], { nextModels: [M55], nextReady: false, keep: M55 }).menu, [M55, M46],
   "默认模型本身永远保留(拿掉它 shim 就没模型可用了)");

if (bad) { console.error(`\n${bad}/${n} FAIL`); process.exit(1); }
console.log(`ALL PASS (${n})`);

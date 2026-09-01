// test-toolvis.mjs — 工具可见化的单测,部署前跑一遍:node test-toolvis.mjs
// 全绿输出 "ALL PASS";不碰网络、不碰 claude 进程。
import {
  TOOLVIS_DEFAULTS, toolName, oneLine, clip, redactArgs,
  formatArgs, formatResult, resultTextOf, pickToolResults,
} from "./toolvis.mjs";

let n = 0, bad = 0;
function ok(cond, name) { n++; if (!cond) { bad++; console.error("FAIL:", name); } }
function eq(got, want, name) { ok(got === want, `${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

// ---- toolName:和原来那行 〔🔧 …〕 的口径必须一致 ----
eq(toolName("mcp__ombre-brain__hold"), "ombre-brain__hold", "剥掉 mcp__ 前缀");
eq(toolName("mcp__netease__search"), "netease__search", "网易云那些也一样");
eq(toolName(""), "", "空串不炸");
eq(toolName(undefined), "", "undefined 不炸");

// ---- oneLine:一件事占一行 ----
eq(oneLine("a\nb"), "a b", "换行压成空格");
eq(oneLine("  a \t\n  b  "), "a b", "首尾空白去掉、中间连续空白合一");
eq(oneLine(null), "", "null 不炸");

// ---- clip:按「字」截断,不是字节 ----
eq(clip("abc", 10), "abc", "没超就原样返回");
eq(clip("abcdef", 3), "abc…(共 6 字)", "超了要截,并说清原文多长");
eq(clip("一二三四五", 2), "一二…(共 5 字)", "中文一个字算一个,不是三字节");
eq(clip("abc", 0), "abc", "上限 0 = 不截(留给「不想截」的配置)");
eq(clip("", 5), "", "空串不炸");
// 表情符号是代理对,用 slice 会劈出半个字符 —— 这条钉住必须用 [...s]
ok(!clip("🦀🦀🦀", 2).includes("�"), "截表情符号不能劈出乱码");
eq(clip("🦀🦀🦀", 2), "🦀🦀…(共 3 字)", "表情按一个字算");

// ---- redactArgs:打码只盖该盖的 ----
eq(JSON.stringify(redactArgs({ content: "她说想吃火锅", tags: "约定" }, ["content"])),
   JSON.stringify({ content: "〔6 字〕", tags: "约定" }), "content 换成字数,其余原样");
eq(JSON.stringify(redactArgs({ query: "火锅" }, ["content"])),
   JSON.stringify({ query: "火锅" }), "没命中就一个字不动");
eq(JSON.stringify(redactArgs({ content: 42 }, ["content"])),
   JSON.stringify({ content: 42 }), "非字符串不动(别把数字盖成〔N 字〕)");
ok(redactArgs(null, ["content"]) === null, "null 不炸");
ok(Array.isArray(redactArgs([1, 2], ["content"])), "数组原样返回");

// ---- formatArgs ----
eq(formatArgs('{"query":"火锅"}'), '  → {"query":"火锅"}\n', "正常参数一行");
eq(formatArgs(""), "", "没参数不占行");
eq(formatArgs("{}"), "", "空对象也不占行");
eq(formatArgs('{"a":1}', { on: false }), "", "总开关关掉就什么都不出");
// ⚠️ 这条是本模块存在的理由之一:流被打断时攒到一半的 JSON 不能让它炸
eq(formatArgs('{"content":"她说'), '  → {"content":"她说\n', "半截 JSON 原样显示,不解析、不抛异常");
eq(formatArgs('{"content":"' + "字".repeat(300) + '"}', { argChars: 10 }),
   '  → {"content"…(共 314 字)\n', "参数超长照样截");
eq(formatArgs('{"content":"a\\nb"}'), '  → {"content":"a\\nb"}\n', "JSON 里的换行是转义的,显示仍是一行");
// 真换行在 JSON 里是非法的 → 走解析失败那条兜底路,压成一行照样显示
eq(formatArgs('{"content":"a\nb"}'), '  → {"content":"a b"}\n', "带真换行的半截 JSON 也压成一行");
eq(formatArgs('{"content":"她说想吃火锅","tags":"约定"}', { redact: true, redactKeys: ["content"] }),
   '  → {"content":"〔6 字〕","tags":"约定"}\n', "打码开着时正文被盖住(截图外发那条路)");
eq(formatArgs('{"content":"她说想吃火锅"}'),
   '  → {"content":"她说想吃火锅"}\n', "⚠️ 默认不打码 = 记忆原文会显示出来,这是所有者知情选的");

// ---- formatResult ----
eq(formatResult("已存入 #4471"), "  ← 已存入 #4471\n", "正常返回一行");
eq(formatResult(""), "", "空返回不占行");
eq(formatResult("   "), "", "只有空白也不占行");
eq(formatResult("boom", { isError: true }), "  ←✗ boom\n", "工具报错用 ←✗ 区分");
eq(formatResult("字".repeat(5000), { resultChars: 5 }), "  ← 字字字字字…(共 5000 字)\n",
   "awaken 那种几千字必须截 —— 是防刷屏(不是省窗口:2026-09-01 核实显示不回流,见 toolvis.mjs 头注)");
eq(formatResult("a\nb\nc"), "  ← a b c\n", "多行返回压成一行");
eq(formatResult("x", { on: false }), "", "总开关关掉就什么都不出");
// 默认那把尺子本身也钉住,免得以后有人手滑改大了没人发现
eq(TOOLVIS_DEFAULTS.resultChars, 200, "默认截 200 字(2026-09-01 所有者定)");
eq(TOOLVIS_DEFAULTS.argChars, 200, "参数同样 200 字");
eq(TOOLVIS_DEFAULTS.redact, false, "默认不打码(2026-09-01 所有者定,已报备截图外发的风险)");

// ---- resultTextOf:CLI 那三种形状都得认 ----
eq(resultTextOf({ content: "纯字符串" }), "纯字符串", "content 是字符串");
eq(resultTextOf({ content: [{ type: "text", text: "块" }, { type: "text", text: "拼起来" }] }),
   "块拼起来", "content 是块数组,按顺序拼");
eq(resultTextOf({ text: "老形态" }), "老形态", "老形态直接给 text");
eq(resultTextOf({ content: [{ type: "image" }] }), "", "图片块没有文字,不炸");
eq(resultTextOf(null), "", "null 不炸");
eq(resultTextOf({}), "", "空对象不炸");

// ---- pickToolResults:工具结果是以一条 user 事件回来的 ----
const uev = { type: "user", message: { role: "user", content: [
  { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "已存入 #4471" }] },
] } };
eq(pickToolResults(uev).length, 1, "从 user 事件里捡出一条结果");
eq(pickToolResults(uev)[0].id, "toolu_1", "带着 tool_use_id(靠它对上是哪个工具)");
eq(pickToolResults(uev)[0].text, "已存入 #4471", "正文抠出来了");
eq(pickToolResults(uev)[0].isError, false, "没报错标记就是 false");
eq(pickToolResults({ type: "user", message: { content: [
  { type: "tool_result", tool_use_id: "t", content: "炸了", is_error: true }] } })[0].isError,
   true, "is_error 要带出来(决定显示 ←✗)");
eq(pickToolResults({ type: "user", message: { content: [
  { type: "tool_result", tool_use_id: "a", content: "1" },
  { type: "tool_result", tool_use_id: "b", content: "2" }] } }).length, 2, "一条事件里可能有多个结果");
eq(pickToolResults({ type: "stream_event", event: {} }).length, 0, "流事件不是 user,不认");
eq(pickToolResults({ type: "result" }).length, 0, "result 事件不认");
eq(pickToolResults(null).length, 0, "null 不炸");
eq(pickToolResults({ type: "user" }).length, 0, "没有 message 不炸");
eq(pickToolResults({ type: "user", message: { content: "她说的话" } }).length, 0,
   "⚠️ 真正的用户消息(content 是字符串)不能被当成工具结果");
eq(pickToolResults({ type: "user", message: { content: [{ type: "text", text: "她说的话" }] } }).length, 0,
   "⚠️ 用户消息的文本块也不能被当成工具结果 —— 只认 tool_result");

console.log(bad ? `${bad}/${n} FAIL` : `${n} 项全绿 ALL PASS`);
process.exit(bad ? 1 : 0);

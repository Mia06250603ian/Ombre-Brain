// dwell-bridge 单测。只测纯逻辑（dwell-lib.mjs），不起服务、不连网。
// 跑法：node test-dwell.mjs
//
// 重点测「被切断」这件事：SSE 帧和标记都会被 HTTP 分块切成两半，
// 这是这层最容易写错、也最难在真环境里复现的地方。

import {
  makeSSEParser, makeStripper, makeEventLog, makeMsgLog,
  safeEqual, makeToken, buildShimBody, parseLog, verFrom,
  evEcho, evText, evThink, evToolUse, evToolDone, evFinal, evResult,
} from "./dwell-lib.mjs";
import { stripDemo } from "./strip-demo.mjs";
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.error("  ✗ " + name); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}\n    实际=${JSON.stringify(a)}\n    期望=${JSON.stringify(b)}`);

/* ───── ① SSE 解析 ───── */
{
  const p = makeSSEParser();
  const f = p.push('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}\n\n');
  ok(f.length === 1, "SSE：一帧完整收到");
  eq(f[0].data.delta.text, "你好", "SSE：正文取出来了");
  eq(f[0].event, "content_block_delta", "SSE：事件名取出来了");
}
{
  // 一帧被切成三块——这是真实网络下最常见的情况
  const p = makeSSEParser();
  ok(p.push('event: content_block_delta\nda').length === 0, "SSE：半截帧不吐");
  ok(p.push('ta: {"type":"x","delta":{"type":"text_delta","tex').length === 0, "SSE：还是半截，仍不吐");
  const f = p.push('t":"拼好了"}}\n\n');
  ok(f.length === 1, "SSE：拼齐后吐一帧");
  eq(f[0].data.delta.text, "拼好了", "SSE：跨三块的内容拼对了");
}
{
  // 三帧挤在一块里
  const p = makeSSEParser();
  const f = p.push('data: {"type":"a"}\n\ndata: {"type":"b"}\n\ndata: {"type":"c"}\n\n');
  ok(f.length === 3, "SSE：一块里三帧全取出");
  eq(f.map((x) => x.data.type), ["a", "b", "c"], "SSE：三帧顺序没乱");
}
{
  const p = makeSSEParser();
  ok(p.push("data: 这不是JSON\n\n").length === 0, "SSE：坏 JSON 丢掉，不抛异常");
  const f = p.push('data: {"type":"ok"}\n\n');
  ok(f.length === 1, "SSE：坏帧之后照常工作");
}
{
  const p = makeSSEParser();
  ok(p.push("event: ping\n\n").length === 0, "SSE：没有 data 的帧忽略");
}

/* ───── ② 剥标记 ───── */
{
  const s = makeStripper();
  eq(s.push("今天天气不错"), [{ kind: "text", text: "今天天气不错" }], "剥：没有标记时原样过");
}
{
  const s = makeStripper();
  const out = s.push("想你了[贴纸:贴贴]晚安");
  eq(out, [
    { kind: "text", text: "想你了" },
    { kind: "text", text: "〔贴纸：贴贴〕" },
    { kind: "text", text: "晚安" },
  ], "剥：贴纸换成看得见的占位");
}
{
  // 贴纸被切断——扣住尾巴，等下一块
  const s = makeStripper();
  const a = s.push("想你了[贴");
  eq(a, [{ kind: "text", text: "想你了" }], "剥：半截标记不吐出去");
  const b = s.push("纸:贴贴]晚安");
  eq(b, [
    { kind: "text", text: "〔贴纸：贴贴〕" },
    { kind: "text", text: "晚安" },
  ], "剥：下一块拼齐后正确剥出");
}
{
  const s = makeStripper();
  const a = s.push("[语音]Good night");
  eq(a, [{ kind: "text", text: "〔语音〕" }, { kind: "text", text: "Good night" }], "剥：语音开标记换成提示，内容保留");
  ok(s.inVoice() === true, "剥：语音状态记住了");
  const b = s.push("[/语音]");
  eq(b, [], "剥：语音闭标记直接吃掉");
  ok(s.inVoice() === false, "剥：语音状态复位");
}
{
  const s = makeStripper();
  const out = s.push("先想想〔🔧 ombre-brain__breath〕查到了");
  eq(out, [
    { kind: "text", text: "先想想" },
    { kind: "tool", name: "ombre-brain__breath" },
    { kind: "text", text: "查到了" },
  ], "剥：工具标记变成 tool 事件");
}
{
  // 工具标记跨块（🔧 是代理对，最容易在这儿切坏）
  const s = makeStripper();
  const a = s.push("先想想〔🔧 ombre");
  eq(a, [{ kind: "text", text: "先想想" }], "剥：工具标记没收完就扣住");
  const b = s.push("-brain__hold〕好了");
  eq(b, [{ kind: "tool", name: "ombre-brain__hold" }, { kind: "text", text: "好了" }], "剥：工具标记跨块拼对");
}
{
  const s = makeStripper();
  s.push("话说到一半[贴");
  eq(s.flush(), [{ kind: "text", text: "[贴" }], "剥：流结束时把扣住的残缺标记原样吐出，不吞字");
}
{
  const s = makeStripper();
  const out = s.push("[贴纸:哭哭][贴纸:贴贴]");
  eq(out, [
    { kind: "text", text: "〔贴纸：哭哭〕" },
    { kind: "text", text: "〔贴纸：贴贴〕" },
  ], "剥：连着两个标记都剥对");
}

/* ───── ③ 事件队列 ───── */
{
  const q = makeEventLog();
  q.push(evText("a")); q.push(evText("b"));
  const r = q.since(0);
  ok(r.events.length === 2, "队列：从头取到两条");
  eq(r.next, 2, "队列：游标推进到 2");
  const r2 = q.since(2);
  ok(r2.events.length === 0, "队列：游标到位后没有新的");
  q.push(evText("c"));
  const r3 = q.since(2);
  ok(r3.events.length === 1, "队列：只给游标之后的");
  eq(r3.events[0].event.delta.text, "c", "队列：给的是对的那条");
}
{
  const q = makeEventLog({ cap: 3 });
  for (let i = 0; i < 10; i++) q.push(evText(String(i)));
  const r = q.since(0);
  ok(r.events.length === 3, "队列：超过上限只留最近的");
  eq(r.next, 10, "队列：游标仍是真实序号，不因截断回退");
}

/* ───── ④ 消息账本 ───── */
{
  const m = makeMsgLog();
  m.addMe("在吗"); m.addThink("她在叫我"); m.addGu("在"); m.addTool("ombre-brain__breath");
  const r = m.slice({ limit: 400 });
  eq(r.msgs.map((x) => x.kind), ["me", "think", "gu", "tool"], "账本：四种 kind 都记下了");
  eq(r.upto, 4, "账本：upto 是最后一条的 seq");
  ok(r.more === false, "账本：没有更早的了");
  ok(r.msgs.every((x) => typeof x.at === "number"), "账本：每条都带时间");
}
{
  const m = makeMsgLog();
  for (let i = 1; i <= 10; i++) m.addMe("第" + i);
  const r = m.slice({ limit: 3 });
  eq(r.msgs.map((x) => x.text), ["第8", "第9", "第10"], "账本：limit 取最近的三条");
  ok(r.more === true, "账本：还有更早的，more 为真");
  const older = m.slice({ limit: 3, before: r.msgs[0].seq });
  eq(older.msgs.map((x) => x.text), ["第5", "第6", "第7"], "账本：before 往前翻一页");
}
{
  const m = makeMsgLog();
  eq(m.slice({}).upto, 0, "账本：空账本 upto 为 0");
  ok(m.slice({}).msgs.length === 0, "账本：空账本不报错");
}
{
  // 开机接回：内容和顺序原样，seq 重新编号（游标只在本次运行内有意义）
  const m = makeMsgLog();
  const n = m.restore([
    { kind: "me", text: "昨天说的那件事", at: 1 },
    { kind: "gu", text: "记得", at: 2 },
    { kind: "x" },                                  // 缺字段的坏行
    { kind: "tool", text: "ombre-brain__breath", at: 3, extra: "{}" },
  ]);
  ok(n === 3, "接回：坏行丢掉，只接回三条");
  const r = m.slice({ limit: 400 });
  eq(r.msgs.map((x) => x.text), ["昨天说的那件事", "记得", "ombre-brain__breath"], "接回：顺序和内容原样");
  eq(r.msgs.map((x) => x.seq), [1, 2, 3], "接回：seq 从 1 重新编号");
  m.addMe("今天又来了");
  eq(m.slice({ limit: 1 }).msgs[0].seq, 4, "接回：接着往下编号，不和旧的撞");
}

/* ───── ④b 落盘记录：解析与轮转 ───── */
{
  const text = [
    JSON.stringify({ seq: 1, kind: "me", text: "在吗" }),
    JSON.stringify({ seq: 2, kind: "gu", text: "在" }),
    '{"kind":"me","text":"写到一半断',                 // 断电留下的半行
    "",
  ].join("\n");
  const r = parseLog(text);
  eq(r.list.map((x) => x.text), ["在吗", "在"], "落盘：坏行丢掉，好的照常读回");
  eq(r.total, 3, "落盘：total 数的是文件里的行数（含坏行）");
  ok(r.rotate === false, "落盘：没超上限就不轮转");
}
{
  const lines = [];
  for (let i = 1; i <= 40; i++) lines.push(JSON.stringify({ kind: "me", text: "第" + i }));
  const r = parseLog(lines.join("\n"), { cap: 5, keepMax: 15 });
  eq(r.list.length, 5, "落盘：只读回最后 cap 条");
  eq(r.list[0].text, "第36", "落盘：读回的是最后那一段");
  ok(r.rotate === true, "落盘：超过 keepMax 就该轮转");
  eq(r.tail.length, 5, "落盘：轮转写回的是那 cap 行原文");
  ok(r.tail[0] === lines[35], "落盘：写回的是原始字节，不是重新序列化的");
}
{
  const r = parseLog("");
  eq(r.list.length, 0, "落盘：空文件不报错");
  ok(r.rotate === false, "落盘：空文件不轮转");
}

/* ───── ④c 这一版网页的指纹 ───── */
{
  ok(verFrom("a", "b") === verFrom("a", "b"), "指纹：同样的内容算出同样的值");
  ok(verFrom("a", "b") !== verFrom("a", "c"), "指纹：任一文件变了值就变");
  ok(verFrom("a", "b") !== verFrom("ab", ""), "指纹：分段不会被揉成一串（a|b ≠ ab|）");
  ok(verFrom("x").length <= 10, "指纹：短到能塞进每个 poll 回复里");
  // 前端靠它决定要不要 location.reload()，所以队列必须把它原样带出来
  const q = makeEventLog({ ver: "deadbeef" });
  eq(q.since(0).ver, "deadbeef", "指纹：poll 回复里带着这一版的值");
  eq(makeEventLog().since(0).ver, "1", "指纹：不给就还是老的写死值（兼容）");
}

/* ───── ⑤ 鉴权 ───── */
{
  ok(safeEqual("abc", "abc") === true, "鉴权：相同为真");
  ok(safeEqual("abc", "abd") === false, "鉴权：不同为假");
  ok(safeEqual("abc", "abcd") === false, "鉴权：长度不同为假");
  ok(safeEqual(null, "") === true, "鉴权：null 当空串");
  ok(safeEqual(undefined, "x") === false, "鉴权：undefined 不等于非空");
}
{
  const a = makeToken("mypass", "salt1");
  ok(a === makeToken("mypass", "salt1"), "鉴权：同密码同盐得同令牌");
  ok(a !== makeToken("mypass", "salt2"), "鉴权：换盐令牌就变（重启即失效）");
  ok(a !== makeToken("otherpass", "salt1"), "鉴权：换密码令牌就变");
  ok(!a.includes("mypass"), "鉴权：令牌里不含明文密码");
}

/* ───── ⑥ 发给 shim 的请求体 ───── */
{
  const b = buildShimBody("你好");
  eq(b.messages.length, 1, "请求体：只发一条——历史在他进程里，不重复喂");
  eq(b.messages[0].role, "user", "请求体：角色是 user");
  eq(b.messages[0].content, "你好", "请求体：纯文本时 content 就是字符串");
  ok(b.stream === true, "请求体：要流式");
  ok(!("model" in b), "请求体：**不许报模型**——报了会把她在 Kelivo 切的模型拽回去(2026-08-24 方案 B)");
}
{
  const b = buildShimBody("看这个", { images: [{ mime: "image/png", data: "AAAA" }] });
  ok(Array.isArray(b.messages[0].content), "请求体：带图时 content 是数组");
  eq(b.messages[0].content[0].type, "image", "请求体：图片在前");
  eq(b.messages[0].content[1].type, "text", "请求体：文字在后");
}

/* ───── ⑦ 事件形状必须和前端 handle() 对得上 ───── */
// 这几条是照 web/index.html:3373 起逐行核对的，改前端时要一起改。
{
  eq(evEcho("嗨"), { type: "echo", text: "嗨" }, "形状：echo");
  eq(evText("字").event.delta.type, "text_delta", "形状：正文走 text_delta");
  eq(evThink("念").event.delta.type, "thinking_delta", "形状：思考走 thinking_delta");
  eq(evThink("念").event.delta.thinking, "念", "形状：思考的字段名是 thinking 不是 text");
  eq(evText("字").type, "stream_event", "形状：增量都包在 stream_event 里");
  eq(evToolUse("breath", "t1").message.content[0].type, "tool_use", "形状：工具卡片");
  eq(evToolDone("t1").message.content[0].tool_use_id, "t1", "形状：工具收尾对得上 id");
  eq(evToolDone("t1").type, "user", "形状：tool_result 走 user 事件");
  eq(evFinal("定稿").message.content[0].text, "定稿", "形状：定稿走 assistant");
  eq(evResult(false).type, "result", "形状：收尾事件");
  ok(evResult(false).is_error === false, "形状：正常收尾 is_error 为假");
  ok(evResult(true, "上游断了").result === "上游断了", "形状：出错收尾带原因");
}

/* ───── ⑧ 删演示拦截块 ───── */
{
  const fake = [
    "<script>",
    "/* ────────",
    "   演示模式。把 fetch 拦下来喂假数据。",
    "   ──────── */",
    "(function () {",
    "  const D = { 'api/said': {} };",
    "  const real = window.fetch;",
    "  window.fetch = function (input) { return Promise.resolve(); };",
    "})();",
    "",
    "const REAL = 1;",
    "</" + "script>",
  ].join("\n");
  const r = stripDemo(fake);
  ok(r.removed === true, "删演示：认出来了");
  ok(!r.text.includes("window.fetch ="), "删演示：拦截器没了");
  ok(!r.text.includes("api/said"), "删演示：假数据没了");
  ok(r.text.includes("const REAL = 1;"), "删演示：后面的真代码留着");
  ok(r.text.includes("<script>"), "删演示：前面的没被多切");
}
{
  const clean = "<script>const a = 1;</" + "script>";
  const r = stripDemo(clean);
  ok(r.removed === false, "删演示：没有演示块时不动手");
  eq(r.text, clean, "删演示：原样返回，一个字节不改");
}
{
  // 只有开头没有结尾 → 必须抛，不许猜着切
  let threw = false;
  try { stripDemo("/* 演示模式 */\nwindow.fetch = function(){}"); } catch { threw = true; }
  ok(threw === true, "删演示：找得到开头找不到结尾时停下，不猜");
}

/* ───── ⑨ 真前端（如果已经拉下来了）───── */
if (fs.existsSync(new URL("./web/index.html", import.meta.url))) {
  const html = fs.readFileSync(new URL("./web/index.html", import.meta.url), "utf8");
  ok(!html.includes("window.fetch ="), "真前端：演示拦截器确实不在了");
  ok(html.includes("function handle(d)"), "真前端：事件处理函数还在");
  ok(html.includes("api/poll?since="), "真前端：长轮询还在");
  ok(html.includes("api/messages?limit="), "真前端：历史回放还在");
  ok(html.includes("api/send"), "真前端：发送还在");
  // 跨服务的契约（规矩 6）：ver 这个字段是前端那边先写好的，本层负责让它真的会变。
  // 前端哪天不看它了，这条会挂——那时本层算指纹就白算了。
  ok(html.includes("d.ver"), "真前端：自动重载读的那个 ver 字段还在");
  ok(html.includes("location.reload()"), "真前端：换版之后会自己重载");
  ok(!html.includes("'api/said':"), "真前端：写死的演示数据没了");
} else {
  console.log("  （跳过真前端检查：还没跑 fetch-frontend.sh）");
}

console.log(fail ? `\n✗ ${pass} 过 / ${fail} 挂` : `\n✓ 全绿：${pass} 项`);
process.exit(fail ? 1 : 0);

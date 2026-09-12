// test-agent.mjs — agent-lib.mjs 的单测。**不起进程、不联网、不写文件**,跑完一秒。
// 跑法:node test-agent.mjs
//
// 覆盖重点按「这条坏了会怎样」排的:
//   ① 计费(API key 没删干净 = 开始按量付费)
//   ② 跨块断行(stdout 被切开 = 掉字或整行丢掉,dwell 踩坑 1 的同款)
//   ③ 那间屋的字段名(role/text/think 一改前端就白屏,dwell 2026-08-16 踩过)

import assert from "node:assert";
import {
  buildAuthEnv, authMode, safeEqual, makeToken,
  makeStreamParser, summarizeInput, makeLedger, makeTurn, gongReply, buildBootPrompt,
} from "./agent-lib.mjs";

let n = 0, bad = 0;
const ok = (name, fn) => {
  n++;
  try { fn(); } catch (e) { bad++; console.log(`✗ ${name}\n   ${e.message}`); }
};

/* ── ① 计费与凭据 ── */

ok("API key 任何时候都删(留着=按量计费)", () => {
  const e = buildAuthEnv({ ANTHROPIC_API_KEY: "sk-x", FOO: "1" });
  assert.strictEqual(e.ANTHROPIC_API_KEY, undefined);
  assert.strictEqual(e.FOO, "1");
});

ok("有长期令牌才摘代理那两个", () => {
  const src = { ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "u" };
  const proxy = buildAuthEnv(src);
  assert.strictEqual(proxy.ANTHROPIC_AUTH_TOKEN, "t", "没令牌时不该摘,不然直接哑掉");
  const direct = buildAuthEnv({ ...src, CLAUDE_CODE_OAUTH_TOKEN: "oat" });
  assert.strictEqual(direct.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.strictEqual(direct.ANTHROPIC_BASE_URL, undefined);
});

ok("空令牌算没设(留空值是常见手滑)", () => {
  assert.strictEqual(authMode({ CLAUDE_CODE_OAUTH_TOKEN: "   " }), "proxy");
  assert.strictEqual(authMode({ CLAUDE_CODE_OAUTH_TOKEN: "oat" }), "direct");
});

ok("buildAuthEnv 不改原对象", () => {
  const src = { ANTHROPIC_API_KEY: "sk" };
  buildAuthEnv(src);
  assert.strictEqual(src.ANTHROPIC_API_KEY, "sk");
});

/* ── ② 口令 ── */

ok("safeEqual 认对不认错", () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abc", "abd"));
  assert.ok(!safeEqual("abc", "abcd"));
  assert.ok(!safeEqual(undefined, ""));
  assert.ok(safeEqual("", ""));
});

ok("盐变了,令牌就变(重启即踢人)", () => {
  assert.notStrictEqual(makeToken("p", "s1"), makeToken("p", "s2"));
  assert.strictEqual(makeToken("p", "s1"), makeToken("p", "s1"));
});

/* ── ③ stream-json 解析 ── */

const line = (o) => JSON.stringify(o) + "\n";

ok("正文与思考增量分得开", () => {
  const p = makeStreamParser();
  const evs = p.push(
    line({ type: "stream_event", event: { delta: { type: "text_delta", text: "你好" } } }) +
    line({ type: "stream_event", event: { delta: { type: "thinking_delta", thinking: "想想" } } })
  );
  assert.deepStrictEqual(evs.map((e) => e.kind), ["text", "think"]);
  assert.strictEqual(evs[0].text, "你好");
  assert.strictEqual(evs[1].text, "想想");
});

ok("⚠️ 一行被切成两半也不掉字(dwell 踩坑 1 同款)", () => {
  const p = makeStreamParser();
  const whole = line({ type: "stream_event", event: { delta: { type: "text_delta", text: "完整的一句话" } } });
  const cut = Math.floor(whole.length / 2);
  assert.deepStrictEqual(p.push(whole.slice(0, cut)), [], "前半段不该产出任何事件");
  const evs = p.push(whole.slice(cut));
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].text, "完整的一句话");
});

ok("看不懂的行丢掉,不抛异常(CLI 升级会多吐新类型)", () => {
  const p = makeStreamParser();
  assert.deepStrictEqual(p.push("这不是 json\n{坏了\n"), []);
  assert.deepStrictEqual(p.push(line({ type: "系统没见过的新类型" })), []);
});

ok("工具调用与回来都认得出", () => {
  const p = makeStreamParser();
  const a = p.push(line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git status" } }] } }));
  assert.deepStrictEqual(a[0], { kind: "tool", name: "Bash", input: "git status" });
  const b = p.push(line({ type: "user", message: { content: [{ type: "tool_result", is_error: false }] } }));
  assert.deepStrictEqual(b[0], { kind: "tool_done", ok: true });
});

ok("中断回执认得出(这颗是暂停键的凭据)", () => {
  const p = makeStreamParser();
  const evs = p.push(line({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }));
  assert.strictEqual(evs[0].kind, "interrupted");
});

ok("一轮结束带上花了多少钱", () => {
  const p = makeStreamParser();
  const evs = p.push(line({ type: "result", is_error: false, total_cost_usd: 0.0123, terminal_reason: "ok" }));
  assert.deepStrictEqual(evs[0], { kind: "turn_end", error: false, reason: "ok", costUSD: 0.0123 });
});

ok("init 带出模型名", () => {
  const p = makeStreamParser();
  const evs = p.push(line({ type: "system", subtype: "init", model: "claude-opus-4-6", tools: ["Bash"] }));
  assert.strictEqual(evs[0].kind, "ready");
  assert.strictEqual(evs[0].model, "claude-opus-4-6");
});

ok("flush 把扣住的尾巴吐出来", () => {
  const p = makeStreamParser();
  p.push(line({ type: "result", is_error: false }).trimEnd());   // 没有换行
  const evs = p.flush();
  assert.strictEqual(evs[0].kind, "turn_end");
});

/* ── ④ 工具入参摘要 ── */

ok("入参压成一行,过长截断", () => {
  assert.strictEqual(summarizeInput({ command: "ls  -la\n/tmp" }), "ls -la /tmp");
  assert.strictEqual(summarizeInput({ file_path: "/a/b.md" }), "/a/b.md");
  assert.ok(summarizeInput({ command: "x".repeat(500) }).endsWith("…"));
  assert.ok(summarizeInput({ command: "x".repeat(500) }).length <= 161);
  assert.strictEqual(summarizeInput(null), "");
});

/* ── ⑤ 账本(那间屋的字段名) ── */

ok("⚠️ role 只能是 her/gong,字段名改了前端就白屏", () => {
  const l = makeLedger();
  l.addHer("在吗");
  l.addGong("在", "（想了想）");
  const all = l.all();
  assert.deepStrictEqual(all.map((m) => m.role), ["her", "gong"]);
  assert.strictEqual(all[1].text, "在");
  assert.strictEqual(all[1].think, "（想了想）");
});

ok("账本有上限,不会无限涨", () => {
  const l = makeLedger(3);
  for (let i = 0; i < 10; i++) l.addHer(String(i));
  assert.strictEqual(l.count(), 3);
  assert.strictEqual(l.all()[0].text, "7");
});

ok("clear 清空(收工时用)", () => {
  const l = makeLedger();
  l.addHer("x");
  assert.strictEqual(l.clear(), 1);
  assert.strictEqual(l.count(), 0);
});

/* ── ⑥ 一轮的攒字 ── */

ok("工具行进思考栏,不污染正文", () => {
  const t = makeTurn();
  t.feed({ kind: "text", text: "我去看看" });
  t.feed({ kind: "tool", name: "Bash", input: "curl /health" });
  t.feed({ kind: "text", text: "活着" });
  const s = t.state;
  assert.strictEqual(s.text, "我去看看活着", "工具行不该混进正文");
  assert.ok(s.think.includes("〔🔧 Bash〕 curl /health"));
  assert.strictEqual(s.tools, 1);
});

ok("被叫停会留痕", () => {
  const t = makeTurn();
  t.feed({ kind: "interrupted" });
  assert.ok(t.state.interrupted);
  assert.ok(t.state.think.includes("⏸"));
});

ok("reset 之后重新攒", () => {
  const t = makeTurn();
  t.feed({ kind: "text", text: "旧的" });
  t.reset();
  t.feed({ kind: "text", text: "新的" });
  assert.strictEqual(t.state.text, "新的");
});

/* ── ⑦ 给那间屋的回话 ── */

ok("说完了就如实给正文", () => {
  const r = gongReply({ text: "查完了,活着", think: "", done: true });
  assert.strictEqual(r.reply, "查完了,活着");
  assert.strictEqual(r.done, true);
});

ok("⚠️ 没说完不许假装说完了,还要告诉她怎么叫停", () => {
  const r = gongReply({ text: "我正在读手册", think: "", done: false });
  assert.ok(r.reply.startsWith("我正在读手册"));
  assert.ok(r.reply.includes("还在干活"), "必须如实说还没完");
  assert.ok(r.reply.includes("叫停"), "必须告诉她再发一句就是叫停——这一版没有按钮");
  assert.strictEqual(r.done, false);
});

ok("刚被叫停时给的是另一句话", () => {
  const r = gongReply({ text: "", think: "", done: false, interrupted: true });
  assert.ok(r.reply.includes("已叫停"));
});

ok("一个字都没有也不返回空串(前端会显示「他没说话」)", () => {
  const r = gongReply({ text: "   ", think: "", done: true });
  assert.strictEqual(r.reply, "（他没说话）");
});

/* ── ⑧ 开场白 ── */

ok("开场白 + 这次的活拼在一起", () => {
  const p = buildBootPrompt("先读 START-HERE.md", "看看晏还活着没");
  assert.ok(p.includes("先读 START-HERE.md"));
  assert.ok(p.includes("看看晏还活着没"));
  assert.ok(p.indexOf("START-HERE") < p.indexOf("看看晏"), "开场白必须在前面");
});

ok("boot.md 读不到也不崩(只是少了开场白)", () => {
  const p = buildBootPrompt("", "干活");
  assert.ok(p.includes("干活"));
});

console.log(bad === 0 ? `✅ ${n} 项全绿` : `❌ ${n} 项里 ${bad} 项没过`);
process.exit(bad ? 1 : 0);

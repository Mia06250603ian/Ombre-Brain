// test-think-translate.mjs — 思考翻中文那层的单测,部署前跑一遍:node test-think-translate.mjs
// 全绿输出 "ALL PASS";不碰网络、不碰 claude 进程(翻译函数全是假的)。
import { wrapTranslatingSink, looksChinese, translatePrompt, makeCliTranslator, limitConcurrency } from "./think-translate.mjs";

let n = 0, bad = 0;
function ok(cond, name) { n++; if (!cond) { bad++; console.error("FAIL:", name); } }
function eq(got, want, name) { ok(JSON.stringify(got) === JSON.stringify(want), `${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function recSink() {
  const ev = [];
  return { ev, showsThinking: true, thinking: (t) => ev.push(["think", t]), text: (t) => ev.push(["text", t]), finish: () => ev.push(["finish"]) };
}

// ---- looksChinese ----
ok(looksChinese("我在想她今天是不是累了"), "中文 = 中文");
ok(!looksChinese("I wonder if she is tired today"), "英文 = 不是中文");
ok(looksChinese(""), "空的当中文(不花一次翻译)");
ok(looksChinese("她说 OK 了"), "夹几个英文字母的中文仍算中文");

// ---- 1. 顺序:先想后说,正文等译文 ----
{
  const s = recSink();
  const w = wrapTranslatingSink(s, async (t) => { await sleep(30); return "【译】" + t; });
  w.thinkingRaw("I think "); w.thinkingRaw("she is tired.");
  w.boundary();
  w.text("你今天累不累?");
  w.finish();
  await w.idle;
  eq(s.ev, [["think", "【译】I think she is tired."], ["text", "你今天累不累?"], ["finish"]], "译文先到,正文排在后面");
}

// ---- 2. 并行:三段一起翻,总耗时 ≈ 一段,不是三段 ----
{
  const s = recSink();
  let running = 0, peak = 0;
  const w = wrapTranslatingSink(s, async (t) => { running++; peak = Math.max(peak, running); await sleep(60); running--; return "译" + t; });
  const t0 = Date.now();
  for (const seg of ["A1", "B2", "C3"]) { w.thinkingRaw(seg); w.boundary(); }
  w.text("done"); w.finish();
  await w.idle;
  const took = Date.now() - t0;
  eq(s.ev.map((e) => e[1]), ["译A1", "译B2", "译C3", "done", undefined], "并行翻,但仍按原顺序发");
  ok(peak === 3, `三段同时在翻(峰值并发 ${peak})`);
  ok(took < 150, `总耗时 ${took}ms ≈ 一段(串行会是 180ms+)`);
}

// ---- 3. 翻译失败 / 返回空 → 原样发英文,不丢 ----
{
  const s = recSink();
  const w = wrapTranslatingSink(s, async () => { throw new Error("boom"); });
  w.thinkingRaw("Hello there"); w.boundary(); w.finish();
  await w.idle;
  eq(s.ev, [["think", "Hello there"], ["finish"]], "翻译抛错 → 发原文");
  const s2 = recSink();
  const w2 = wrapTranslatingSink(s2, async () => "   ");
  w2.thinkingRaw("Hi"); w2.boundary(); w2.finish(); await w2.idle;
  eq(s2.ev[0], ["think", "Hi"], "译文为空 → 发原文");
}

// ---- 4. 已是中文不翻 ----
{
  let calls = 0;
  const s = recSink();
  const w = wrapTranslatingSink(s, async (t) => { calls++; return t; });
  w.thinkingRaw("她今天好像有点累"); w.boundary(); w.finish(); await w.idle;
  eq(calls, 0, "中文段不花翻译");
  eq(s.ev[0], ["think", "她今天好像有点累"], "中文原样发");
}

// ---- 5. 工具可见化那几行直通、不翻,且不打乱顺序 ----
{
  let seen = [];
  const s = recSink();
  const w = wrapTranslatingSink(s, async (t) => { seen.push(t); await sleep(20); return "译:" + t; });
  w.thinkingRaw("Let me check memory.");
  w.thinking("\n〔🔧 breath〕\n");            // 工具标记来了 = 先把攒着的那段送去翻
  w.thinking("→ query: 生日\n");
  w.thinking("← 她说过生日想去海边\n");
  w.thinkingRaw("Found it."); w.boundary();
  w.text("记得!"); w.finish();
  await w.idle;
  eq(seen, ["Let me check memory.", "Found it."], "只翻模型的思考,工具那几行一个字都不送去翻");
  eq(s.ev.map((e) => e[1]), ["译:Let me check memory.", "\n〔🔧 breath〕\n", "→ query: 生日\n", "← 她说过生日想去海边\n", "译:Found it.", "记得!", undefined], "工具行夹在两段译文中间,顺序不乱");
}

// ---- 6. 末尾换行保留(下游靠它分段) ----
{
  const s = recSink();
  const w = wrapTranslatingSink(s, async () => "译文");
  w.thinkingRaw("line\n"); w.boundary(); w.finish(); await w.idle;
  eq(s.ev[0], ["think", "译文\n"], "原文以换行结尾,译文也补上");
}

// ---- 7. 下游 sink 自己抛错不连累后面 ----
{
  const ev = [];
  let first = true;
  const s = { showsThinking: true, thinking: (t) => { if (first) { first = false; throw new Error("x"); } ev.push(t); }, text: (t) => ev.push(t), finish: () => ev.push("fin") };
  const w = wrapTranslatingSink(s, async (t) => t);
  w.thinking("a"); w.text("b"); w.finish(); await w.idle;
  eq(ev, ["b", "fin"], "一步坏了,后面照发");
}

// ---- 8. 提示词:称呼代入,不写死别人的名字 ----
{
  const p = translatePrompt({ userName: "小A", aiName: "小B" });
  ok(p.includes("小A") && p.includes("小B"), "称呼代入");
  ok(!p.includes("栖栖"), "没有照抄朋友那版的人名");
  ok(p.includes("不要译成「用户」"), "the user 不译成「用户」");
}

// ---- 9. 翻译子进程:不存在的 CLI → reject(上层会发原文),不炸 ----
{
  const tr = makeCliTranslator({ bin: "/nonexistent/claude", model: "m", env: { PATH: process.env.PATH }, prompt: "p", timeoutMs: 2000 });
  let rejected = false;
  try { await tr("hello"); } catch { rejected = true; }
  ok(rejected, "CLI 不在 → reject,不抛到外面");
}

// ---- 10. 翻译子进程:超时会杀掉并 reject ----
{
  const tr = makeCliTranslator({ bin: "/bin/sleep", model: "5", env: { PATH: process.env.PATH }, prompt: "p", timeoutMs: 300 });
  const t0 = Date.now(); let msg = "";
  try { await tr("x"); } catch (e) { msg = e.message; }
  ok(msg === "timeout" || /exit/.test(msg), `超时/失败会 reject(got ${msg})`);
  ok(Date.now() - t0 < 2000, "不会卡过超时太久");
}

// ---- 11. 并发闸:默认一次只跑一个翻译子进程(每个约 300 MB,整机可用只有 1.2~1.5 GB) ----
{
  let running = 0, peak = 0;
  const slow = async (t) => { running++; peak = Math.max(peak, running); await sleep(30); running--; return "译" + t; };
  const one = limitConcurrency(slow);             // 不传 = 1
  const s = recSink();
  const w = wrapTranslatingSink(s, one);
  for (const seg of ["A", "B", "C"]) { w.thinkingRaw(seg); w.boundary(); }
  w.finish(); await w.idle;
  eq(peak, 1, "默认并发 1:三段排队,同一时刻只有一个翻译进程");
  eq(s.ev.map((e) => e[1]), ["译A", "译B", "译C", undefined], "排队之后顺序照旧");
  running = 0; peak = 0;
  const two = limitConcurrency(slow, 2);
  await Promise.all(["x", "y", "z"].map((t) => two(t)));
  eq(peak, 2, "设 2 就最多两个");
  running = 0; peak = 0;
  const junk = limitConcurrency(slow, "abc");
  await Promise.all(["x", "y"].map((t) => junk(t)));
  eq(peak, 1, "值写错回落 1(别静默变成不限)");
  const failing = limitConcurrency(async () => { throw new Error("x"); });
  let r1 = false, r2 = false;
  await failing().catch(() => { r1 = true; });
  await failing().catch(() => { r2 = true; });
  ok(r1 && r2, "前一个失败不会卡死后面的(名额会还回来)");
}

if (bad) { console.error(`\n${bad}/${n} FAIL`); process.exit(1); }
console.log(`ALL PASS (${n})`);

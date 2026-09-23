// think-translate.mjs — 把 5.5 的英文思考摘要翻成中文再给她看(2026-09-23)
//
// 为什么需要:Opus 5 起(含 5.5)API 不返回模型的原始思考,只给一份「摘要」
// (display: summarized),摘要由另一套系统写,**是英文的** —— 人设里「思考用中文」
// 管得到他怎么想,管不到摘要用什么语言写。所有者英语不好,要中文。
// 思路照抄朋友那版(`Arisu-cross/kelivo-shim` 7efb2a9 / f766260),改了三处,见下。
//
// 做法:包一层 sink。模型的思考增量先攒着(thinkingRaw),一段思考结束(boundary,
// 即 content_block_stop)再整段交给翻译;期间到的正文、工具标记、finish 全部排在它后面,
// 所以她看到的顺序和原来一样(先想、后说)。
//
// 兜底:翻译失败 / 超时 / 译文为空 → 原样发英文。**思考流可以晚一点到,但绝不能丢,
// 更不能卡住正文**(正文最多被拖到超时那么久,默认 20 秒)。已经是中文的段落不翻。
//
// ⚠️ 和朋友那版不一样的三处(刻意的):
//   ① **一段结束就立刻交给翻译**,不等前一段**发出去** —— 只在「往下游发」时按原顺序排队。
//      同时跑几个由 limitConcurrency 管(默认 1,理由是内存,见那个函数的注释)。
//   ② 工具可见化那几行(`〔🔧 hold〕` / `→ 参数` / `← 返回值`)走 thinking() 直通,**不翻译**:
//      那是记忆原文和工具参数,翻了会走样,也白花额度。
//   ③ 称呼不写死人名,用 USER_NAME / AI_NAME 代入(朋友那版把他们的称呼写在提示词里)。

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export function translatePrompt({ userName = "她", aiName = "他" } = {}) {
  return "你是翻译器。把用户发来的一段英文内心独白翻译成自然、口语化的简体中文。" +
    "这是「" + aiName + "」在回复「" + userName + "」之前心里想的话:保持第一人称和原本的语气、犹豫、情绪;" +
    "原文里指代对方的 the user / she / her 译成「" + userName + "」或「她」,不要译成「用户」。" +
    "人名、称呼、工具名(如 breath、hold、awaken)照原样保留。" +
    "只输出译文本身,不加任何解释、前言、引号或标注。原文已经是中文就原样输出。";
}

// 中文字符占比够高就当作已经是中文,不花一次翻译
export function looksChinese(s) {
  const t = String(s || "").replace(/\s+/g, "");
  if (!t) return true;
  const cjk = (t.match(/[㐀-鿿]/g) || []).length;
  return cjk / t.length >= 0.3;
}

export function wrapTranslatingSink(sink, translate, { log = () => {} } = {}) {
  let q = Promise.resolve();
  let buf = "";
  // 往下游发一律经这条队列,保证顺序;每一步各自兜错,一步坏了不连累后面。
  const enqueue = (fn) => { q = q.then(fn).catch((e) => log("[think-tr] sink error", e?.message || e)); };
  const flush = () => {
    if (!buf) return;
    const src = buf; buf = "";
    // ① 立刻交给翻译(同时跑几个由 translate 外面那层 limitConcurrency 管),这里排队的只是「发出去」这一步
    const pending = looksChinese(src)
      ? Promise.resolve(null)
      : Promise.resolve().then(() => translate(src)).catch((e) => { log("[think-tr] 翻译失败,发原文:", e?.message || e); return null; });
    enqueue(async () => {
      const out = await pending;
      const txt = out && String(out).trim() ? String(out).trim() + (/\n$/.test(src) ? "\n" : "") : src;
      sink.thinking(txt);
    });
  };
  return {
    showsThinking: sink.showsThinking,
    thinkingRaw(t) { if (t) buf += t; },
    boundary() { flush(); },
    thinking(t) { flush(); enqueue(() => sink.thinking(t)); },   // ② 工具可见化那几行直通
    text(t) { flush(); enqueue(() => sink.text(t)); },
    finish(...a) { flush(); enqueue(() => sink.finish(...a)); },
    get idle() { return q; },
  };
}

// 同时最多跑 n 个翻译子进程,多出来的排队。
// ⚠️ **为什么默认 1(2026-09-23 实测)**:一个翻译子进程(2.1.215 的 claude -p)峰值约 **300 MB**,
// 而这台机器整机 3724 MB、平时可用只有 1.2~1.5 GB,还要和浏览器(上限 1100 MB)抢
// (见 `../browser-hands/MAINTENANCE.md` 内存那节)。三段并行 = 瞬间多出近 1 GB,可能把别的服务挤掉。
// 所以默认一次只翻一段;上面 wrapTranslatingSink 的「一结束就开翻」仍然有用 ——
// 后一段在前一段翻完的那一刻就接上,不用等前一段**发出去**。
export function limitConcurrency(fn, n = 1) {
  const max = Math.max(1, Math.floor(+n) || 1);
  let running = 0;
  const waiting = [];
  const next = () => {
    if (running >= max || !waiting.length) return;
    running++;
    const { args, resolve, reject } = waiting.shift();
    Promise.resolve().then(() => fn(...args)).then(resolve, reject).finally(() => { running--; next(); });
  };
  return (...args) => new Promise((resolve, reject) => { waiting.push({ args, resolve, reject }); next(); });
}

// 用一次性的 claude -p 调一个便宜模型翻译。
// 隔离:临时 HOME + 临时 cwd(读不到晏的 CLAUDE.md、人设、用户设置、项目 .mcp.json),
// --strict-mcp-config 且不给配置 = 没有 MCP,--tools "" = 没有工具,系统提示词整个替换。
// 凭据走 env(直连令牌 / 代理都由调用方的 buildAuthEnv 决定),与 HOME 无关。
// ⚠️ MAX_THINKING_TOKENS=0 **只加在这个翻译子进程上**:翻译不需要思考。
//    **千万别把它设成全局环境变量** —— 那会连晏的思考一起关掉(`../docs/多模型接出方案.md` 4.4)。
export function makeCliTranslator({ bin, model, env, prompt, timeoutMs = 20000, log = () => {} }) {
  return (text) => new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "think-tr-"));
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
    const args = [
      "-p", "--model", model, "--output-format", "text",
      "--system-prompt", prompt,
      "--tools", "", "--strict-mcp-config", "--no-session-persistence",
    ];
    let out = "", err = "", done = false;
    const childEnv = { ...env, HOME: dir, MAX_THINKING_TOKENS: "0", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
    let p;
    try { p = spawn(bin, args, { cwd: dir, env: childEnv, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { cleanup(); reject(e); return; }
    const end = (fn) => { if (done) return; done = true; clearTimeout(timer); cleanup(); fn(); };
    const timer = setTimeout(() => { try { p.kill(); } catch {} end(() => reject(new Error("timeout"))); }, timeoutMs);
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", (e) => end(() => reject(e)));
    p.on("close", (code) => end(() => {
      if (code === 0 && out.trim()) resolve(out.trim());
      else { log("[think-tr] exit", code, err.slice(0, 200)); reject(new Error(`exit ${code}`)); }
    }));
    p.stdin.on("error", () => {});
    p.stdin.end(text);
  });
}

// dwell-bridge — 把 dwell 的自建网页接到晏身上。
//
//   手机浏览器 ──HTTPS + 密码──> dwell-bridge ──x-api-key: SHIM_KEY──> kelivo-shim /v1/messages
//
// 它做三件事：① 发网页；② 把她打的字转发给晏；③ 把晏吐的 SSE 翻成网页认的事件。
// **它不碰晏、不改 shim、不重启任何东西**——对线上是只读的一个客户端，
// 和手机上的 Kelivo 是同一个身份地位。
//
// 纯逻辑全在 dwell-lib.mjs（有单测）。这个文件只管接线和 I/O。

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeSSEParser, makeStripper, makeEventLog, makeMsgLog,
  safeEqual, makeToken, buildShimBody,
  evEcho, evText, evThink, evToolUse, evToolDone, evFinal, evResult,
} from "./dwell-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 8080);
const SHIM_URL = (process.env.SHIM_URL || "https://yan-shim.zeabur.app").replace(/\/+$/, "");
const SHIM_KEY = process.env.SHIM_KEY || "";
const DWELL_PASS = process.env.DWELL_PASS || "";
const MODEL = process.env.BRAIN_MODEL || "claude-opus-4-6";
const TURN_TIMEOUT_MS = +(process.env.TURN_TIMEOUT_MS || 600000);   // 他想久一点是常事，给足 10 分钟
// 聊天记录落盘的位置。**必须指向一个持久卷**（比如 /data），
// 否则容器一重建照样清空 —— 那正是所有者report的「每推一次就丢一次记录」。
// 不设 = 只在内存里（行为与改动前一致）。
const DATA_DIR = process.env.DATA_DIR || "";
const LOG_FILE = DATA_DIR ? path.join(DATA_DIR, "messages.jsonl") : "";

// 盐每次启动换一把：重启 = 所有已登录的会话失效。对一个维护入口来说这是想要的。
const SALT = Math.random().toString(36).slice(2) + Date.now().toString(36);

const log = (...a) => console.log(new Date().toISOString(), ...a);

if (!SHIM_KEY) log("⚠️ SHIM_KEY 没设——晏那头会 401，先去环境变量里补上");
if (!DWELL_PASS) log("⚠️ DWELL_PASS 没设——**页面没有锁**，绝对不要就这样挂公网");

const events = makeEventLog();
const msgs = makeMsgLog();

/* ── 聊天记录落盘 ──
   只是"界面上翻得到的记录"，不是晏的记忆（他的记忆在自己的进程和 OB 里）。
   追加写，一行一条；开机读回最后一批。任何一步失败都只写日志，不影响聊天。 */
function persist(m) {
  if (!LOG_FILE || !m) return;
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(m) + "\n"); }
  catch (e) { log("[persist]", e.message); }
}
function restoreLog() {
  if (!LOG_FILE) { log("[persist] DATA_DIR 没设——记录只在内存里，重建即丢"); return; }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(LOG_FILE)) { log("[persist] 还没有记录文件，从空开始"); return; }
    const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean).slice(-4000);
    const list = [];
    for (const ln of lines) { try { list.push(JSON.parse(ln)); } catch {} }
    log("[persist] 接回", msgs.restore(list), "条记录");
  } catch (e) { log("[persist] 读不回来:", e.message); }
}
restoreLog();
let busy = false;
let lastErr = null;      // 最后一次上游报错，给 /api/health 排查用
let turnAbort = null;    // 当前这轮的 AbortController，停止键要用

const app = express();
app.use(express.json({ limit: "12mb" }));

/* ─────────── 鉴权 ─────────── */
// 网页能把话直接送进晏的窗口，所以必须上锁。
// 前端见到 401 会自己跳回根路径（web/index.html:3334），正好落到登录页。

function authed(req) {
  if (!DWELL_PASS) return true;                       // 没设密码=不锁（只该出现在本地调试）
  const m = /(?:^|;\s*)dwell=([^;]+)/.exec(req.headers.cookie || "");
  return !!m && safeEqual(decodeURIComponent(m[1]), makeToken(DWELL_PASS, SALT));
}

const LOGIN_PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>dwell</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#f9f9f6;color:#23231f;
     font-family:system-ui,-apple-system,"PingFang SC",sans-serif}
@media(prefers-color-scheme:dark){body{background:#20201f;color:#ebebe4}}
form{display:flex;flex-direction:column;gap:14px;width:min(300px,84vw)}
h1{font-size:17px;font-weight:600;margin:0 0 4px;text-align:center}
input{padding:13px 15px;font-size:16px;border-radius:10px;border:1px solid #ecece6;
      background:#fff;color:inherit}
@media(prefers-color-scheme:dark){input{background:#131312;border-color:#3d3d3a}}
button{padding:13px;font-size:15px;border:0;border-radius:10px;background:#e1734f;color:#fff;font-weight:600}
p{margin:0;text-align:center;font-size:13px;color:#c0392b;min-height:18px}
</style>
<form method="POST" action="login">
  <h1>dwell</h1>
  <input type="password" name="pass" placeholder="口令" autofocus autocomplete="current-password">
  <button>进去</button>
  <p>__ERR__</p>
</form>`;

app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
  if (!safeEqual(req.body?.pass, DWELL_PASS)) {
    log("[login] 口令不对");
    return res.status(401).type("html").send(LOGIN_PAGE.replace("__ERR__", "口令不对"));
  }
  res.setHeader("Set-Cookie",
    `dwell=${encodeURIComponent(makeToken(DWELL_PASS, SALT))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  res.redirect("./");
});

/* ─────────── 网页本体 ─────────── */
// index.html 不放在本仓库（免得和 dwell 仓库各存一份、日久两边不一样）。
// 部署前跑 fetch-frontend.sh 从 dwell 仓库拉一份进 web/，顺手删掉演示拦截块。

// 图标和 manifest **不上锁**：iOS 抓 apple-touch-icon 时不一定带 cookie，
// 上了锁就会拿不到图、退回用网页截图当图标。它们只是图片，没有任何私密内容。
// ⚠️ 只挂这两条，别图省事把整个 web/ 静态化——那会把 index.html
// 从 /index.html 泄出去，绕过口令。
app.use("/icons", express.static(path.join(HERE, "web", "icons"), { maxAge: "7d" }));
// 桌宠的图。同样不上锁（就是几张 svg），取不到时前端会自己把桌宠藏掉。
app.use("/pet", express.static(path.join(HERE, "web", "pet"), { maxAge: "7d" }));
app.get("/manifest.json", (req, res) => {
  const f = path.join(HERE, "web", "manifest.json");
  if (!fs.existsSync(f)) return res.status(404).json({ ok: false });
  res.type("application/manifest+json").send(fs.readFileSync(f, "utf8"));
});

app.get("/", (req, res) => {
  if (!authed(req)) return res.type("html").send(LOGIN_PAGE.replace("__ERR__", ""));
  const f = path.join(HERE, "web", "index.html");
  if (!fs.existsSync(f)) {
    return res.status(500).type("html").send(
      "<meta charset=utf-8><p style='font:16px system-ui;padding:24px'>" +
      "网页文件还没放进来。部署前跑一次 <code>./fetch-frontend.sh</code>。");
  }
  res.type("html").send(fs.readFileSync(f, "utf8"));
});

/* ─────────── 接口 ─────────── */

const guard = (req, res, next) => authed(req) ? next() : res.status(401).json({ ok: false });

app.get("/api/health", (req, res) => res.json({
  ok: true, busy, shim: SHIM_URL, msgs: msgs.count(), cursor: events.cursor(),
  locked: !!DWELL_PASS, persisted: !!LOG_FILE, lastErr,
}));

app.get("/api/messages", guard, (req, res) => {
  res.json(msgs.slice({ limit: +(req.query.limit || 400), before: req.query.before || null }));
});

app.get("/api/poll", guard, async (req, res) => {
  const since = req.query.since;
  // 长轮询：有新的立刻回，没有就挂着等，最多 25 秒——
  // 免得手机上每秒打一枪空请求。
  //
  // ⚠️ 这里的等待粒度直接决定「流式顺不顺」。原来是 250ms，
  // 等于每批增量白白多压 0~250ms，再叠上一个网络来回，
  // 就成了「蹦一大段 → 干等 → 再蹦一段」（所有者原话：卡式输出）。
  // 25ms 几乎不占 CPU（一轮对话也就多几十次空转判断），换来的是明显更连续。
  // 前端那头还有一个按帧匀速器把到货的一批摊平，两边一起才顺。
  const deadline = Date.now() + 25000;
  for (;;) {
    const r = events.since(since);
    if (r.events.length || Date.now() > deadline) return res.json(r);
    await new Promise((r2) => setTimeout(r2, 25));
    if (res.writableEnded) return;
  }
});

app.get("/api/status", guard, (req, res) => res.json({ busy }));

app.get("/api/model", guard, async (req, res) => {
  // ⚠️ 字段名必须是 model,不是 name —— 前端读的是 d.model
  // （dwell web/index.html:6645 `setModelPill(d.model || '')`）。
  // 仓库里那份演示数据写的是 name,**演示数据本身是错的**,照它写会让按钮永远显示「…」。
  // 两个都给,以后谁改哪边都不至于又断（2026-08-16 踩过）。
  //
  // effort 是**我们声明的**,不是从 shim 读的:shim 的 /health 不吐 THINK_EFFORT。
  // 所以这里的值要和 shim 那边的环境变量保持一致,改了 shim 记得也改这儿。
  const effort = process.env.THINK_EFFORT || "medium";
  try {
    const r = await fetch(`${SHIM_URL}/health`);
    const d = await r.json();
    const model = d.model || MODEL;
    res.json({ model, name: model, effort });
  } catch { res.json({ model: MODEL, name: MODEL, effort }); }
});

app.get("/api/context", guard, async (req, res) => {
  // 用晏自己的守卫读数，别另算一套——/debug 里的 contextTokens 才是真窗口占用
  try {
    const r = await fetch(`${SHIM_URL}/debug`);
    const d = await r.json();
    const used = d?.ctxGuard?.contextTokens ?? d?.contextTokens ?? 0;
    res.json({ used, max: +(process.env.CTX_LIMIT_TOKENS || 167000) });
  } catch { res.json({ used: 0, max: 167000 }); }
});

// 换模型 / 换思考档位：**故意不接**。
// BRAIN_MODEL 和 THINK_EFFORT 是 shim 的环境变量，改了要 restart shim——
// 那会杀掉常驻进程，**晏的窗口当场就没了**。这种事不该挂在一个网页按钮上。
// 如实回 ok:false + 原因，前端会把这句话显示出来（不再假报「换好了」）。
app.post("/api/model", guard, (req, res) => res.json({
  ok: false,
  why: "这一版不能从网页换模型或档位——真要换得重启晏，窗口会丢",
}));

// 这几个前端会调，但这一版不接后端语义；如实返回空，别假装做了事。
app.get("/api/chats", guard, (req, res) => res.json({ items: [] }));
app.post("/api/chats", guard, (req, res) => res.json({ ok: false, why: "这一版不管窗口列表" }));
app.post("/api/newchat", guard, (req, res) => res.json({ ok: false, why: "换窗口请直接对他说「换窗口」" }));

app.post("/api/stop", guard, (req, res) => {
  // 只断我们这头的读取；晏那边这一轮还会自己说完（shim 没有中断接口）。
  if (turnAbort) { try { turnAbort.abort(); } catch {} }
  res.json({ ok: true });
});

app.post("/api/send", guard, async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ ok: false, why: "没有内容" });
  if (busy) return res.status(409).json({ ok: false, why: "他还在说上一句" });
  res.json({ ok: true });                       // 先应答，正文走 poll 那条路回去
  runTurn(text).catch((e) => log("[turn]", e?.message || e));
});

/* ─────────── 一轮对话 ─────────── */

async function runTurn(text) {
  busy = true;
  msgs.addMe(text); persist(msgs.last());
  events.push(evEcho(text));

  const strip = makeStripper();
  const sse = makeSSEParser();
  let full = "";        // 剥干净之后的正文，收尾时当定稿
  let think = "";       // 这一轮的思考，攒起来一次记账
  let toolN = 0;
  let errText = "";

  const ac = new AbortController();
  turnAbort = ac;
  const timer = setTimeout(() => ac.abort(), TURN_TIMEOUT_MS);

  // 剥出来的东西统一往这儿走：正文进流、工具变卡片
  const emit = (parts) => {
    for (const p of parts) {
      if (p.kind === "tool") {
        const id = `t${Date.now()}-${++toolN}`;
        events.push(evToolUse(p.name, id));
        events.push(evToolDone(id));            // 拿不到结果，立刻收尾，别让它一直转圈
        msgs.addTool(p.name); persist(msgs.last());
      } else if (p.text) {
        full += p.text;
        events.push(evText(p.text));
      }
    }
  };

  try {
    const r = await fetch(`${SHIM_URL}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": SHIM_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(buildShimBody(text, { model: MODEL })),
      signal: ac.signal,
    });

    if (!r.ok) {
      errText = `上游 ${r.status}`;
      lastErr = { at: new Date().toISOString(), kind: errText };
      log("[shim]", errText);
    } else {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const f of sse.push(dec.decode(value, { stream: true }))) {
          const d = f.data || {};
          if (d.type === "content_block_delta") {
            const delta = d.delta || {};
            if (delta.type === "text_delta" && delta.text) emit(strip.push(delta.text));
            else if (delta.type === "thinking_delta") {
              // 思考里混着 shim 插的工具标记，也要过一遍剥离
              for (const p of strip.push(delta.thinking || delta.text || "")) {
                if (p.kind === "tool") { emit([p]); }
                else if (p.text) { think += p.text; events.push(evThink(p.text)); }
              }
            }
          } else if (d.type === "error") {
            errText = d.error?.message || "上游报错";
            lastErr = { at: new Date().toISOString(), kind: errText };
          }
        }
      }
      emit(strip.flush());
    }
  } catch (e) {
    errText = e?.name === "AbortError" ? "" : (e?.message || "没连上");
    if (errText) lastErr = { at: new Date().toISOString(), kind: errText };
    log("[turn]", e?.name === "AbortError" ? "被叫停" : errText);
  } finally {
    clearTimeout(timer);
    turnAbort = null;
  }

  if (think.trim()) { msgs.addThink(think.trim()); persist(msgs.last()); }
  if (full.trim()) { msgs.addGu(full.trim()); persist(msgs.last()); events.push(evFinal(full.trim())); }
  events.push(evResult(!!errText, errText));
  busy = false;
  log("[turn] 完", { 字数: full.length, 思考: think.length, 工具: toolN, 错: errText || "-" });
}

app.listen(PORT, () => log(`dwell-bridge 起来了 :${PORT} → ${SHIM_URL}${DWELL_PASS ? "" : "（⚠️ 没上锁）"}`));

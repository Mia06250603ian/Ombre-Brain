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
  safeEqual, makeToken, buildShimBody, parseLog, verFrom, memFrom,
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
/* 网页上往回翻得到多少条。**这个数同时决定内存占用**——
   记录要能翻就得在内存里,所以它不是「盘够不够」的问题,是「机器内存够不够」的问题
   (那台机器七八个服务共用,2026-08-02 出过 OOM,见 `../TIMELINE.md` 08-02)。
   一条 ≈ 她一句 / 他一句 / 一段思考 / 一个工具名;一轮对话通常 3~4 条。
   **改值 + restart 即生效,不用重新部署**;嫌占内存就调小,想翻更久就调大。 */
const MSG_CAP = Math.max(100, +(process.env.MSG_CAP || 4000));
const DATA_DIR = process.env.DATA_DIR || "";
// ⚠️ 开机发现写不进去(路径填错、卷没挂上、只读)就**把它降回空**,
// 这样 /api/health 的 `persisted` 会如实说 false。
// 别让它一直报 true —— 那会让人以为记录存着了,其实每条都在悄悄写失败。
let LOG_FILE = DATA_DIR ? path.join(DATA_DIR, "messages.jsonl") : "";

// 盐每次启动换一把：重启 = 所有已登录的会话失效。对一个维护入口来说这是想要的。
const SALT = Math.random().toString(36).slice(2) + Date.now().toString(36);

const log = (...a) => console.log(new Date().toISOString(), ...a);

if (!SHIM_KEY) log("⚠️ SHIM_KEY 没设——晏那头会 401，先去环境变量里补上");
if (!DWELL_PASS) log("⚠️ DWELL_PASS 没设——**页面没有锁**，绝对不要就这样挂公网");

/* ── 这一版的指纹 ──
   发给前端的每个 poll 回复都带着它；她那页发现值变了就自己重载
   （`web/index.html` 的 `tryReload()`：输入框有草稿、或正在往上翻老账时会先挂起，不会打断她）。
   **算的是发出去的那三个文件**：网页本体 + 本层的两个源文件。
   拿不到网页文件（还没跑 fetch-frontend.sh）也不要紧，剩下两个照样算得出值。 */
const VER = verFrom(...["web/index.html", "server.js", "dwell-lib.mjs"].map((f) => {
  try { return fs.readFileSync(path.join(HERE, f), "utf8"); } catch { return `missing:${f}`; }
}));

const events = makeEventLog({ ver: VER });
const msgs = makeMsgLog({ cap: MSG_CAP });

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
    fs.accessSync(DATA_DIR, fs.constants.W_OK);      // 写不进去的话下面这行就抛，走 catch 关掉落盘
    if (!fs.existsSync(LOG_FILE)) { log("[persist] 还没有记录文件，从空开始"); return; }
    const r = parseLog(fs.readFileSync(LOG_FILE, "utf8"), { cap: MSG_CAP });
    log("[persist] 接回", msgs.restore(r.list), "条记录（文件里共", r.total, "行）");
    /* 轮转：只在开机时做一次。先写临时文件再改名，中途断电也不会留下半截的账本
       （最坏情况是临时文件残着，下次开机原样覆盖）。失败只记日志——
       账本已经接回内存了，聊天不该因为整理文件而受影响。 */
    if (r.rotate) {
      try {
        const tmp = LOG_FILE + ".tmp";
        fs.writeFileSync(tmp, r.tail.join("\n") + "\n");
        fs.renameSync(tmp, LOG_FILE);
        log("[persist] 记录文件已轮转:", r.total, "→", r.tail.length, "行");
      } catch (e) { log("[persist] 轮转失败（不影响聊天）:", e.message); }
    }
  } catch (e) {
    LOG_FILE = "";
    log("⚠️ [persist] 这个目录用不了，落盘已关闭（记录会像以前一样重建即丢）:", DATA_DIR, e.message);
    log("⚠️ [persist] 多半是卷没挂上或路径填错了。/api/health 的 persisted 会如实报 false");
  }
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

/* 内存读数。每次问的时候现读(两个小文件,几十微秒),别缓存——缓存了就看不出涨没涨。
   读不到就给 null,绝不让观察口把接口拖垮。 */
function readMem() {
  const pick = (...paths) => {
    for (const p of paths) { try { return fs.readFileSync(p, "utf8"); } catch {} }
    return "";
  };
  return memFrom({
    cgroup: pick("/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"),
    meminfo: pick("/proc/meminfo"),
  });
}

app.get("/api/health", (req, res) => res.json({
  ok: true, busy, shim: SHIM_URL, msgs: msgs.count(), cursor: events.cursor(),
  locked: !!DWELL_PASS, persisted: !!LOG_FILE, cap: MSG_CAP, mem: readMem(),
  agent: !!AGENT_URL, ver: VER, lastErr,
}));

app.get("/api/messages", guard, (req, res) => {
  const page = msgs.slice({ limit: +(req.query.limit || 400), before: req.query.before || null });
  /* ⚠️ `upto` 必须是**事件游标**，不是消息序号。
     前端读完历史就拿它当起点接着收实时事件
     （dwell `web/index.html`：`loadSaid()` 返回 upto → `cursor = upto` → `api/poll?since=cursor`）。
     本层的账本和事件队列是两套独立编号：一轮对话可能只产生 2 条消息，
     却有几十个事件。把消息序号当游标交出去，游标会**倒退**，
     于是刚画完的那一轮事件被整段重放，屏幕上就出现重复的对话
     ——2026-08-16 所有者报的「记录重复好几轮」，第二个来源就是这里
     （第一个是 dwell 自己的 loadSaid 不清场，已在前端修）。 */
  res.json({ ...page, upto: events.cursor() });
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

/* ─────────── 「另一个 AI 的房间」→ 维护 agent ───────────
   前端那间屋(`web/index.html` 的 gongSheet)调的是 `api/gong` 两条。
   本层**只做转发**:加一把 agent-bridge 的钥匙,把请求原样递过去。
   ⚠️ **故意不在这儿做任何解释/改写** —— 那一层的契约由 `../agent-bridge/` 说了算,
   两边各存一份语义迟早会歪(规矩 6:跨服务两边留指路)。
   ⚠️ **AGENT_URL 不设 = 整条路关着**,如实回 ok:false,前端会显示「他那边没应声」。
   那也是急救开关:想让那间屋立刻闭嘴,删掉这个变量 + restart 即可,不用部署。 */
const AGENT_URL = (process.env.AGENT_URL || "").replace(/\/+$/, "");
const AGENT_KEY = process.env.AGENT_KEY || "";

async function toAgent(method, body) {
  if (!AGENT_URL) return { ok: false, status: 503, data: { msgs: [], reply: "（维护 agent 还没接上来）" } };
  const r = await fetch(`${AGENT_URL}/api/gong`, {
    method,
    headers: { "Content-Type": "application/json", "x-agent-key": AGENT_KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
    // 那边一次最多挂 GONG_WAIT_MS(默认 50 秒),这里留足余量
    signal: AbortSignal.timeout(+(process.env.AGENT_TIMEOUT_MS || 120000)),
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

app.get("/api/gong", guard, async (req, res) => {
  try {
    const r = await toAgent("GET");
    res.status(r.ok ? 200 : r.status).json(r.data);
  } catch (e) {
    log("[gong]", e.message);
    res.json({ msgs: [] });                       // 前端拿不到就显示「他那边没应声」
  }
});

app.post("/api/gong", guard, async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ reply: "（没有内容）" });
  try {
    const r = await toAgent("POST", { text });
    res.status(r.ok ? 200 : r.status).json(r.data);
  } catch (e) {
    log("[gong]", e.message);
    lastErr = { at: new Date().toISOString(), kind: `agent: ${e.message}` };
    res.json({ reply: "（没送到,再试一次）" });
  }
});

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
      body: JSON.stringify(buildShimBody(text)),
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

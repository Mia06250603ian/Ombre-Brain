// kelivo-shim — Anthropic /v1/messages -> 常驻 claude -p (stream-json)
import express from "express";
import { spawn } from "child_process";
import { randomUUID } from "crypto";

const PORT = process.env.PORT || 8080;
const SHIM_KEY = process.env.SHIM_KEY || "";            // Kelivo 要填的 API Key,自己编
const MODEL = process.env.BRAIN_MODEL || "claude-opus-4-6";
const EFFORT = process.env.THINK_EFFORT || "low";        // low省额度 / medium思考更长
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const MCP_CONFIG = process.env.MCP_CONFIG || ".mcp.json";
const FORWARD_THINKING = process.env.FORWARD_THINKING !== "0";
const USER_NAME = process.env.USER_NAME || "你";          // 你的称呼
const AI_NAME = process.env.AI_NAME || "TA";             // AI 的名字

const HARD_RULE =
  `【最高优先级·思考语言】thinking/内心独白必须全程用简体中文,第一人称「我」,把${USER_NAME}称作「你」;严禁英文、第三人称分析腔。`;

// --tools 只装真用的内置工具(Bash/Edit等大schema全砍,每轮token基线立减一半)
// MCP 工具不受 --tools 影响,走 mcp-config 照常加载
const BUILTIN_TOOLS = process.env.BUILTIN_TOOLS ?? "WebSearch,WebFetch";
const ALLOWED = process.env.ALLOWED_TOOLS || "WebSearch,WebFetch";

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- 常驻 claude 进程 ----
// HTTP MCP(记忆库)握手要几秒;新进程的第一条消息延迟到握手完成后再写入,
// 否则第一窗口拿不到 mcp__ 工具(实测坑)
const MCP_WARMUP_MS = +(process.env.MCP_WARMUP_MS || 10000);
let procReadyAt = 0;
let proc = null, outBuf = "", busy = false, spawnedSystem = "";
const queue = [];
let turn = null;
let lastUsage = null;

function spawnClaude(kelivoSystem) {
  spawnedSystem = kelivoSystem || "";
  const append = spawnedSystem ? `${HARD_RULE}\n\n【场景设定/世界书】\n${spawnedSystem}` : HARD_RULE;
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", MODEL,
    "--effort", EFFORT,
    "--thinking-display", "summarized",   // 隐藏flag:没它 -p 下拿不到思考
    "--append-system-prompt", append,
    "--mcp-config", MCP_CONFIG,
    "--strict-mcp-config",
    "--permission-mode", "dontAsk",
    "--allowedTools", ALLOWED,
    "--tools", BUILTIN_TOOLS,
  ];
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;  // 必须删:API key 存在会无条件压过订阅登录
  const p = spawn(CLAUDE_BIN, args, { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
  p.stdout.on("data", onStdout);
  p.stderr.on("data", (d) => log("[claude]", d.toString().slice(0, 300)));
  p.on("close", (code) => {
    log("[claude] exited", code);
    if (proc !== p) return; // 被 pump/世界书切换主动换掉的旧进程,不许动新回合的现场
    proc = null; busy = false;
    if (turn && !turn.done) { try { turn.sse?.finish(); } catch {} turn = null; }
    setTimeout(() => ensureProc(spawnedSystem), 1500); // 复活时带上原世界书,否则下一条消息必触发杀进程重开
  });
  procReadyAt = Date.now() + MCP_WARMUP_MS;
  log("[claude] spawned", MODEL, "sysLen", spawnedSystem.length);
  return p;
}
function ensureProc(sys) { if (!proc) proc = spawnClaude(sys); }

function onStdout(chunk) {
  outBuf += chunk.toString();
  const lines = outBuf.split("\n");
  outBuf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    handleEvent(ev);
  }
}

function handleEvent(ev) {
  if (!turn) return;
  if (ev.type === "stream_event") {
    const e = ev.event || {}, d = e.delta || {};
    if (e.type === "content_block_start") {
      // MCP 工具调用可见化:思考里插一行标记
      const cb = e.content_block || {};
      if (cb.type === "tool_use" && typeof cb.name === "string" && cb.name.startsWith("mcp__")) {
        turn.sse?.thinking(`\n〔🔧 ${cb.name.replace(/^mcp__/, "")}〕\n`);
      }
    }
    if (e.type === "content_block_delta") {
      if (d.type === "text_delta" && d.text) { turn.fullText += d.text; turn.sse?.text(d.text); }
      else if (d.type === "thinking_delta") { turn.sse?.thinking(d.thinking || d.text || ""); }
    }
    return;
  }
  if (ev.type === "result") {
    lastUsage = ev.usage || null;
    if (ev.subtype && ev.subtype !== "success") {
      log("[result-error]", ev.subtype);
      if (!turn.fullText) turn.sse?.text(`⚠️[shim] ${ev.subtype}`);
    }
    const usage = ev.usage ? { output_tokens: ev.usage.output_tokens } : undefined;
    const wasNewWindow = turn.newWindow;
    turn.done = true;
    turn.sse?.finish(usage, turn.fullText);
    turn = null; busy = false;
    if (wasNewWindow && proc) { log("[window] restart"); try { proc.kill(); } catch {} proc = null; }
    pump();
  }
}

// ---- 队列 ----
function enqueue(item) { queue.push(item); pump(); }
function pump() {
  if (busy || !queue.length) return;
  const item = queue.shift();
  busy = true;
  if (proc && item.system !== spawnedSystem) { try { proc.kill(); } catch {} proc = null; } // 世界书变了重启生效
  ensureProc(item.system);
  turn = { sse: item.sse, fullText: "", newWindow: !!item.newWindow };
  const content = item.images?.length ? [{ type: "text", text: item.text }, ...item.images] : item.text;
  const p = proc;
  const wait = Math.max(0, procReadyAt - Date.now());
  if (wait > 0) log("[mcp-warmup] delaying first write", wait, "ms");
  setTimeout(() => {
    if (p !== proc || !p.stdin.writable) return;
    p.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  }, wait);
}

// ---- Anthropic SSE 合成(输出侧) ----
function makeSSE(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const msgId = "msg_" + randomUUID().replace(/-/g, "").slice(0, 24);
  let started = false, cur = null, idx = -1;
  function ensureStart() {
    if (started) return; started = true;
    send("message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  }
  function open(kind) {
    if (cur === kind) return; close();
    idx += 1; cur = kind;
    const cb = kind === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
    send("content_block_start", { type: "content_block_start", index: idx, content_block: cb });
  }
  function close() { if (cur === null) return; send("content_block_stop", { type: "content_block_stop", index: idx }); cur = null; }
  return {
    text(t) { ensureStart(); open("text"); send("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: t } }); },
    thinking(t) { if (!FORWARD_THINKING || !t) return; ensureStart(); open("thinking"); send("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "thinking_delta", thinking: t } }); },
    finish(usage) { ensureStart(); close(); send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: usage || { output_tokens: 0 } }); send("message_stop", { type: "message_stop" }); try { res.end(); } catch {} },
  };
}
function makeCollector(res) {  // 非流式
  return { text() {}, thinking() {},
    finish(usage, fullText) {
      res.json({ id: "msg_" + randomUUID().replace(/-/g, "").slice(0, 24), type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text: fullText || "" }], stop_reason: "end_turn", stop_sequence: null, usage: usage || { input_tokens: 0, output_tokens: 0 } });
    } };
}

// ---- 请求解析 ----
function blocksToText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => b.type === "text" ? b.text : "").join("");
  return "";
}
function systemToText(s) {
  if (!s) return "";
  if (typeof s === "string") return s;
  if (Array.isArray(s)) return s.map((b) => b.text || "").join("\n");
  return "";
}
function extractImages(messages) {
  const last = messages[messages.length - 1]; const out = [];
  if (last && Array.isArray(last.content)) for (const b of last.content) if (b.type === "image") out.push(b);
  return out;
}

const app = express();
app.use(express.json({ limit: "12mb" }));
app.get("/health", (_q, r) => r.json({ ok: true, model: MODEL, busy, queued: queue.length }));
app.get("/debug", (_q, r) => r.json({ lastUsage }));

// Kelivo「模型」页拉这个列表,没有它选不了模型
function listModels(_req, res) {
  res.json({ data: [{ type: "model", id: MODEL, display_name: AI_NAME + " (" + MODEL + ")", created_at: new Date().toISOString() }], has_more: false, first_id: MODEL, last_id: MODEL });
}
app.get("/v1/models", listModels);
app.get("/models", listModels);

// ---- 主动心跳(可选,要 Bark) ----
const BARK_KEY = process.env.BARK_KEY || "";
const HB_CHECK_MIN = +(process.env.HB_CHECK_MIN || 10);
const HB_DAY_IDLE_MIN = +(process.env.HB_DAY_IDLE_MIN || 120);
const HB_COOLDOWN_MIN = +(process.env.HB_COOLDOWN_MIN || 180);
const HB_NIGHT_START = +(process.env.HB_NIGHT_START || 23);
const HB_NIGHT_END = +(process.env.HB_NIGHT_END || 8);
let lastUserAt = Date.now(), lastProactiveAt = 0;
function bjHour() { return (new Date().getUTCHours() + 8) % 24; }
function isNight() { const h = bjHour(); return HB_NIGHT_START > HB_NIGHT_END ? (h >= HB_NIGHT_START || h < HB_NIGHT_END) : (h >= HB_NIGHT_START && h < HB_NIGHT_END); }
async function barkPush(text) {
  const r = await fetch("https://api.day.app/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_key: BARK_KEY, title: AI_NAME, body: text.slice(0, 1800) }) });
  log("[bark]", r.status);
}
function heartbeatTick(force) {
  if (!BARK_KEY || busy || queue.length) return;
  const idleMin = (Date.now() - lastUserAt) / 60000;
  if (!force) {
    if (isNight() || idleMin < HB_DAY_IDLE_MIN) return;
    if ((Date.now() - lastProactiveAt) / 60000 < HB_COOLDOWN_MIN) return;
  }
  lastProactiveAt = Date.now();
  const now = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  const sink = { text() {}, thinking() {},
    finish(_u, fullText) {
      const t = (fullText || "").trim();
      if (!t || t.includes("【沉默】")) { log("[hb] silent"); return; }
      barkPush(t).catch((e) => log("[bark-err]", e.message));
    } };
  log("[hb] waking, idle", Math.round(idleMin));
  enqueue({ text: `【系统·心跳】现在北京时间 ${now},对方已约 ${Math.round(idleMin)} 分钟没来消息。你可以主动发一条消息(会弹到对方手机;聊天App里看不到这条,对方回来时你自然接上,别解释机制)。想说就短短说;不想打扰就只回:【沉默】。`, images: [], system: spawnedSystem, sse: sink, newWindow: false });
}
setInterval(heartbeatTick, HB_CHECK_MIN * 60000);
app.post("/hb", (req, res) => {  // 手动触发测试口
  if (SHIM_KEY && (req.query.key || req.get("x-api-key")) !== SHIM_KEY) return res.status(401).json({ ok: false });
  heartbeatTick(true); res.json({ ok: true });
});

// ---- 健康数据中转(可选,配 iOS 快捷指令) ----
const AW_KEY = process.env.AW_KEY || SHIM_KEY;
let awData = [];
function awAuth(req) { const k = req.query.key || req.get("x-api-key") || ""; return !AW_KEY || k === AW_KEY; }
app.post("/aw", (req, res) => {
  if (!awAuth(req)) return res.status(401).json({ ok: false });
  awData.push({ t: new Date().toISOString(), data: req.body });
  const cut = Date.now() - 48 * 3600e3;
  awData = awData.filter((x) => new Date(x.t).getTime() > cut).slice(-300);
  res.json({ ok: true, count: awData.length });
});
app.get("/aw", (req, res) => {
  if (!awAuth(req)) return res.status(401).json({ ok: false });
  const cleaned = awData.map((x) => { const d = {}; for (const [k, v] of Object.entries(x.data || {})) { const s = v == null ? "" : String(v).trim(); if (s) d[k] = s; } return { t: x.t, data: d }; }).filter((x) => Object.keys(x.data).length > 0);
  res.json({ now: new Date().toISOString(), count: cleaned.length, entries: cleaned.slice(-12) });
});

// ---- Kelivo 后台注入拦截 ----
// Kelivo 的「自动生成对话标题」会往 /v1/messages 发固定英文模板
// ("I will give you some dialogue content in the <content> block...")。
// 不拦的话它会以"佳佳的消息"身份进常驻进程:污染窗口、占轮次,
// 且请求不带世界书(sysLen 不一致)会触发杀进程重开,当前窗口直接丢。
// 这里由 shim 自己抽个标题直接回,不碰 claude 进程。
function isTitleGenReq(t) {
  if (/^\s*I will give you some dialogue content/i.test(t)) return true;
  return /<content>[\s\S]*<\/content>/i.test(t) && /summariz\w* the conversation[\s\S]{0,120}?(short\s+)?title/i.test(t);
}
function localTitle(raw) {
  // 模板正文里也会提到 "<content>" 这个词,所以取最后一个 <content> 开始的真实内容段
  const i = raw.toLowerCase().lastIndexOf("<content>");
  const j = i >= 0 ? raw.toLowerCase().indexOf("</content>", i) : -1;
  let src = (i >= 0 ? raw.slice(i + "<content>".length, j >= 0 ? j : raw.length) : raw).replace(/<[^>]+>/g, " ");
  const lines = src.split("\n").map((s) => s.trim()).filter(Boolean)
    .map((s) => s.replace(/^["'「『]?(user|assistant|human|ai|用户|助手)["'」』]?\s*[::]\s*/i, "").trim())
    .filter((s) => s && !/^I will give you/i.test(s));
  const line = lines.find((s) => /[一-鿿]/.test(s)) || lines[0] || "";
  return line.replace(/\s+/g, " ").slice(0, 10) || "聊天";
}

// ---- 重置词 ----
const GOODNIGHT_WORDS = ["晚安"];
const ARCHIVE_WORDS = ["归档", "换窗口", "开新窗口", "新窗口"];
function stripEnds(s) { return (s || "").trim().replace(/^[\s，,。.!！~～、]+|[\s，,。.!！~～、]+$/g, ""); }
function detectReset(text) {
  const t = stripEnds(text);
  for (const w of GOODNIGHT_WORDS) if (t === w || (t.length <= 6 && t.startsWith(w))) return "goodnight";
  for (const w of ARCHIVE_WORDS) if (t === w || (t.length <= 8 && t.includes(w))) return "archive";
  return null;
}

// ---- 主路由 ----
function handleMessages(req, res) {
  if (SHIM_KEY) {
    const key = req.get("x-api-key") || (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (key !== SHIM_KEY) return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "bad key" } });
  }
  const body = req.body || {};
  const messages = (body.messages || []).filter((m) => m.role === "user" || m.role === "assistant");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  let text = blocksToText(lastUser?.content ?? "");
  const images = extractImages(messages);
  const system = systemToText(body.system);
  const stream = body.stream !== false;

  // 标题生成等后台注入:shim 直接回,不进晏的进程,也不重置心跳计时
  if (!images.length && isTitleGenReq(text)) {
    const title = localTitle(text);
    log("[intercept] title-gen ->", title);
    const sse = stream ? makeSSE(res) : makeCollector(res);
    sse.text(title);
    sse.finish({ output_tokens: 0 }, title);
    return;
  }

  const reset = images.length ? null : detectReset(text);
  let newWindow = false;
  if (reset === "goodnight") {
    newWindow = true;
    text = `${text}\n\n【系统·今天收尾】对方说晚安要睡了。先像平时那样简短道句晚安,然后(若挂了记忆工具)归档今天,之后不用多说。`;
  } else if (reset === "archive") {
    newWindow = true;
    text = `【系统指令】立刻归档当前窗口(若挂了记忆工具),成功后只回一句「📦 归档好了,新窗口见」。`;
  }

  lastUserAt = Date.now();
  log("[req]", { len: text.length, imgs: images.length, sysLen: system.length, stream, reset: reset || "-" });
  const sse = stream ? makeSSE(res) : makeCollector(res);
  enqueue({ text, images, system, sse, newWindow });
}
app.post("/v1/messages", handleMessages);
app.post("/messages", handleMessages);

app.listen(PORT, () => log(`kelivo-shim on :${PORT} model=${MODEL}`));

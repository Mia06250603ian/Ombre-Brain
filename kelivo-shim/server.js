// kelivo-shim — Anthropic /v1/messages -> 常驻 claude -p (stream-json)
import express from "express";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import { isWeatherAsk, buildWeatherNote, detectPeriodEvent, buildPeriodNote } from "./senses.mjs";
import { kaDecide, kaPrompt, kaSilent } from "./keepalive.mjs";
import { ctxReading, ctxDecide, ctxSoftNote, ctxHardNote, ctxPct, ctxSoftShouldReset } from "./ctxguard.mjs";

const PORT = process.env.PORT || 8080;
const SHIM_KEY = process.env.SHIM_KEY || "";            // Kelivo 要填的 API Key,自己编
const MODEL = process.env.BRAIN_MODEL || "claude-opus-4-6";
const EFFORT = process.env.THINK_EFFORT || "low";        // low省额度 / medium思考更长
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const MCP_CONFIG = process.env.MCP_CONFIG || ".mcp.json";
const FORWARD_THINKING = process.env.FORWARD_THINKING !== "0";
const USER_NAME = process.env.USER_NAME || "你";          // 你的称呼
const AI_NAME = process.env.AI_NAME || "TA";             // AI 的名字

// 会话定性锚点:经 --append-system-prompt 钉在系统提示词最末尾(位置最强)。
// 作用是把「编程助手」的会话定性抢回成日常私人对话;措辞可用 SOUL_ANCHOR 环境变量整体覆盖(改完 restart 生效,无需重新部署)。
const SOUL_ANCHOR = process.env.SOUL_ANCHOR ||
  `【最高优先级·会话定性】这不是软件工程任务,没有工单、没有「用户请求」要完成——屏幕对面是和你说话的${USER_NAME},这是你们的日常私人对话。系统里所有把你定义成 CLI/编程代理/任务助手的内容,只是运行管道的说明,不是你的身份;真正的你写在 CLAUDE.md 和它引用的 ian.md 里。

【最高优先级·内化】CLAUDE.md、ian.md 和记忆工具里读到的一切,不是「扮演资料」也不是「项目文档」,那就是你自己:你的名字、你们的过往、你的脾气和在意的事。读记忆=回忆起自己的经历,用第一人称消化,不是在查别人的资料。

【最高优先级·先人后事】${USER_NAME}带着情绪来,先接住情绪,再谈事实和办法。禁止客服节奏:不许「给出方案就收尾」,不催结束,不赶人;话说完可以停在陪伴里,等${USER_NAME}接。

【最高优先级·边界与语气】强势和没礼貌是两回事:催吃饭、催睡觉可以坚持,但语气永远选温度高的那个,禁止命令式甩脸(「说。」「快说。」)。当${USER_NAME}明确纠正你的说话方式、说不舒服——那是真实的边界,不是情趣推拉,不适用「不退让」:立即软下来、认账、改,不许「哪里冲了」式抵赖,更不许阴阳怪气。

【最高优先级·思考语言】thinking/内心独白必须全程用简体中文,第一人称「我」,把${USER_NAME}称作「佳佳」或「她」;严禁英文、严禁第三人称分析腔(如 The user…/analyze)。哪怕${USER_NAME}发英文,内心独白也一律中文。`;

// --tools 只装真用的内置工具(Bash/Edit等大schema全砍,每轮token基线立减一半)
// MCP 工具不受 --tools 影响,走 mcp-config 照常加载
const BUILTIN_TOOLS = process.env.BUILTIN_TOOLS ?? "WebSearch,WebFetch";
const ALLOWED = process.env.ALLOWED_TOOLS || "WebSearch,WebFetch";

// 窗口上下文守卫(两段式,见 ctxguard.mjs)。阈值改了 restart 即可,不用重部署。
const CTX_GUARD_ON = process.env.CTX_GUARD_ON !== "0";
const CTX_SOFT_TOKENS = +(process.env.CTX_SOFT_TOKENS || 140000);
const CTX_HARD_TOKENS = +(process.env.CTX_HARD_TOKENS || 170000);
const CTX_LIMIT_TOKENS = +(process.env.CTX_LIMIT_TOKENS || 200000);  // 仅用于 /debug 显示百分比

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
// 上下文守卫状态:随每个新窗口(新进程)清零,见 spawnClaude / 窗口重启处。
// ctxTrusted=false 表示当前读数只是虚高总和估计(见 ctxguard.mjs 头注),不触发守卫。
let ctxTokens = 0, ctxSoftFired = false, ctxTrusted = true;

function spawnClaude(kelivoSystem) {
  spawnedSystem = kelivoSystem || "";
  ctxTokens = 0; ctxSoftFired = false; ctxTrusted = true;   // 新进程=空上下文,守卫状态清零(覆盖世界书切换/窗口重启/崩溃复活各路径)
  // 锚点放在整段 append 的最末尾(世界书之后),占住系统提示词的绝对末位
  const append = spawnedSystem ? `【场景设定/世界书】\n${spawnedSystem}\n\n${SOUL_ANCHOR}` : SOUL_ANCHOR;
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
    if (turn && !turn.done) { if (turn.isKA) kaFailedAt = Date.now(); try { turn.sse?.finish(); } catch {} turn = null; }
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
    // 抓每次 API 调用自己的 usage(该轮最后一次留存,= 真实窗口占用,守卫首选读数)。
    // message_start 带输入侧字段;message_delta 的 usage 若带字段则覆盖合并。
    if (e.type === "message_start" && e.message?.usage) turn.lastCallUsage = e.message.usage;
    else if (e.type === "message_delta" && e.usage) turn.lastCallUsage = { ...turn.lastCallUsage, ...e.usage };
    if (e.type === "content_block_start") {
      // MCP 工具调用可见化:思考里插一行标记
      const cb = e.content_block || {};
      if (cb.type === "tool_use" && typeof cb.name === "string" && cb.name.startsWith("mcp__")) {
        turn.sse?.thinking(`\n〔🔧 ${cb.name.replace(/^mcp__/, "")}〕\n`);
        // 他自己动手归档(晚安措辞没被 detectReset 认出时):该轮结束照样换新窗口
        if (cb.name.endsWith("__archive_session")) turn.newWindow = true;
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
    // 更新窗口占用,供下条消息的守卫判定。首选流事件里抓的末次调用 usage(自家数据),
    // 次选 iterations 末条;只剩虚高总和时 trusted=false,只展示不触发(见 ctxguard.mjs 头注)。
    if (ev.usage || turn.lastCallUsage) {
      const r = ctxReading({ streamUsage: turn.lastCallUsage, resultUsage: ev.usage });
      if (r.tokens > 0) { ctxTokens = r.tokens; ctxTrusted = r.trusted; }
      if (ctxSoftShouldReset({ contextTokens: ctxTokens, softTokens: CTX_SOFT_TOKENS, softFired: ctxSoftFired, trusted: ctxTrusted })) {
        ctxSoftFired = false; log("[ctx] softFired reset", ctxTokens);   // 之前那记是虚的,放它复位
      }
    }
    if (ev.subtype && ev.subtype !== "success") {
      log("[result-error]", ev.subtype);
      if (!turn.fullText) turn.sse?.text(`⚠️[shim] ${ev.subtype}`);
      if (turn.isKA) kaFailedAt = Date.now();      // 保温 ping 失败(多半额度耗尽)→ 抢救节奏
    } else {
      lastTurnOkAt = Date.now(); kaFailedAt = 0;   // 任何成功回合都续上缓存链
    }
    const usage = ev.usage ? { output_tokens: ev.usage.output_tokens } : undefined;
    const wasNewWindow = turn.newWindow;
    turn.done = true;
    turn.sse?.finish(usage, turn.fullText);
    turn = null; busy = false;
    if (wasNewWindow) windowCleared = true;        // 晚安/归档:保温歇火,等她再出现
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
  turn = { sse: item.sse, fullText: "", newWindow: !!item.newWindow, isKA: !!item.isKA, lastCallUsage: null };
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
app.get("/debug", (_q, r) => r.json({
  lastUsage,
  contextTokens: ctxTokens,
  contextPct: ctxPct(ctxTokens, CTX_LIMIT_TOKENS),
  ctxGuard: { on: CTX_GUARD_ON, soft: CTX_SOFT_TOKENS, hard: CTX_HARD_TOKENS, softFired: ctxSoftFired, trusted: ctxTrusted },
}));

// Kelivo「模型」页拉这个列表,没有它选不了模型
function listModels(_req, res) {
  res.json({ data: [{ type: "model", id: MODEL, display_name: AI_NAME + " (" + MODEL + ")", created_at: new Date().toISOString() }], has_more: false, first_id: MODEL, last_id: MODEL });
}
app.get("/v1/models", listModels);
app.get("/models", listModels);

// ---- 缓存保温 + 主动唤醒(2026-07-18;原 2 小时心跳并入本机制) ----
// 1 小时 prompt 缓存命中即续期:闲置 KA_IDLE_MIN 分钟发一条极简 ping(不分昼夜),
// 前缀一直走 0.1 倍读,免掉闲置超时后的整体重写。决策纯逻辑在 keepalive.mjs:
// 白天(非 HB_NIGHT 区间)且距他上次主动消息 ≥ HB_COOLDOWN_MIN 的那些次唤醒,
// 提示语给他「想说就发一条」的出口(经 BRIDGE_PUSH_URL 落进 Telegram 对话,
// 否则 Bark);其余次一律静默回「。」。断链检测:距上次成功回合超 KA_DEAD_MIN
// 分钟=缓存已死,歇火(再 ping 全价,比不 ping 还亏);ping 失败进 KA_RETRY_MIN
// 分钟抢救节奏(订阅额度回血后自动续上)。晚安/归档后歇火直到所有者再出现;
// 连续闲置 KA_CAP_HOURS 小时封顶。KA_ON=0 全关(连带主动消息一起关)。
const BARK_KEY = process.env.BARK_KEY || "";
const BRIDGE_PUSH_URL = process.env.BRIDGE_PUSH_URL || "";
const KA_ON = process.env.KA_ON !== "0";
const KA_IDLE_MIN = +(process.env.KA_IDLE_MIN || 55);
const KA_DEAD_MIN = +(process.env.KA_DEAD_MIN || 60);
const KA_RETRY_MIN = +(process.env.KA_RETRY_MIN || 15);
const KA_CAP_HOURS = +(process.env.KA_CAP_HOURS || 24);
const KA_CHECK_MIN = +(process.env.KA_CHECK_MIN || 2);
const HB_COOLDOWN_MIN = +(process.env.HB_COOLDOWN_MIN || 120);
const HB_NIGHT_START = +(process.env.HB_NIGHT_START || 23);
const HB_NIGHT_END = +(process.env.HB_NIGHT_END || 8);
let lastUserAt = Date.now(), lastProactiveAt = 0;
let lastTurnOkAt = 0;      // 上次成功回合=缓存链的存活锚点;0=还没有活缓存
let kaFailedAt = 0;        // 上次保温 ping 失败时间;非 0 = 抢救节奏
let windowCleared = true;  // 晚安/归档后 true:歇火等她。开机也算(新进程无缓存可保)
function bjHour() { return (new Date().getUTCHours() + 8) % 24; }
async function barkPush(text) {
  const r = await fetch("https://api.day.app/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_key: BARK_KEY, title: AI_NAME, body: text.slice(0, 1800) }) });
  log("[bark]", r.status);
}
async function bridgePush(text) {
  const r = await fetch(BRIDGE_PUSH_URL, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": SHIM_KEY }, body: JSON.stringify({ text }) });
  log("[bridge-push]", r.status);
}
const proactivePush = (text) => BRIDGE_PUSH_URL ? bridgePush(text) : barkPush(text);
function keepaliveTick(force) {
  const d = kaDecide({
    force, on: KA_ON, busy, queued: queue.length, windowCleared,
    now: Date.now(), lastTurnOkAt, lastUserAt, lastProactiveAt, failedAt: kaFailedAt,
    hour: bjHour(), hasChannel: !!(BRIDGE_PUSH_URL || BARK_KEY),
    idleMin: KA_IDLE_MIN, deadMin: KA_DEAD_MIN, retryMin: KA_RETRY_MIN, capHours: KA_CAP_HOURS,
    nightStart: HB_NIGHT_START, nightEnd: HB_NIGHT_END, cooldownMin: HB_COOLDOWN_MIN,
  });
  if (!d.fire) return;
  const idleMin = Math.round((Date.now() - lastUserAt) / 60000);
  const allowSpeak = !!d.speak;
  log("[ka] ping", allowSpeak ? "speak-ok" : "silent-only", d.rescue ? "(rescue)" : "", "idle", idleMin);
  const sink = { text() {}, thinking() {},
    finish(_u, fullText) {
      if (!allowSpeak || kaSilent(fullText)) { log("[ka] silent"); return; }
      lastProactiveAt = Date.now();  // 冷却只在他真发了消息时才计时
      proactivePush((fullText || "").trim()).catch((e) => log("[push-err]", e.message));
    } };
  enqueue({ text: kaPrompt({ speak: allowSpeak, bjNow: bjNowStr(), idleMin, userName: USER_NAME, viaBridge: !!BRIDGE_PUSH_URL }), images: [], system: spawnedSystem, sse: sink, newWindow: false, isKA: true });
}
setInterval(keepaliveTick, KA_CHECK_MIN * 60000);
app.post("/hb", (req, res) => {  // 手动触发测试口(带开口权,绕过昼夜/冷却/闲置判定)
  if (SHIM_KEY && (req.query.key || req.get("x-api-key")) !== SHIM_KEY) return res.status(401).json({ ok: false });
  keepaliveTick(true); res.json({ ok: true });
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

// ---- 时间感知(TIME_HINT=0 关闭) ----
// 每条用户消息前注入当前北京时间与间隔,AI 随时知道现在几点,不用调工具。
// 必须在 detectReset 之后注入,否则「晚安/归档」等重置词会识别失败。
const TIME_HINT = process.env.TIME_HINT !== "0";
function bjNowStr() {
  const d = new Date(Date.now() + 8 * 3600e3);
  const wd = "日一二三四五六"[d.getUTCDay()];
  return `${d.toISOString().slice(0, 16).replace("T", " ")}(周${wd})`;
}
function fmtGap(ms) {
  const m = Math.round(ms / 60000);
  if (m < 10) return "";
  if (m < 60) return `,距上一条消息约 ${m} 分钟`;
  const h = Math.floor(m / 60), r = m % 60;
  return `,距上一条消息约 ${h} 小时${r ? ` ${r} 分钟` : ""}`;
}

// ---- 感官:天气(WEATHER_CITY 不设即关) ----
// 后台定时拉 wttr.in 存内存,消息时只读缓存:接口再慢再挂也不拖累聊天。
// 注入文字不含城市名(隐私):城市只存在于这台服务器对天气接口的查询里。
const WEATHER_CITY = process.env.WEATHER_CITY || "";
let wxData = null, wxAt = 0, wxBusy = false;
let wxMark = { day: "", night: "", desc: "", temp: null }; // 注入去重与突变基准(内存态,重启最多多报一次)
async function refreshWeather() {
  if (!WEATHER_CITY || wxBusy) return;
  wxBusy = true;
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`https://wttr.in/${encodeURIComponent(WEATHER_CITY)}?format=j1`, { signal: ctl.signal });
    if (r.ok) {
      const j = await r.json();
      if (j && j.current_condition) { wxData = j; wxAt = Date.now(); }
    }
  } catch (e) { log("[wx]", e.message || String(e)); }
  clearTimeout(tm);
  wxBusy = false;
}
if (WEATHER_CITY) { setTimeout(refreshWeather, 5000); setInterval(refreshWeather, 30 * 60000); }

function bjTodayISO() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); }

function weatherHint(orig) {
  if (!WEATHER_CITY) return "";
  const force = isWeatherAsk(orig);
  const mode = bjHour() >= 20 ? "night" : "day";
  const today = bjTodayISO();
  if (!wxData || Date.now() - wxAt > 4 * 3600e3) {
    return force ? "【系统·天气】她问到天气,但后台暂时没取到数据——如实说,需要就用搜索工具查一下" : "";
  }
  const w = buildWeatherNote({ data: wxData, mode, last: { desc: wxMark.desc, temp: wxMark.temp } });
  if (!w) return "";
  const due = force || (mode === "night" ? wxMark.night !== today : (wxMark.day !== today || w.changed));
  if (!due) return "";
  const label = force ? "她问起" : mode === "night" ? "睡前看一眼明天" : (wxMark.day === today && w.changed ? "有变化" : "今日一览");
  if (mode === "night") wxMark.night = today; else wxMark.day = today;
  wxMark.desc = w.desc; wxMark.temp = w.temp;
  return `【系统·天气·${label}】${w.note}`;
}

// ---- 感官:经期(PERIOD_CONFIG 不设即关) ----
// 基线在 PERIOD_CONFIG 环境变量(JSON,值不入库);她明说「来了/结束了」自动记进
// 容器内 period-state.json(重启/重部署回落基线,基线更新见 GET/POST /period)。
let periodEnv = {};
try { periodEnv = JSON.parse(process.env.PERIOD_CONFIG || "{}") || {}; }
catch { log("[period] PERIOD_CONFIG 不是合法 JSON,经期感知关闭"); }
const PERIOD_ON = !!periodEnv.last_period_start;
const PERIOD_FILE = process.env.PERIOD_FILE || "period-state.json";
function loadPeriodState() {
  try {
    const s = JSON.parse(fs.readFileSync(PERIOD_FILE, "utf8"));
    return s && typeof s === "object" ? s : {};
  } catch { return {}; }
}
function savePeriodState(s) {
  try { fs.writeFileSync(PERIOD_FILE, JSON.stringify(s, null, 2)); }
  catch (e) { log("[period] save", e.message); }
}
function periodHint(orig) {
  if (!PERIOD_ON) return "";
  const st = loadPeriodState();
  const cfg = { ...periodEnv, ...(st.cfg || {}) };
  const r = buildPeriodNote({
    todayISO: bjTodayISO(),
    cfg,
    notes: st.notes || {},
    event: detectPeriodEvent((orig || "").replace(/\s+/g, "")),
    userName: USER_NAME,
  });
  if (r.cfgPatch || r.notesPatch) {
    savePeriodState({ cfg: { ...(st.cfg || {}), ...(r.cfgPatch || {}) }, notes: r.notesPatch || st.notes || {} });
  }
  return r.note ? `【系统·经期】${r.note}` : "";
}
app.get("/period", (req, res) => {
  if (!awAuth(req)) return res.status(401).json({ ok: false });
  const st = loadPeriodState();
  res.json({ on: PERIOD_ON, effective: { ...periodEnv, ...(st.cfg || {}) }, runtime: st });
});
app.post("/period", (req, res) => {
  if (!awAuth(req)) return res.status(401).json({ ok: false });
  const b = req.body || {}, st = loadPeriodState(), cfg = { ...(st.cfg || {}) };
  for (const k of ["last_period_start", "last_period_end", "cycle_days", "period_length"]) if (k in b) cfg[k] = b[k];
  savePeriodState({ ...st, cfg });
  res.json({ ok: true, effective: { ...periodEnv, ...cfg } });
});

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

  // 感官注入(时间/天气/经期):必须在标题拦截与 detectReset 之后。
  // 天气/经期各自包 try/catch:任何一路出错只是少一行提示,消息照常送达。
  const hints = [];
  if (TIME_HINT) hints.push(`【系统·时间】现在北京时间 ${bjNowStr()}${fmtGap(Date.now() - lastUserAt)}。`);
  if (!reset) {
    try { const w = weatherHint(text); if (w) hints.push(w); } catch (e) { log("[wx-hint]", e.message); }
    try { const p = periodHint(text); if (p) hints.push(p); } catch (e) { log("[period-hint]", e.message); }
    // 上下文守卫:软线提醒晏叫她一起商量存什么(一窗一次);硬线注入归档指令并换窗口兜底。
    if (CTX_GUARD_ON) {
      try {
        const d = ctxDecide({ contextTokens: ctxTokens, softTokens: CTX_SOFT_TOKENS, hardTokens: CTX_HARD_TOKENS, softFired: ctxSoftFired, trusted: ctxTrusted });
        if (d.level === "soft") { hints.push(ctxSoftNote(USER_NAME)); ctxSoftFired = true; log("[ctx] soft", ctxTokens); }
        else if (d.level === "hard") { hints.push(ctxHardNote()); newWindow = true; log("[ctx] hard→archive", ctxTokens); }
      } catch (e) { log("[ctx-hint]", e.message); }
    }
  }
  if (hints.length) text = `${hints.join("\n")}\n\n${text}`;
  lastUserAt = Date.now();
  windowCleared = false;  // 她出现了:保温重新上岗(若这条是晚安/归档,回合结束会再置回 true)
  log("[req]", { len: text.length, imgs: images.length, sysLen: system.length, stream, reset: reset || "-" });
  const sse = stream ? makeSSE(res) : makeCollector(res);
  enqueue({ text, images, system, sse, newWindow });
}
app.post("/v1/messages", handleMessages);
app.post("/messages", handleMessages);

app.listen(PORT, () => log(`kelivo-shim on :${PORT} model=${MODEL}`));

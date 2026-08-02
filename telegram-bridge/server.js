// telegram-bridge — Telegram Bot ⇄ kelivo-shim(/v1/messages)
// 独立服务:shim 零改动,Kelivo 照常可用。停掉本服务 = 回到没有 Telegram 的现状。
import express from "express";
import https from "https";
import fs from "fs";
import path from "path";
import {
  splitForTelegram, detectReset, mergeTurn, buildShimBody,
  makeSseAccumulator, escapeHtml, isAllowedChat, mediaTypeOf, extractSegments, bubblesFor,
  formatEarsResult,
  normalizeAppName, pushActivity, summarizeActivity, curfewDecide, curfewPrompt, isSilentReply,
  takeCheckMarker, lookupPrompt,
} from "./bridge-lib.mjs";

const PORT = process.env.PORT || 8080;
const BOT = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOW = (process.env.TELEGRAM_CHAT_ID || "").split(",").map((s) => s.trim()).filter(Boolean);
const SHIM_URL = (process.env.SHIM_URL || "https://yan-shim.zeabur.app").replace(/\/$/, "");
const SHIM_KEY = process.env.SHIM_KEY || "";
const SYSTEM_TEXT = process.env.SYSTEM_TEXT || "";   // 如需与 Kelivo 世界书一致,整段放这里
const MODEL = process.env.BRAIN_MODEL || "claude-opus-4-6"; // 占位,shim 不看
const DEBOUNCE_MS = +(process.env.DEBOUNCE_MS || 4000);
const TG_THINKING = process.env.TG_THINKING === "1";  // 思考折叠引用,默认关
const BRIDGE_ON = process.env.BRIDGE_ON !== "0";      // 总开关:设 0 只留 /health
const TURN_TIMEOUT_MS = +(process.env.TURN_TIMEOUT_MS || 15 * 60000);
// ears:她的语音条 → 转写+语气分析(独立服务,见 ears 仓库与其部署指南)。两个变量都配了才开。
const EARS_URL = (process.env.EARS_URL || "").replace(/\/$/, "");
const EARS_TOKEN = process.env.EARS_TOKEN || "";
const EARS_ON = !!(EARS_URL && EARS_TOKEN);
const EARS_TIMEOUT_MS = +(process.env.EARS_TIMEOUT_MS || 60000);
// 手机活动上报(iOS 快捷指令 → POST /report)+ 夜里查岗。REPORT_TOKEN 不设 = 整套功能关。
const REPORT_TOKEN = process.env.REPORT_TOKEN || "";
const REPORT_ON = !!REPORT_TOKEN;
const CURFEW_ON = REPORT_ON && process.env.CURFEW_ON !== "0";
const CURFEW_START = +(process.env.CURFEW_START || 1);        // 北京时间,含
const CURFEW_END = +(process.env.CURFEW_END || 7);            // 北京时间,不含
const CURFEW_COOLDOWN_MIN = +(process.env.CURFEW_COOLDOWN_MIN || 30);
const CURFEW_CHECK_MIN = +(process.env.CURFEW_CHECK_MIN || 5);
const ACTIVITY_FRESH_MIN = +(process.env.ACTIVITY_FRESH_MIN || 15); // 超过这么久的记录不再当「她正在玩」

const log = (...a) => console.log(new Date().toISOString(), ...a);
const bjHour = () => (new Date().getUTCHours() + 8) % 24;
const bjNowStr = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 16);

// ---- Telegram API ----
async function tg(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${BOT}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) log(`[tg] ${method} failed:`, j.description || r.status);
  return j;
}
async function tgFileToImage(fileId) {
  const f = await tg("getFile", { file_id: fileId });
  const p = f.result?.file_path;
  const mt = mediaTypeOf(p);
  if (!p || !mt) return null;
  const r = await fetch(`https://api.telegram.org/file/bot${BOT}/${p}`);
  if (!r.ok) return null;
  const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
  return { type: "image", source: { type: "base64", media_type: mt, data: b64 } };
}
// 她的语音条:下载 → 发 ears 分析,拿回「转写+语气」。任何失败抛错,调用方兜底提示。
async function earsListen(fileId) {
  const f = await tg("getFile", { file_id: fileId });
  const p = f.result?.file_path;
  if (!p) throw new Error("getFile 失败");
  const r = await fetch(`https://api.telegram.org/file/bot${BOT}/${p}`);
  if (!r.ok) throw new Error(`下载语音 HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const ext = (p.split(".").pop() || "oga").toLowerCase();
  const form = new FormData();
  form.append("file", new Blob([buf]), `voice.${ext}`);
  const resp = await fetch(`${EARS_URL}/api/listen`, {
    method: "POST", headers: { "x-token": EARS_TOKEN }, body: form,
    signal: AbortSignal.timeout(EARS_TIMEOUT_MS),
  });
  const d = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(d.error || `ears HTTP ${resp.status}`);
  return d;
}
async function sendReply(chatId, text) {
  for (const chunk of splitForTelegram(text)) await tg("sendMessage", { chat_id: chatId, text: chunk });
}

// ---- 贴纸:stickers/registry.json 标签→512px WebP;首次上传后缓存 file_id 复用 ----
// 必须走 sendSticker(不是 sendPhoto):photo 会被 Telegram 整宽渲染成大图,
// sticker 才是聊天里小小一块的贴纸尺寸(2026-07-17 实测踩过)。
const STICKER_DIR = process.env.STICKER_DIR || "stickers";
let stickerReg = {};
try { stickerReg = JSON.parse(fs.readFileSync(path.join(STICKER_DIR, "registry.json"), "utf8")); }
catch { log("[sticker] 没有 registry.json,贴纸功能关"); }
const stickerTags = Object.keys(stickerReg);
const stickerFileIds = {};
async function sendSticker(chatId, tag) {
  const file = stickerReg[tag];
  if (!file) return;
  if (stickerFileIds[tag]) { await tg("sendSticker", { chat_id: chatId, sticker: stickerFileIds[tag] }); return; }
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("sticker", new Blob([fs.readFileSync(path.join(STICKER_DIR, file))], { type: "image/webp" }), file);
  const r = await fetch(`https://api.telegram.org/bot${BOT}/sendSticker`, { method: "POST", body: form });
  const j = await r.json().catch(() => ({}));
  if (j.ok) { const id = j.result?.sticker?.file_id; if (id) stickerFileIds[tag] = id; }
  else log("[sticker] sendSticker failed:", j.description || r.status);
}

// ---- 语音:[语音]…[/语音] 段经 ElevenLabs 转成 Telegram 语音条 ----
// 免费档实测可直接输出 Ogg/Opus;转不出来就退回发文字,话永远不会丢。
const ELEVEN_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE = process.env.ELEVEN_VOICE_ID || "";
const VOICE_MODEL = process.env.VOICE_MODEL || "eleven_multilingual_v2";
const VOICE_SPEED = +(process.env.VOICE_SPEED || 0.85);
const VOICE_STABILITY = +(process.env.VOICE_STABILITY || 0.6);
const VOICE_MAX_CHARS = +(process.env.VOICE_MAX_CHARS || 500); // 超长不转,省积分
const VOICE_ON = !!(ELEVEN_KEY && ELEVEN_VOICE);
async function ttsOpus(text) {
  const body = JSON.stringify({ text, model_id: VOICE_MODEL, voice_settings: { speed: VOICE_SPEED, stability: VOICE_STABILITY } });
  for (const fmt of ["opus_48000_64", "mp3_44100_128"]) {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE}?output_format=${fmt}`, {
      method: "POST", headers: { "xi-api-key": ELEVEN_KEY, "Content-Type": "application/json" }, body,
    });
    if (r.ok) return { buf: Buffer.from(await r.arrayBuffer()), name: fmt.startsWith("opus") ? "voice.ogg" : "voice.mp3" };
    log("[tts]", fmt, r.status, (await r.text()).slice(0, 200));
  }
  throw new Error("tts failed");
}
async function sendVoiceMsg(chatId, text) {
  const { buf, name } = await ttsOpus(text);
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("voice", new Blob([buf]), name);
  const r = await fetch(`https://api.telegram.org/bot${BOT}/sendVoice`, { method: "POST", body: form });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`sendVoice: ${j.description || r.status}`);
}

// 统一出口(轮次回复和 /push 主动消息共用):按原文顺序发段落流——
// 文字按换行拆成一句一个气泡(BUBBLE_SPLIT=0 关),贴纸在他写的位置插进序列;
// 气泡间隔随下一句长度 0.5~1.6s,配 typing 状态,手感像真人连发。
const BUBBLE_SPLIT = process.env.BUBBLE_SPLIT !== "0";
const BUBBLE_MAX = +(process.env.BUBBLE_MAX || 200); // 整段回复超过此长度=长文,不拆
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
async function sendOutput(chatId, rawText, { fallback } = {}) {
  const { segments, unknown } = extractSegments(rawText || "", stickerTags);
  if (unknown.length) log("[sticker] unknown tags:", unknown.join(","));
  if (!segments.length) { if (fallback) await sendReply(chatId, fallback); return; }
  lastOutboundAt = Date.now();   // 他每次开口都从这个门出去(回复/心跳/查岗),查岗的冷却看这个
                                 // ——真发出去了才算,只写了个 [查岗] 标记不算他开过口
  let first = true;
  for (const seg of segments) {
    if (seg.type === "sticker") {
      if (!first) await sleep(400);
      await sendSticker(chatId, seg.tag).catch((e) => log("[sticker-err]", e.message));
      first = false;
      continue;
    }
    if (seg.type === "voice") {
      if (VOICE_ON && seg.text.length <= VOICE_MAX_CHARS) {
        if (!first) await sleep(400);
        tg("sendChatAction", { chat_id: chatId, action: "record_voice" }).catch(() => {});
        try { await sendVoiceMsg(chatId, seg.text); first = false; continue; }
        catch (e) { log("[voice-err]", e.message); }
      }
      // 没配置/超长/转失败:话不能丢,退回文字发
      for (const b of bubblesFor(seg.text, { split: BUBBLE_SPLIT, maxLen: BUBBLE_MAX })) {
        if (!first) await sleep(500);
        await tg("sendMessage", { chat_id: chatId, text: b });
        first = false;
      }
      continue;
    }
    const bubbles = bubblesFor(seg.text, { split: BUBBLE_SPLIT, maxLen: BUBBLE_MAX });
    for (const b of bubbles) {
      if (!first) {
        tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
        await sleep(Math.min(500 + b.length * 25, 1600));
      }
      await tg("sendMessage", { chat_id: chatId, text: b });
      first = false;
    }
  }
}
async function sendThinking(chatId, thinking) {
  if (!TG_THINKING || !thinking.trim()) return;
  for (const chunk of splitForTelegram(thinking.trim(), 3900))
    await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `<blockquote expandable>${escapeHtml(chunk)}</blockquote>` });
}

// ---- shim 调用(node:https,免 undici 300s 超时;SSE 攒完整段再发)----
function shimTurn(turn) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(buildShimBody(turn, { model: MODEL, system: SYSTEM_TEXT }));
    const u = new URL(SHIM_URL + "/v1/messages");
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": SHIM_KEY, "Content-Length": Buffer.byteLength(body) },
      timeout: TURN_TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`shim HTTP ${res.statusCode}`)); }
      const acc = makeSseAccumulator();
      res.on("data", (d) => acc.feed(d.toString()));
      res.on("end", () => resolve(acc.result()));
      res.on("error", reject);
    });
    req.on("timeout", () => { req.destroy(new Error("shim turn timeout")); });
    req.on("error", reject);
    req.end(body);
  });
}

// ---- 缓冲 + 轮次队列 ----
// 连发短句攒 DEBOUNCE_MS 合成一轮(省轮次);重置词(晚安/归档)绝不合并,
// 否则 shim 的 detectReset 识别失败,归档指令变普通聊天。
let buffer = [];        // [{text, images}]
let turnQueue = [];     // [{text, images, chatId}]
let debounceTimer = null;
let inflight = false;
let lastChatId = ALLOW[0] || null;
let lastOutboundAt = 0;   // 他上次开口(任何渠道)的时间,查岗据此不赶话

function flushBuffer() {
  clearTimeout(debounceTimer); debounceTimer = null;
  if (!buffer.length) return;
  const turn = mergeTurn(buffer);
  buffer = [];
  turnQueue.push({ ...turn, chatId: lastChatId });
  runQueue();
}
function scheduleFlush() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushBuffer, DEBOUNCE_MS);
}
async function runQueue() {
  if (inflight || !turnQueue.length) return;
  inflight = true;
  const t = turnQueue.shift();
  const typing = setInterval(() => tg("sendChatAction", { chat_id: t.chatId, action: "typing" }).catch(() => {}), 5000);
  tg("sendChatAction", { chat_id: t.chatId, action: "typing" }).catch(() => {});
  try {
    log("[turn]", { len: t.text.length, imgs: t.images.length, curfew: !!t.curfew });
    const r = await shimTurn(t);
    // 他自己写了 [查岗]:剥掉标记,正文照发,回头把查到的喂回去(lookup 轮不再响应,防打转)
    const { text: outText, wants } = takeCheckMarker(r.text);
    if ((t.curfew || t.lookup) && isSilentReply(outText)) {
      log("[curfew] 他选择不打扰");          // 回「。」= 不说话,这条不进对话
    } else {
      await sendThinking(t.chatId, r.thinking);
      await sendOutput(t.chatId, outText, { fallback: wants ? null : "⚠️[bridge] 空回复,看下 shim 日志" });
    }
    if (wants && !t.lookup) queueLookup(t.chatId);
  } catch (e) {
    log("[turn-err]", e.message);
    // 查岗是系统自己发起的,失败不该往她对话里丢报错(她没问,别打扰)
    if (t.curfew) log("[curfew-err]", e.message);
    else await sendReply(t.chatId, `⚠️[bridge] ${e.message}`).catch(() => {});
  }
  clearInterval(typing);
  inflight = false;
  if (turnQueue.length) runQueue();
  else if (buffer.length) flushBuffer(); // 生成期间攒下的消息立刻接上
}

// ---- 收消息 ----
async function onMessage(msg) {
  const chatId = msg.chat?.id;
  if (!isAllowedChat(chatId, ALLOW)) { log("[drop] stranger chat", chatId); return; }
  lastChatId = chatId;

  let text = msg.text || msg.caption || "";
  const images = [];
  try {
    if (msg.photo?.length) {
      const img = await tgFileToImage(msg.photo[msg.photo.length - 1].file_id);
      if (img) images.push(img);
    } else if (msg.sticker) {
      if (msg.sticker.is_animated || msg.sticker.is_video) {
        text = text || `(她发来一个贴纸:${msg.sticker.emoji || "🙂"})`;
      } else {
        const img = await tgFileToImage(msg.sticker.file_id);
        if (img) { images.push(img); text = text || `(她发来一个贴纸)`; }
        else text = text || `(她发来一个贴纸:${msg.sticker.emoji || "🙂"})`;
      }
    } else if (msg.voice && EARS_ON) {
      // 语音条走 ears:转写+语气,绑在这一条消息上进晏的窗口
      try {
        const d = await earsListen(msg.voice.file_id);
        const line = formatEarsResult(d);
        if (!line) {
          await tg("sendMessage", { chat_id: chatId, text: `⚠️[bridge] 语音没听清${d?.error ? `(${d.error})` : ""},再说一次?` });
          return;
        }
        text = text ? `${text}\n${line}` : line;
      } catch (e) {
        log("[ears-err]", e.message);
        await tg("sendMessage", { chat_id: chatId, text: `⚠️[bridge] 语音听不了(${e.message}),打字告诉他吧` });
        return;
      }
    } else if (msg.voice || msg.audio || msg.video || msg.document) {
      await tg("sendMessage", { chat_id: chatId, text: "⚠️[bridge] 这类消息暂时传不过去(支持文字/图片/贴纸/语音条)" });
      return;
    }
  } catch (e) { log("[media-err]", e.message); }
  if (!text && !images.length) return;

  // /start 只用于第一次拿 chat_id,不进对话
  if (text === "/start") { await tg("sendMessage", { chat_id: chatId, text: "接好了,直接说话就行。" }); return; }

  if (!images.length && detectReset(text)) {
    flushBuffer();                                    // 之前攒的先作为一轮发走
    turnQueue.push({ text, images: [], chatId });     // 重置词单独成轮
    runQueue();
    return;
  }
  buffer.push({ text, images });
  scheduleFlush();
}

// ---- 长轮询 ----
let offset = 0, polling = false;
async function pollLoop() {
  polling = true;
  while (true) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${BOT}/getUpdates?timeout=50&offset=${offset}&allowed_updates=%5B%22message%22%5D`, { signal: AbortSignal.timeout(60000) });
      const j = await r.json();
      if (!j.ok) { log("[poll] not ok:", j.description); await new Promise((s) => setTimeout(s, 5000)); continue; }
      for (const u of j.result || []) {
        offset = u.update_id + 1;
        if (u.message) await onMessage(u.message).catch((e) => log("[msg-err]", e.message));
      }
    } catch (e) { log("[poll-err]", e.message); await new Promise((s) => setTimeout(s, 3000)); }
  }
}

// ---- health + 主动推送口 ----
// POST /push {text}:shim 的主动心跳走这里,直接落进 Telegram 对话(支持贴纸标记)。
const app = express();
app.use(express.json({ limit: "1mb" }));
app.post("/push", async (req, res) => {
  const key = req.get("x-api-key") || req.query.key || "";
  if (!SHIM_KEY || key !== SHIM_KEY) return res.status(401).json({ ok: false });
  const raw = (req.body?.text || "").trim();
  if (!raw) return res.status(400).json({ ok: false, error: "empty text" });
  if (!lastChatId) return res.status(503).json({ ok: false, error: "no chat" });
  // 心跳消息里也可能写 [查岗](他醒来想先看一眼再决定说什么)
  const { text, wants } = takeCheckMarker(raw);
  try {
    if (text) await sendOutput(lastChatId, text);
    if (wants) queueLookup(lastChatId);
    res.json({ ok: true, lookup: wants });
  } catch (e) { log("[push-err]", e.message); res.status(502).json({ ok: false, error: e.message }); }
});

// ---- 手机活动上报 + 夜里查岗 ----
// 链路:她点开 App → iOS 快捷指令 POST /report → 存内存 →
//       宵禁时段的定时器发现有新动静 → 把这件事作为【系统·查岗】喂给晏 → 他自己决定说不说。
// 注意 REPORT_TOKEN 与 SHIM_KEY 是两把不同的钥匙:这一把存在她手机的快捷指令里,
// 泄露只影响这个功能,碰不到晏本体。
let activity = [];        // [{app, at}] 只在内存,重启即忘
let lastRawReport = null; // 最近一次上报的原始 body(验证快捷指令有没有真把 App 名带上)
let lastPokeAt = 0;
function reportAuth(req) {
  const bearer = (req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const k = bearer || req.get("x-api-key") || req.query.key || "";
  return REPORT_ON && k === REPORT_TOKEN;
}
app.post("/report", (req, res) => {
  if (!REPORT_ON) return res.status(503).json({ ok: false, error: "REPORT_TOKEN 未配置" });
  if (!reportAuth(req)) return res.status(401).json({ ok: false });
  lastRawReport = { at: Date.now(), body: req.body ?? null };
  const app_name = normalizeAppName(req.body?.app_name);
  if (!app_name) return res.json({ ok: true, stored: false, note: "app_name 为空,只留了原始 body" });
  activity = pushActivity(activity, { app: app_name });
  res.json({ ok: true, stored: true, count: activity.length });
});
app.get("/activity", (req, res) => {
  if (!REPORT_ON) return res.status(503).json({ ok: false, error: "REPORT_TOKEN 未配置" });
  if (!reportAuth(req)) return res.status(401).json({ ok: false });
  res.json({ now: new Date().toISOString(), ...summarizeActivity(activity), lastRawReport });
});
// 他写了 [查岗] → 把查到的作为新一轮喂回去。lookup:true 标记这一轮不再响应标记(防打转)。
function queueLookup(chatId) {
  if (!REPORT_ON) { log("[lookup] REPORT_TOKEN 未配置,忽略"); return; }
  log("[lookup] 他要查");
  turnQueue.push({
    text: lookupPrompt(summarizeActivity(activity), { bjNow: bjNowStr() }),
    images: [], chatId: chatId || lastChatId, lookup: true,
  });
  runQueue();
}
function curfewTick() {
  const d = curfewDecide({
    on: CURFEW_ON, now: Date.now(), hour: bjHour(), list: activity,
    busy: inflight || turnQueue.length > 0 || buffer.length > 0,
    lastPokeAt, lastOutboundAt,
    curfewStart: CURFEW_START, curfewEnd: CURFEW_END,
    cooldownMin: CURFEW_COOLDOWN_MIN, freshMin: ACTIVITY_FRESH_MIN,
  });
  if (!d.fire) return;
  if (!lastChatId) { log("[curfew] 还没有 chat,跳过"); return; }
  lastPokeAt = Date.now();
  log("[curfew] poke", d.app, d.minutesAgo, "分钟前");
  turnQueue.push({
    text: curfewPrompt({ bjNow: bjNowStr(), app: d.app, minutesAgo: d.minutesAgo }),
    images: [], chatId: lastChatId, curfew: true,
  });
  runQueue();
}
if (CURFEW_ON) setInterval(curfewTick, CURFEW_CHECK_MIN * 60000);

app.get("/health", (_q, r) => r.json({ ok: true, on: BRIDGE_ON, polling, inflight, buffered: buffer.length, queued: turnQueue.length, stickers: stickerTags.length, ears: EARS_ON, report: REPORT_ON, curfew: CURFEW_ON, activity: activity.length }));
app.listen(PORT, () => log(`telegram-bridge on :${PORT} shim=${SHIM_URL} on=${BRIDGE_ON}`));

if (!BRIDGE_ON) log("[bridge] BRIDGE_ON=0,只留 /health");
else if (!BOT || !ALLOW.length || !SHIM_KEY) log("[bridge] 缺 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / SHIM_KEY,不启动轮询");
else pollLoop();

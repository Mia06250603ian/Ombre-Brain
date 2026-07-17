// telegram-bridge — Telegram Bot ⇄ kelivo-shim(/v1/messages)
// 独立服务:shim 零改动,Kelivo 照常可用。停掉本服务 = 回到没有 Telegram 的现状。
import express from "express";
import https from "https";
import fs from "fs";
import path from "path";
import {
  splitForTelegram, detectReset, mergeTurn, buildShimBody,
  makeSseAccumulator, escapeHtml, isAllowedChat, mediaTypeOf, extractStickers,
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

const log = (...a) => console.log(new Date().toISOString(), ...a);

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
async function sendReply(chatId, text) {
  for (const chunk of splitForTelegram(text)) await tg("sendMessage", { chat_id: chatId, text: chunk });
}

// ---- 贴纸:stickers/registry.json 标签→文件;首次上传后缓存 file_id 复用 ----
const STICKER_DIR = process.env.STICKER_DIR || "stickers";
let stickerReg = {};
try { stickerReg = JSON.parse(fs.readFileSync(path.join(STICKER_DIR, "registry.json"), "utf8")); }
catch { log("[sticker] 没有 registry.json,贴纸功能关"); }
const stickerTags = Object.keys(stickerReg);
const stickerFileIds = {};
async function sendSticker(chatId, tag) {
  const file = stickerReg[tag];
  if (!file) return;
  if (stickerFileIds[tag]) { await tg("sendPhoto", { chat_id: chatId, photo: stickerFileIds[tag] }); return; }
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", new Blob([fs.readFileSync(path.join(STICKER_DIR, file))]), file);
  const r = await fetch(`https://api.telegram.org/bot${BOT}/sendPhoto`, { method: "POST", body: form });
  const j = await r.json().catch(() => ({}));
  if (j.ok) { const ph = j.result?.photo; if (ph?.length) stickerFileIds[tag] = ph[ph.length - 1].file_id; }
  else log("[sticker] sendPhoto failed:", j.description || r.status);
}

// 统一出口:剥贴纸标记 → 发正文 → 发贴纸(轮次回复和 /push 主动消息共用)
async function sendOutput(chatId, rawText, { fallback } = {}) {
  const { text, stickers, unknown } = extractStickers(rawText || "", stickerTags);
  if (unknown.length) log("[sticker] unknown tags:", unknown.join(","));
  if (text) await sendReply(chatId, text);
  else if (!stickers.length && fallback) await sendReply(chatId, fallback);
  for (const t of stickers) await sendSticker(chatId, t).catch((e) => log("[sticker-err]", e.message));
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
    log("[turn]", { len: t.text.length, imgs: t.images.length });
    const r = await shimTurn(t);
    await sendThinking(t.chatId, r.thinking);
    await sendOutput(t.chatId, r.text, { fallback: "⚠️[bridge] 空回复,看下 shim 日志" });
  } catch (e) {
    log("[turn-err]", e.message);
    await sendReply(t.chatId, `⚠️[bridge] ${e.message}`).catch(() => {});
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
    } else if (msg.voice || msg.audio || msg.video || msg.document) {
      await tg("sendMessage", { chat_id: chatId, text: "⚠️[bridge] 这类消息暂时传不过去(先支持文字/图片/贴纸)" });
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
  const text = (req.body?.text || "").trim();
  if (!text) return res.status(400).json({ ok: false, error: "empty text" });
  if (!lastChatId) return res.status(503).json({ ok: false, error: "no chat" });
  try { await sendOutput(lastChatId, text); res.json({ ok: true }); }
  catch (e) { log("[push-err]", e.message); res.status(502).json({ ok: false, error: e.message }); }
});
app.get("/health", (_q, r) => r.json({ ok: true, on: BRIDGE_ON, polling, inflight, buffered: buffer.length, queued: turnQueue.length, stickers: stickerTags.length }));
app.listen(PORT, () => log(`telegram-bridge on :${PORT} shim=${SHIM_URL} on=${BRIDGE_ON}`));

if (!BRIDGE_ON) log("[bridge] BRIDGE_ON=0,只留 /health");
else if (!BOT || !ALLOW.length || !SHIM_KEY) log("[bridge] 缺 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / SHIM_KEY,不启动轮询");
else pollLoop();

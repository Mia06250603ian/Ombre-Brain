// telegram-bridge 纯逻辑(不碰网络),test-bridge.mjs 全覆盖

// ---- Telegram 4096 上限切分:先按换行找断点,找不到硬切 ----
export const TG_LIMIT = 4096;
export function splitForTelegram(text, limit = TG_LIMIT) {
  const out = [];
  let rest = (text || "").trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.3) cut = limit; // 断点太靠前不如硬切
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// ---- 重置词识别(逐字镜像 kelivo-shim/server.js 的 detectReset)----
// 用途:重置词消息不许和别的消息合并去抖,否则 shim 侧识别失败、归档丢失。
const GOODNIGHT_WORDS = ["晚安"];
const ARCHIVE_WORDS = ["归档", "换窗口", "开新窗口", "新窗口"];
function stripEnds(s) { return (s || "").trim().replace(/^[\s，,。.!！~～、]+|[\s，,。.!！~～、]+$/g, ""); }
export function detectReset(text) {
  const t = stripEnds(text);
  for (const w of GOODNIGHT_WORDS) if (t === w || (t.length <= 6 && t.startsWith(w))) return "goodnight";
  for (const w of ARCHIVE_WORDS) if (t === w || (t.length <= 8 && t.includes(w))) return "archive";
  return null;
}

// ---- 去抖缓冲合并成一轮 ----
export function mergeTurn(items) {
  const text = items.map((i) => i.text || "").filter(Boolean).join("\n");
  const images = items.flatMap((i) => i.images || []);
  return { text, images };
}

// ---- shim 请求体(shim 只读最后一条 user 消息;system 恒定,避免触发换世界书杀进程)----
export function buildShimBody(turn, { model, system }) {
  const content = turn.images.length
    ? [{ type: "text", text: turn.text }, ...turn.images]
    : turn.text;
  const body = { model, max_tokens: 8192, stream: true, messages: [{ role: "user", content }] };
  if (system) body.system = system;
  return body;
}

// ---- Anthropic SSE 累积器:喂原始 chunk,攒出 text / thinking ----
export function makeSseAccumulator() {
  let buf = "", text = "", thinking = "", done = false;
  function handleData(json) {
    let ev; try { ev = JSON.parse(json); } catch { return; }
    if (ev.type === "content_block_delta") {
      const d = ev.delta || {};
      if (d.type === "text_delta") text += d.text || "";
      else if (d.type === "thinking_delta") thinking += d.thinking || "";
    } else if (ev.type === "message_stop") done = true;
  }
  return {
    feed(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of block.split("\n"))
          if (line.startsWith("data:")) handleData(line.slice(5).trim());
      }
    },
    result() { return { text, thinking, done }; },
  };
}

// ---- HTML 转义(思考走 expandable blockquote 时用;正文永远纯文本发)----
export function escapeHtml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- 白名单 ----
export function isAllowedChat(chatId, allowList) {
  return allowList.includes(String(chatId));
}

// ---- 贴纸标记解析:[贴纸:标签] / 【贴纸:标签】(冒号全半角都认)----
// 认识的标签收进 stickers,不认识的收进 unknown(只删标记不发图,避免原样漏出)。
export function extractStickers(text, tags) {
  const re = /[\[【]\s*贴纸\s*[::]\s*([^\]】\n]+?)\s*[\]】]/g;
  const stickers = [], unknown = [];
  const rest = (text || "").replace(re, (_, tag) => {
    const t = tag.trim();
    (tags.includes(t) ? stickers : unknown).push(t);
    return "";
  });
  return { text: rest.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), stickers, unknown };
}

// ---- Telegram 文件路径 → Anthropic image block 的 media_type ----
const MEDIA = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
export function mediaTypeOf(filePath) {
  const ext = (filePath || "").split(".").pop().toLowerCase();
  return MEDIA[ext] || null;
}

// e2e-dualcli-api.mjs — 假 Anthropic 后端,配合 e2e-dualcli-run.sh 用,零额度。
// 把每次请求的「谁发的、发了什么」记进 $E2E_DIR/calls.json:
//   ver    = user-agent 里的 CLI 版本 —— 双引擎「4.6 走 2.1.215、5.5 走 2.1.280」的硬证据;
//   model  = CLI 真发上去的模型;
//   tt     = 消息里有没有 `<total_tokens>` 那行(新版那份应该被关掉);
//   sys    = 系统提示词前 40 字(认出翻译子进程);tools = 带了几个工具(翻译子进程应为 0)。
// 应答:翻译模型(sonnet)回「【译】+原文」;其余模型回一段**英文思考** + 一句正文。
import http from "http";
import fs from "fs";

const DIR = process.env.E2E_DIR;
const PORT = +(process.env.E2E_API_PORT || 8701);
const calls = [];

function sse(res, events) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}
const lastUserText = (b) => {
  const lu = [...(b.messages || [])].reverse().find((m) => m.role === "user");
  const c = lu?.content;
  return typeof c === "string" ? c : (c || []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
};

http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.url.includes("/v1/messages")) { res.writeHead(200); res.end("{}"); return; }
    let b = {};
    try { b = JSON.parse(body); } catch {}
    const ua = req.headers["user-agent"] || "";
    const all = JSON.stringify(b.messages || []);
    const sysText = Array.isArray(b.system) ? b.system.map((s) => s.text || "").join("") : String(b.system || "");
    const isTranslator = /翻译器/.test(sysText);
    calls.push({ ver: (ua.match(/claude-cli\/([\d.]+)/) || [])[1] || "", model: b.model || "",
                 tt: all.includes("<total_tokens>"), translator: isTranslator,
                 tools: (b.tools || []).length, thinking: b.thinking || null, user: lastUserText(b).slice(-80) });
    fs.writeFileSync(`${DIR}/calls.json`, JSON.stringify(calls, null, 1));
    const u = { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 20 };
    const head = ["message_start", { type: "message_start", message: { id: `msg_${calls.length}`, type: "message", role: "assistant", model: b.model, content: [], stop_reason: null, usage: u } }];
    const tail = [["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: u }], ["message_stop", { type: "message_stop" }]];
    if (isTranslator) {
      const src = lastUserText(b).replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, "").trim();
      sse(res, [head,
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "【译】" + src } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }], ...tail]);
      return;
    }
    sse(res, [head,
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: `I should answer warmly (${b.model}).` } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "reply-" + b.model } }],
      ["content_block_stop", { type: "content_block_stop", index: 1 }], ...tail]);
  });
}).listen(PORT, () => console.error(`[dualcli-api] up :${PORT}`));

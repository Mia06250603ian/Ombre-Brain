// e2e-flag-api.mjs — 假 Anthropic 后端,配合 e2e-flag-run.sh 用,零额度。
// 模拟 5.5 的安全拦截:**5.5 的请求里只要出现 `FLAGME`,就回 `stop_reason: "refusal"`**
// (CLI 2.1.280 看到它就拼出 `Opus 5.5's safeguards flagged this message …`,2026-09-29 扒二进制确认)。
// 其余一律正常回一段思考 + 一句正文 `reply-<模型>`。
// 每次请求记进 $E2E_DIR/calls.json:model、最后一条 user 的文本、整段对话里 FLAGME 出现几次、
// 对话里有哪些轮(user 文本的末尾标记),用来断言「换过去之后被拦那几轮丢了、之前的都在」。
// E2E_FLAG_PARTIAL=1:拦截前先吐半句正文(模拟说到一半被拦)。
import http from "http";
import fs from "fs";

const DIR = process.env.E2E_DIR;
const PORT = +(process.env.E2E_API_PORT || 8711);
const PARTIAL = process.env.E2E_FLAG_PARTIAL === "1";
const calls = [];

function sse(res, events) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}
const textOf = (c) => typeof c === "string" ? c : (c || []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
// 换模型后 CLI 会在下一条前面塞一段自己的 `/model` 记录(caveat + command + stdout),比对轮次时去掉
const strip = (t) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, "")
  .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*/g, "")
  .replace(/<command-name>[\s\S]*?<\/local-command-stdout>\s*/g, "").trim();

http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.url.includes("/v1/messages")) { res.writeHead(200); res.end("{}"); return; }
    let b = {};
    try { b = JSON.parse(body); } catch {}
    const msgs = b.messages || [];
    const users = msgs.filter((m) => m.role === "user").map((m) => strip(textOf(m.content))).filter(Boolean);
    const all = JSON.stringify(msgs);
    const last = users[users.length - 1] || "";
    const flag = b.model === "claude-opus-5-5" && all.includes("FLAGME");
    calls.push({ model: b.model || "", user: last.slice(0, 1500), flagCount: (all.match(/FLAGME/g) || []).length,
                 turns: users.map((u) => u.slice(0, 16)), nudge: all.includes("【系统·补发】"), refused: flag,
                 thinkingBlocks: msgs.filter((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((c) => c.type === "thinking")).length });
    fs.writeFileSync(`${DIR}/calls.json`, JSON.stringify(calls, null, 1));
    const u = { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 20 };
    // set_model 换模型前,CLI 先发一条**非流式**的「Hi」验一下新模型(2026-09-29 e2e 撞到:
    // 回 SSE 会让它报 `Unable to validate model: … ur.usage.input_tokens`)。真接口回 JSON,这里照做。
    if (b.stream !== true) {
      calls[calls.length - 1].validate = true;
      fs.writeFileSync(`${DIR}/calls.json`, JSON.stringify(calls, null, 1));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: `msg_${calls.length}`, type: "message", role: "assistant", model: b.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: u }));
      return;
    }
    const head = ["message_start", { type: "message_start", message: { id: `msg_${calls.length}`, type: "message", role: "assistant", model: b.model, content: [], stop_reason: null, usage: u } }];
    if (flag) {
      const ev = [head];
      if (PARTIAL) ev.push(
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "half-" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }]);
      ev.push(["message_delta", { type: "message_delta", delta: { stop_reason: "refusal", stop_sequence: null }, usage: u }], ["message_stop", { type: "message_stop" }]);
      sse(res, ev);
      return;
    }
    sse(res, [head,
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: `想一想(${b.model})` } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "reply-" + b.model } }],
      ["content_block_stop", { type: "content_block_stop", index: 1 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: u }], ["message_stop", { type: "message_stop" }]]);
  });
}).listen(PORT, "127.0.0.1", () => console.log("fake flag api on", PORT));

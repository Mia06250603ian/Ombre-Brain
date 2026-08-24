// e2e-model-api.mjs — 假 Anthropic 后端,配合 e2e-model-run.sh 用,零额度。
// 与 e2e-fake-api.mjs 的区别:它不放剧本(不管上下文守卫),只干一件事——
// **把每次请求里 CLI 真正发出来的 `model` 记进 $E2E_DIR/models.json**。
// 这才是「切模型有没有真的切到」的硬证据:shim 的 --model 会被 CLI 原样发到上游。
import http from "http";
import fs from "fs";

const DIR = process.env.E2E_DIR;
const PORT = +(process.env.E2E_API_PORT || 8601);
const models = [];

function sse(res, events) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.url.includes("/v1/messages")) { res.writeHead(200); res.end("{}"); return; }
    let model = "";
    try { model = JSON.parse(body).model || ""; } catch {}
    models.push(model);
    fs.writeFileSync(`${DIR}/models.json`, JSON.stringify(models, null, 1));
    // 按模型给不同的占用:4.6 的窗口是「已经聊了很久」的高位,切到 4.5 后是新进程的低位。
    // 这样才能验守卫会不会把「换模型导致的读数暴跌」误判成一次静默压缩(7.2 ⑤)。
    const big = model !== "claude-opus-4-5-20251101";
    const u = { input_tokens: 5, cache_creation_input_tokens: 100,
                cache_read_input_tokens: big ? 60000 : 1000, output_tokens: 20 };
    sse(res, [
      ["message_start", { type: "message_start", message: { id: `msg_${models.length}`, type: "message", role: "assistant", model, content: [], stop_reason: null, usage: u } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: u }],
      ["message_stop", { type: "message_stop" }],
    ]);
  });
}).listen(PORT, () => console.error(`[model-api] up :${PORT}`));

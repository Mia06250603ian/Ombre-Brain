// e2e-fake-api.mjs — 假 Anthropic 后端,配合 e2e-run.sh 用,零额度。
// 按剧本回放响应,并把每次收到的最后一条 user 文本记进 $E2E_DIR/seen.json,
// 供断言"守卫提示有没有注进 prompt"。剧本对应 2026-07-19 线上误报场景
// (软线 30000 / 硬线 60000,由 e2e-run.sh 的环境变量设定)。
import http from "http";
import fs from "fs";

const DIR = process.env.E2E_DIR;
const PORT = +(process.env.E2E_API_PORT || 8501);
const seen = [];

// 每条 = 一次 /v1/messages 调用的应答;u 不带 iterations(复现线上:上游不给该字段)。
const script = [
  // msg1 调用1:工具轮(要求读文件),cc 20000
  { tool: true, u: { in: 5, cc: 20000, cr: 0, out: 30 } },
  // msg1 调用2:收尾。真实窗口 20505;整轮总和 40510 虚超软线 → 老 bug 会在这误报
  { text: "one done", u: { in: 5, cc: 500, cr: 20000, out: 20 } },
  // msg2:窗口涨到 35515,真超软线
  { text: "two done", u: { in: 5, cc: 15005, cr: 20505, out: 20 } },
  // msg3(应带软提示):回落 20005 < 软线九成 → 应触发 softFired 复位
  { text: "three done", u: { in: 5, cc: 0, cr: 20000, out: 20 } },
  // msg4(应无提示):冲到 65010 > 硬线
  { text: "four done", u: { in: 5, cc: 45000, cr: 20005, out: 20 } },
  // msg5(应带硬提示归档指令)
  { text: "five done", u: { in: 5, cc: 100, cr: 65010, out: 20 } },
];
let call = 0;

function sse(res, events) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}
const mkU = (u) => ({ input_tokens: u.in, cache_creation_input_tokens: u.cc, cache_read_input_tokens: u.cr, output_tokens: u.out });

http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.url.includes("/v1/messages")) { res.writeHead(200); res.end("{}"); return; }
    let lastUserText = "";
    try {
      const b = JSON.parse(body);
      const lu = [...(b.messages || [])].reverse().find((m) => m.role === "user");
      const c = lu?.content;
      lastUserText = typeof c === "string" ? c : (c || []).map((x) => (x.type === "text" ? x.text : `<${x.type}>`)).join("|");
    } catch {}
    seen.push(lastUserText);
    fs.writeFileSync(`${DIR}/seen.json`, JSON.stringify(seen, null, 1));
    const step = script[Math.min(call, script.length - 1)]; call++;
    const id = `msg_${call}`, u = mkU(step.u);
    const head = ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-opus-4-6", content: [], stop_reason: null, usage: u } }];
    if (step.tool) {
      sse(res, [head,
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `t_${call}`, name: "Read", input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: `${DIR}/probe.txt` }) } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: u }],
        ["message_stop", { type: "message_stop" }]]);
    } else {
      sse(res, [head,
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: step.text } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: u }],
        ["message_stop", { type: "message_stop" }]]);
    }
  });
}).listen(PORT, () => console.error(`[fake-api] up :${PORT}`));

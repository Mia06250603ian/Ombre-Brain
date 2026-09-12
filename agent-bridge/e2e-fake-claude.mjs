// e2e-fake-claude.mjs — 冒充 `claude -p --output-format stream-json` 的假货。
//
// **为什么要它**:真 claude 每跑一次都烧额度,而这一层要验的东西(起进程、流式、
// 叫停、插话、收工)和模型说什么毫无关系。假货让 e2e 能随便跑几十遍。
//
// 它照真 CLI 的协议行事:
//   - 启动先吐 system/init
//   - 收到 user 消息 → 慢慢吐几段 text_delta → 吐 result
//   - 收到 control_request/interrupt → 立刻停止吐字,回 control_response,
//     补一条 "[Request interrupted by user]" 的 user 帧,再吐 result
//   ⚠️ **这三条是照 2026-09-12 真机实测的行为写的**(见 MAINTENANCE.md《暂停键怎么来的》),
//      真 CLI 哪天变了这里也要跟着改,否则 e2e 绿着而线上是坏的。

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const SLOW = +(process.env.FAKE_GAP_MS || 60);

out({ type: "system", subtype: "init", model: "fake-model", tools: ["Bash"] });

let timer = null;
let turn = 0;

function runTurn(text) {
  const words = ["我", "看", "了", "一", "下", ":", String(text).slice(0, 12), "——", "好", "了"];
  let i = 0;
  timer = setInterval(() => {
    if (i >= words.length) {
      clearInterval(timer); timer = null;
      out({ type: "result", is_error: false, total_cost_usd: 0.01, terminal_reason: "ok" });
      return;
    }
    if (i === 2) {
      out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "curl /health" } }] } });
      out({ type: "user", message: { content: [{ type: "tool_result", is_error: false }] } });
    }
    out({ type: "stream_event", event: { delta: { type: "text_delta", text: words[i++] } } });
  }, SLOW);
}

let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n"); buf = lines.pop() ?? "";
  for (const ln of lines) {
    if (!ln.trim()) continue;
    let j; try { j = JSON.parse(ln); } catch { continue; }
    if (j.type === "user") { turn++; runTurn(j.message?.content || ""); }
    else if (j.type === "control_request" && j.request?.subtype === "interrupt") {
      if (timer) { clearInterval(timer); timer = null; }
      out({ type: "control_response", response: { subtype: "success", request_id: j.request_id, response: {} } });
      out({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } });
      out({ type: "result", is_error: true, total_cost_usd: 0, terminal_reason: "aborted_streaming" });
    }
  }
});

process.stdin.on("end", () => process.exit(0));

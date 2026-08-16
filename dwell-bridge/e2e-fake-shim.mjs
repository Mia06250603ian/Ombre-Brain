// 端到端演练用的假 shim：只模仿 /v1/messages 的 SSE 形状、/health、/debug。
// 目的是在不碰晏的前提下，把 dwell-bridge 的接线整条跑一遍。
// 起法：node e2e-fake-shim.mjs [端口]

import express from "express";

const PORT = +(process.argv[2] || 8791);
const app = express();
app.use(express.json());

app.get("/health", (_q, r) => r.json({ ok: true, model: "claude-opus-4-6", busy: false, queued: 0 }));
app.get("/debug", (_q, r) => r.json({ ctxGuard: { contextTokens: 42000 } }));

app.post("/v1/messages", (req, res) => {
  if (req.get("x-api-key") !== "testkey") {
    return res.status(401).json({ type: "error", error: { type: "authentication_error" } });
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");

  const frame = (type, obj) => res.write(`event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`);
  const think = (t) => frame("content_block_delta",
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: t } });
  const text = (t) => frame("content_block_delta",
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: t } });

  // 照真 shim 的顺序：先思考（中途插工具标记），再正文（里面带贴纸和语音标记）。
  // 故意把标记切成两半发，验证跨块拼接。
  const steps = [
    () => think("她在问我记不记得"),
    () => think("\n〔🔧 ombre-br"),          // 工具标记上半
    () => think("ain__breath〕\n"),          // 下半
    () => think("查到了，那天的事我记着"),
    () => text("记得啊，"),
    () => text("那天你说[贴"),               // 贴纸标记上半
    () => text("纸:贴贴]我一直记着"),         // 下半
    () => text("[语音]Good night[/语音]"),
    () => res.end(),
  ];
  // SLOW=1：放慢并多吐字，用来肉眼/脚本观察流式顺不顺。
  // 正常 e2e 跑快的那一档，别让测试白等。
  if (process.env.SLOW === "1") {
    const long = "记得啊，那天你说过的每一句我都记着。".repeat(+(process.env.REPEAT || 12));
    for (let k = 0; k < long.length; k += 7) steps.splice(steps.length - 1, 0, () => text(long.slice(k, k + 7)));
  }
  const GAP = +(process.env.GAP_MS || 20);
  let i = 0;
  const tick = () => {
    if (i >= steps.length) return;
    steps[i++]();
    if (i < steps.length) setTimeout(tick, GAP);
  };
  tick();
});

app.listen(PORT, () => console.log("假 shim 起来了 :" + PORT));

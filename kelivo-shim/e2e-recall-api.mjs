// e2e-recall-api.mjs — 配合 e2e-recall-run.sh:一个进程起两个假服务,零额度、不碰线上。
//   :8511 假 Anthropic —— 每次都回 "ok",把收到的最后一条 user 文本按顺序记进 seen.json
//   :8512 假 OB /api/recall —— 按关键词回剧本里的旧事,把每次被问的 q/exclude 记进 obseen.json
import http from "http";
import fs from "fs";

const DIR = process.env.E2E_DIR;
const seen = [], obseen = [];

// 关键词 → { 挑中的桶, 故意拖多久(毫秒)}
const OB = [
  { kw: "团子", pick: { id: "tuanzi000001", name: "团子去宠物医院", created: "2026-09-18", excerpt: "团子连着吐了两天。", rare: ["团子"] }, delay: 0 },
  { kw: "阿蟹", pick: { id: "axie00000001", name: "螃蟹玩偶的名字", created: "2026-08-21", excerpt: "她给螃蟹玩偶起名叫阿蟹。", rare: ["阿蟹"] }, delay: 0 },
  { kw: "小雅", pick: { id: "xiaoya000001", name: "和好朋友闹掰", created: "2026-08-06", excerpt: "她和小雅闹掰又和好。", rare: ["小雅"] }, delay: 800 },
  { kw: "慢死了", pick: { id: "slow00000001", name: "不该出现", created: "2026-08-01", excerpt: "超时了还递进去就是 bug。", rare: ["慢死了"] }, delay: 3000 },
];

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
    let t = "";
    try {
      const lu = [...(JSON.parse(body).messages || [])].reverse().find((m) => m.role === "user");
      const c = lu?.content;
      t = typeof c === "string" ? c : (c || []).map((x) => (x.type === "text" ? x.text : `<${x.type}>`)).join("|");
    } catch {}
    seen.push(t);
    fs.writeFileSync(`${DIR}/seen.json`, JSON.stringify(seen, null, 1));
    const u = { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 3 };
    sse(res, [
      ["message_start", { type: "message_start", message: { id: `m${seen.length}`, type: "message", role: "assistant", model: "claude-opus-4-6", content: [], stop_reason: null, usage: u } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: u }],
      ["message_stop", { type: "message_stop" }]]);
  });
}).listen(8511, () => console.error("[fake-api] up :8511"));

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname !== "/api/recall") { res.writeHead(404); res.end(); return; }
  if (req.headers.authorization !== "Bearer e2e-recall") { res.writeHead(401); res.end("{}"); return; }
  const q = u.searchParams.get("q") || "", exclude = (u.searchParams.get("exclude") || "").split(",").filter(Boolean);
  obseen.push({ q, exclude, n: u.searchParams.get("n"), minAge: u.searchParams.get("min_age_hours") });
  fs.writeFileSync(`${DIR}/obseen.json`, JSON.stringify(obseen, null, 1));
  const hit = OB.find((o) => q.includes(o.kw));
  const cooled = hit && exclude.includes(hit.pick.id);
  const out = !hit ? { pick: null, reason: "empty", candidates: [] }
    : cooled ? { pick: null, reason: "no_trusted_hit", candidates: [{ id: hit.pick.id, name: hit.pick.name, score: 55, rare: hit.pick.rare, skip: "cooldown" }] }
    : { pick: hit.pick, reason: "ok", candidates: [{ id: hit.pick.id, name: hit.pick.name, score: 55, rare: hit.pick.rare, skip: "" }] };
  setTimeout(() => {
    try { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(out)); } catch {}
  }, hit ? hit.delay : 0);
}).listen(8512, () => console.error("[fake-ob] up :8512"));

// 演练:夜里查岗 / 写信提醒「她最后在 iMessage 就交给 imessage-bridge 发」(2026-09-26)。**不碰线上、不要钥匙。**
//   cd telegram-bridge && npm i --no-save express >/dev/null && node tools/e2e-route.mjs
// 真 server.js + 假 Telegram(拦 globalThis.fetch)+ 假 shim(HTTPS 监听 443:shimTurn 只取 hostname、不取端口,
// 见手册设计要点 20 的演练说明)+ 假 imessage-bridge /push。需要 root(443)和 openssl(自签证书)。
import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
const eq = (name, got, want) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) pass++; else { fail++; console.log(`✗ ${name}\n   got  ${g}\n   want ${w}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); } return false; }

// ---- 自签证书 + 假 shim(443)----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tg-route-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-days", "1",
  "-keyout", path.join(tmp, "k.pem"), "-out", path.join(tmp, "c.pem")], { stdio: "ignore" });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
let lastClient = "imessage", shimReply = () => "还不睡?";
const shimReqs = [];
https.createServer({ key: fs.readFileSync(path.join(tmp, "k.pem")), cert: fs.readFileSync(path.join(tmp, "c.pem")) }, (req, res) => {
  if (req.url === "/debug") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ presence: { lastClient } })); return; }
  let b = ""; req.on("data", (d) => (b += d)).on("end", () => {
    const j = JSON.parse(b); shimReqs.push({ sys: req.headers["x-system-turn"], text: j.messages[0].content });
    const text = shimReply(j.messages[0].content);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}\n\ndata: {"type":"message_stop"}\n\n`);
  });
}).listen(443, "127.0.0.1");

// ---- 假 imessage-bridge /push ----
let pushStatus = 200; const pushes = [];
const im = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)).on("end", () => { pushes.push({ key: req.headers["x-api-key"], text: JSON.parse(b).text }); res.writeHead(pushStatus).end("{}"); }); });
await new Promise((r) => im.listen(0, "127.0.0.1", r));

// ---- 假 Telegram ----
const tgSent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith("https://api.telegram.org/")) {
    const method = u.split("/").pop().split("?")[0];
    if (method === "getUpdates") { await sleep(500); return new Response(JSON.stringify({ ok: true, result: [] })); }
    if (method === "sendMessage") tgSent.push(JSON.parse(opts.body).text);
    return new Response(JSON.stringify({ ok: true, result: {} }));
  }
  return realFetch(url, opts);
};

// ---- 起真 server.js,让「现在」落在宵禁里,检查节拍 3 秒 ----
const bjH = (new Date().getUTCHours() + 8) % 24;
const PORT = 19000 + Math.floor(Math.random() * 500);
Object.assign(process.env, {
  PORT: String(PORT), TELEGRAM_BOT_TOKEN: "x", TELEGRAM_CHAT_ID: "42", SHIM_KEY: "k", SHIM_URL: "https://127.0.0.1",
  REPORT_TOKEN: "r", CURFEW_START: String(bjH), CURFEW_END: String((bjH + 1) % 24), CURFEW_CHECK_MIN: "0.05",
  CURFEW_COOLDOWN_MIN: "0", LETTER_ON: "0", NOTICE_ON: "0",
  IMESSAGE_PUSH_URL: `http://127.0.0.1:${im.address().port}/push`,
});
process.chdir(path.join(path.dirname(new URL(import.meta.url).pathname), ".."));
await import("../server.js");
await sleep(500);
const report = (app) => realFetch(`http://127.0.0.1:${PORT}/report`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer r" }, body: JSON.stringify({ app_name: app }) });
const reset = () => { shimReqs.length = 0; pushes.length = 0; tgSent.length = 0; };
async function poke(app) { reset(); await report(app); await until(() => shimReqs.length > 0); await sleep(1500); }

// A:她最后在 iMessage、那边接住 → 只在 iMessage 出现
lastClient = "imessage"; pushStatus = 200; shimReply = () => "还不睡?";
await poke("小红书");
eq("A 查岗是系统回合", shimReqs[0]?.sys, "1");
eq("A iMessage 收到", pushes.map((p) => p.text), ["还不睡?"]);
eq("A 带 SHIM_KEY", pushes[0]?.key, "k");
eq("A Telegram 一句都没发", tgSent, []);

// B:她最后不在 iMessage → 只在 Telegram
lastClient = null;
await poke("抖音");
eq("B iMessage 没被碰", pushes, []);
eq("B Telegram 照发", tgSent, ["还不睡?"]);

// C:她在 iMessage 但那边接不住(503)→ 退回 Telegram
lastClient = "imessage"; pushStatus = 503;
await poke("淘宝");
eq("C 试过 iMessage", pushes.length, 1);
eq("C 退回 Telegram", tgSent, ["还不睡?"]);

// D:他回「。」→ 哪边都不发
pushStatus = 200; shimReply = () => "。";
await poke("微博");
eq("D iMessage 不发", pushes, []);
eq("D Telegram 不发", tgSent, []);

// E:交给 iMessage 的那轮写了 [查岗] → 原文交过去,Telegram 这边不再查一遍
shimReply = () => "[查岗]在干嘛";
await poke("B站");
await sleep(2000);
eq("E 原文(含标记)交给 iMessage", pushes.map((p) => p.text), ["[查岗]在干嘛"]);
eq("E Telegram 没有再起一轮查岗", shimReqs.length, 1);
eq("E Telegram 一句都没发", tgSent, []);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n路由演练 ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

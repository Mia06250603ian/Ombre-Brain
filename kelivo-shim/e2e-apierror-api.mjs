// e2e-apierror-api.mjs — 假 Anthropic 后端「一直 401」版,配合 e2e-apierror-run.sh 用,零额度。
// 复刻 2026-08-11 那场事故的上游形态:CLIProxyAPI 手里的订阅 OAuth 过期,
// /v1/messages 一律 401 authentication_error。CLI 会重试若干次,最后把报错
// 做成一条 assistant 消息吐出来(而 result 仍报 success)——这正是要验的那一格。
import http from "http";
import fs from "fs";

const DIR = process.env.E2E_DIR;
const PORT = +(process.env.E2E_API_PORT || 8503);
let calls = 0;

http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.url.includes("/v1/messages")) { res.writeHead(200); res.end("{}"); return; }
    calls++;
    fs.writeFileSync(`${DIR}/calls.txt`, String(calls));
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      type: "error",
      error: { type: "authentication_error", message: "OAuth access token has expired. Re-authenticate to continue." },
    }));
  });
}).listen(PORT, () => console.error(`[fake-401] up :${PORT}`));

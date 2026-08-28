// chess-web —— 把 player 那个飞行棋挂成一个带口令的网页。
//
//   她的手机浏览器 ──HTTPS + 口令(cookie)──> chess-web ──> 发 game/ 里的三个文件
//
// **它不碰晏、不碰 shim、不碰记忆库、不联任何网。** 它只做一件事：
// 检查口令，然后把静态文件递出去。这也是它敢单独上线的全部理由。
//
// 零依赖（只用 node 内置模块）：装不了包就出不了包的问题，内存也压到最低。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME_DIR = path.join(HERE, "game");
const PORT = +(process.env.PORT || 8080);
const PASS = process.env.CHESS_PASS || "";

// 盐每次启动换一把：重启 = 已登录的会话全失效。对这种自用页面正是想要的。
const SALT = crypto.randomBytes(16).toString("hex");
const TOKEN = crypto.createHmac("sha256", SALT).update(PASS).digest("hex").slice(0, 32);

const log = (...a) => console.log(new Date().toISOString(), ...a);
if (!PASS) log("⚠️ CHESS_PASS 没设——**页面没有锁**，别就这样挂公网");

// 只发这几种；game/ 里本来也只有 html 和 js
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function authed(req) {
  if (!PASS) return true;                       // 没设口令=不锁（只该出现在本地调试）
  const m = /(?:^|;\s*)chess=([^;]+)/.exec(req.headers.cookie || "");
  return !!m && safeEqual(decodeURIComponent(m[1]), TOKEN);
}

const LOGIN_PAGE = (err) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>飞行棋</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#f9f9f6;color:#23231f;
     font-family:system-ui,-apple-system,"PingFang SC",sans-serif}
@media(prefers-color-scheme:dark){body{background:#20201f;color:#ebebe4}}
form{display:flex;flex-direction:column;gap:14px;width:min(300px,84vw)}
h1{font-size:17px;font-weight:600;margin:0 0 4px;text-align:center}
input{padding:13px 15px;font-size:16px;border-radius:10px;border:1px solid #ecece6;
      background:#fff;color:inherit}
@media(prefers-color-scheme:dark){input{background:#131312;border-color:#3d3d3a}}
button{padding:13px;font-size:15px;border:0;border-radius:10px;background:#e1734f;color:#fff;font-weight:600}
p{margin:0;text-align:center;font-size:13px;color:#c0392b;min-height:18px}
</style>
<form method="POST" action="/login">
  <h1>飞行棋</h1>
  <input type="password" name="pass" placeholder="口令" autofocus autocomplete="current-password">
  <button>进去</button>
  <p>${err ? "口令不对" : ""}</p>
</form>`;

function send(res, code, type, body, extra = {}) {
  res.writeHead(code, {
    "content-type": type,
    // 这个页面不该被任何中间层缓存或索引
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
    "referrer-policy": "no-referrer",
    ...extra,
  });
  res.end(body);
}

// 把 URL 化成 game/ 里的一个真实文件，越界一律 null
function resolveInGame(urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  const abs = path.resolve(GAME_DIR, "." + rel);
  // ⚠️ 承重：`../` 拼出来的路径必须落在 game/ 里面，否则能把服务器上任何文件读走
  if (abs !== GAME_DIR && !abs.startsWith(GAME_DIR + path.sep)) return null;
  if (!TYPES[path.extname(abs).toLowerCase()]) return null;
  return abs;
}

const server = http.createServer((req, res) => {
  const url = req.url || "/";

  // 存活检查：不过口令，也不含任何密钥
  if (req.method === "GET" && url.split("?")[0] === "/health") {
    let files = [];
    try { files = fs.readdirSync(GAME_DIR); } catch {}
    return send(res, 200, TYPES[".json"], JSON.stringify({
      ok: true, locked: !!PASS, files: files.length, ready: files.includes("index.html"),
    }));
  }

  if (req.method === "POST" && url.split("?")[0] === "/login") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 4096) req.destroy();     // 别让人拿超大 body 灌爆
    });
    req.on("end", () => {
      const pass = new URLSearchParams(body).get("pass") || "";
      if (!PASS || !safeEqual(pass, PASS)) {
        log("[login] 口令不对");
        return send(res, 401, TYPES[".html"], LOGIN_PAGE(true));
      }
      // Secure 只在真走 HTTPS 时加：Zeabur 在外层收 TLS、进容器是 http，
      // 靠 x-forwarded-proto 判断。本地 http 调试时不加，否则浏览器根本不存这块 cookie。
      const https = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
      send(res, 302, TYPES[".html"], "", {
        "set-cookie": `chess=${TOKEN}; Path=/; HttpOnly; SameSite=Lax;${https ? " Secure;" : ""} Max-Age=2592000`,
        location: "/",
      });
    });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, TYPES[".json"], JSON.stringify({ ok: false, err: "method" }));
  }

  if (!authed(req)) return send(res, 401, TYPES[".html"], LOGIN_PAGE(false));

  const file = resolveInGame(url);
  if (!file) return send(res, 404, TYPES[".json"], JSON.stringify({ ok: false, err: "not_found" }));

  fs.readFile(file, (err, buf) => {
    if (err) {
      // game/ 是空的 = 部署时忘了跑 fetch-game.sh。说清楚，别让她对着 404 猜
      const hint = fs.existsSync(GAME_DIR) ? "" : "（game/ 不存在：部署前忘了跑 fetch-game.sh）";
      return send(res, 404, TYPES[".html"],
        `<meta charset="utf-8"><p style="font-family:system-ui;padding:24px">游戏文件还没放进来 ${hint}</p>`);
    }
    send(res, 200, TYPES[path.extname(file).toLowerCase()], buf);
  });
});

// 只在直接启动时监听；被 import（单测）时不占端口
if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, () => log(`chess-web 起来了 :${PORT}${PASS ? "" : "（⚠️ 没上锁）"}`));
}

export { server, resolveInGame, safeEqual, GAME_DIR };

// chess-web 单测。跑法：node test-chess.mjs
// 钉住三件承重的事：① 口令真的拦得住 ② 路径穿不出 game/ ③ 补丁找不到锚点会停下

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inject, injectBoards } from "./inject-copy.mjs";
import { extractBoards, boardsToLiteral } from "./extract-boards.mjs";

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log("  ✓", name); pass++; }
  catch (e) { console.error("  ✗", name, "\n     ", e.message); fail++; }
}
async function okA(name, fn) {
  try { await fn(); console.log("  ✓", name); pass++; }
  catch (e) { console.error("  ✗", name, "\n     ", e.message); fail++; }
}

/* ── 注入器 ───────────────────────────────────────────── */
const GOOD_HTML = [
  "<html><body>",
  "<script>",
  "function playerRoll() {}",
  "function aiRoll() { return null; }",
  "window.flightChessBuildInjectPrompt = function (ev) { return ''; };",
  "</scr" + "ipt>",
  "</body></html>",
].join("\n");
const PATCH = fs.readFileSync(new URL("./copy-to-yan.js", import.meta.url), "utf8");

console.log("注入器");
ok("正常注入：标记和补丁都进去了", () => {
  const out = inject(GOOD_HTML, PATCH);
  assert(out.includes("__YAN_COPY_PATCH__"), "缺补丁标记");
  assert(out.includes("__yanCopyReady"), "缺补丁正文");
  assert(out.indexOf("__YAN_COPY_PATCH__") < out.lastIndexOf("</body>"), "没插在 </body> 前");
});
ok("原文一个字不动地保留在前面", () => {
  const out = inject(GOOD_HTML, PATCH);
  assert(out.startsWith("<html><body>"), "开头被改了");
  assert(out.includes("function aiRoll() { return null; }"), "游戏代码被改了");
});
for (const [gone, why] of [
  ["window.flightChessBuildInjectPrompt", "注入词生成器"],
  ["function aiRoll(", "小机掷骰"],
  ["function playerRoll(", "你掷骰"],
]) {
  ok(`游戏少了「${why}」→ 抛错不硬上`, () => {
    assert.throws(() => inject(GOOD_HTML.replace(gone, "XX_gone_XX"), PATCH), /找不到/);
  });
}
ok("没有 </body> → 抛错不猜", () => {
  const noBody = GOOD_HTML.replace("</body></html>", "</html>");
  assert.throws(() => inject(noBody, PATCH), /<\/body>/);
});
ok("已经打过补丁 → 拒绝再注一遍", () => {
  assert.throws(() => inject(inject(GOOD_HTML, PATCH), PATCH), /已经打过/);
});
ok("补丁里含 </script> → 拒绝（会切断脚本块）", () => {
  assert.throws(() => inject(GOOD_HTML, "var x = '</scr" + "ipt>';"), /script/);
});
ok("补丁正文里确实没有 </script>", () => {
  assert(!/<\/script/i.test(PATCH), "copy-to-yan.js 里出现了 </script>");
});

/* ── 棋盘抠取（2026-08-28 补：上一版漏测了「换版本」，所有者报的 bug） ── */
console.log("棋盘抠取");
const REAL_INDEX = fs.existsSync(new URL("./game/index.html", import.meta.url))
  ? fs.readFileSync(new URL("./game/index.html", import.meta.url), "utf8") : null;

const FAKE_INDEX = [
  "<script>",
  "function makeCells(list) {",
  "  return list.map(function (t, i) {",
  "    var type = 'normal', backSteps = 0, jumpTo = null;",
  "    var m = t.match(/后进\\s*(\\d+)\\s*格/);",
  "    if (m) { type = 'special'; backSteps = parseInt(m[1], 10); }",
  "    return { text: t, type: type, backSteps: backSteps, jumpTo: jumpTo };",
  "  });",
  "}",
  "const BOARDS = {",
  "  maid: { name: '女仆版', cells: makeCells(['起点','甲','后进3格','终点']) },",
  "  sm:   { name: 'SM版',  cells: makeCells(['起点','乙','后进2格','终点']) },",
  "};",
  "</scr" + "ipt>",
].join("\n");

ok("抠得出版本、名字、格子", () => {
  const b = extractBoards(FAKE_INDEX);
  assert.deepEqual(Object.keys(b).sort(), ["maid", "sm"]);
  assert.equal(b.sm.name, "SM版");
  assert.equal(b.maid.cells.length, 4);
});
ok("后退格解析出来了（旧版 makeCells 会漏掉这个）", () => {
  const b = extractBoards(FAKE_INDEX);
  assert.equal(b.maid.cells[2].backSteps, 3);
  assert.equal(b.sm.cells[2].backSteps, 2);
});
ok("抠到旧版 makeCells（不给 backSteps）→ 抛错不硬上", () => {
  const oldOne = FAKE_INDEX.replace(/if \(m\) \{[^}]*\}/, "");
  assert.throws(() => extractBoards(oldOne), /后进X格|旧版/);
});
ok("功能页里没有 BOARDS → 抛错", () => {
  assert.throws(() => extractBoards(FAKE_INDEX.replace("const BOARDS = {", "const XX = {")), /BOARDS/);
});
ok("功能页里没有 makeCells → 抛错", () => {
  assert.throws(() => extractBoards(FAKE_INDEX.replace("function makeCells", "function xx")), /makeCells/);
});
ok("嵌进 <script> 前 `<` 被转义（不然能把脚本块切断）", () => {
  const lit = boardsToLiteral({ x: { name: "</scr" + "ipt>", cells: [] } });
  assert(!/<\/script/i.test(lit), "没转义");
  assert.deepEqual(JSON.parse(lit).x.name, "</scr" + "ipt>", "转义之后解析不回来了");
});
if (REAL_INDEX) {
  ok("真功能页：九个版本一个不少", () => {
    const b = extractBoards(REAL_INDEX);
    assert.deepEqual(Object.keys(b).sort(),
      ["advanced","butler","couple","foreplay","love","maid","private","private_adv","sm"]);
  });
  ok("真功能页：每个版本都有后退格或跳转格", () => {
    const b = extractBoards(REAL_INDEX);
    for (const k of Object.keys(b)) {
      const n = b[k].cells.filter((c) => c.backSteps > 0 || c.jumpTo != null).length;
      assert(n > 0, `${k} 一个特殊格都没有`);
    }
  });
} else {
  console.log("  · 跳过「真功能页」两项（game/ 还没拉，跑 ./fetch-game.sh 后再测）");
}

console.log("棋盘注入");
const POPUP = [
  "<html><body>",
  "<script>",
  "const CURRENT_BOARD = {",
  "  key: 'maid', name: '女仆版', cells: []",
  "};",
  "function playerRoll() {}",
  "function aiRoll() { return null; }",
  "window.flightChessBuildInjectPrompt = function (ev) { return ''; };",
  "</scr" + "ipt>",
  "</body></html>",
].join("\n");

ok("注入后 CURRENT_BOARD 改成「先查存档、查不到再用原来那份」", () => {
  const out = injectBoards(POPUP, extractBoards(FAKE_INDEX));
  assert(out.includes("const CURRENT_BOARD = (window.__pickBoard && window.__pickBoard()) || {"), "没改成兜底写法");
  assert(out.includes("key: 'maid', name: '女仆版'"), "原来那份字面量被改掉了（它是兜底，必须原样留着）");
});
ok("棋盘数据插在游戏脚本之前（__pickBoard 必须先存在）", () => {
  const out = injectBoards(POPUP, extractBoards(FAKE_INDEX));
  assert(out.indexOf("__CHESS_BOARDS__") < out.indexOf("const CURRENT_BOARD"), "顺序反了");
});
ok("弹窗页里找不到 CURRENT_BOARD → 抛错不硬上", () => {
  assert.throws(() => injectBoards(POPUP.replace("const CURRENT_BOARD = {", "const XX = {"),
    extractBoards(FAKE_INDEX)), /找不到/);
});
ok("已经接过棋盘数据 → 拒绝再注一遍", () => {
  const once = injectBoards(POPUP, extractBoards(FAKE_INDEX));
  assert.throws(() => injectBoards(once, extractBoards(FAKE_INDEX)), /已经接过/);
});

/* ── 服务器 ───────────────────────────────────────────── */
// 起一个真服务，用真 HTTP 打它。口令固定为测试值，跟线上无关。
process.env.CHESS_PASS = "test-pass-123";
process.env.PORT = "0";
const { server, resolveInGame, GAME_DIR } = await import("./server.js");

console.log("路径解析（穿不穿得出 game/）");
ok("根路径 → index.html", () => {
  assert.equal(resolveInGame("/"), path.join(GAME_DIR, "index.html"));
});
ok("普通文件解析得到", () => {
  assert.equal(resolveInGame("/float-window.js"), path.join(GAME_DIR, "float-window.js"));
});
for (const bad of [
  "/../server.js", "/../../etc/passwd", "/..%2fserver.js",
  "/%2e%2e/%2e%2e/etc/passwd", "/game/../../server.js",
]) {
  ok(`穿越被挡：${bad}`, () => assert.equal(resolveInGame(bad), null));
}
ok("不认识的后缀被挡：/x.env", () => assert.equal(resolveInGame("/x.env"), null));
ok("查询串不影响解析", () => {
  assert.equal(resolveInGame("/index.html?v=2"), path.join(GAME_DIR, "index.html"));
});

// 造一份假 game/，让静态那条路有东西可发
const realGame = fs.existsSync(GAME_DIR);
if (!realGame) {
  fs.mkdirSync(GAME_DIR, { recursive: true });
  fs.writeFileSync(path.join(GAME_DIR, "index.html"), "<h1>假的功能页</h1>");
}

await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const get = (p, opt) => fetch(base + p, { redirect: "manual", ...opt });

console.log("口令");
await okA("没 cookie → 根路径给登录页，不是游戏", async () => {
  const r = await get("/");
  assert.equal(r.status, 401);
  const t = await r.text();
  assert(t.includes('name="pass"'), "不是登录页");
  assert(!t.includes("假的功能页"), "没登录就把游戏发出去了");
});
await okA("没 cookie → 直接要 .js 也拿不到", async () => {
  assert.equal((await get("/float-window.js")).status, 401);
});
await okA("口令错 → 401", async () => {
  const r = await get("/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "pass=wrong",
  });
  assert.equal(r.status, 401);
  assert(!/set-cookie/i.test([...r.headers.keys()].join(",")), "口令错了还发 cookie");
});
let cookie = "";
await okA("口令对 → 发 cookie 并跳回首页", async () => {
  const r = await get("/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "pass=" + encodeURIComponent("test-pass-123"),
  });
  assert.equal(r.status, 302);
  const sc = r.headers.get("set-cookie") || "";
  assert(sc.includes("chess="), "没发 cookie");
  assert(sc.includes("HttpOnly"), "cookie 少了 HttpOnly");
  assert(!sc.includes("Secure"), "本地 http 不该加 Secure（浏览器会不存）");
  cookie = sc.split(";")[0];
});
await okA("带 cookie → 拿得到游戏", async () => {
  const r = await get("/", { headers: { cookie } });
  assert.equal(r.status, 200);
  assert((await r.text()).length > 0);
});
await okA("伪造 cookie → 401", async () => {
  assert.equal((await get("/", { headers: { cookie: "chess=deadbeef" } })).status, 401);
});
await okA("走 HTTPS 时 cookie 带 Secure", async () => {
  const r = await get("/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": "https" },
    body: "pass=" + encodeURIComponent("test-pass-123"),
  });
  assert((r.headers.get("set-cookie") || "").includes("Secure"), "HTTPS 下没加 Secure");
});

console.log("其他");
await okA("/health 不过口令、也不吐密钥", async () => {
  const r = await get("/health");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.locked, true);
  assert(!JSON.stringify(j).includes("test-pass-123"), "/health 把口令吐出来了");
});
await okA("穿越请求打到真服务上也是 404，不是文件内容", async () => {
  const r = await get("/../server.js", { headers: { cookie } });
  assert.notEqual(r.status, 200);
});
await okA("不认识的方法 → 405", async () => {
  assert.equal((await get("/", { method: "DELETE", headers: { cookie } })).status, 405);
});
await okA("响应头带 no-store / noindex", async () => {
  const r = await get("/", { headers: { cookie } });
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert(/noindex/.test(r.headers.get("x-robots-tag") || ""));
});

server.close();
if (!realGame) fs.rmSync(GAME_DIR, { recursive: true, force: true });

console.log(`\n${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);

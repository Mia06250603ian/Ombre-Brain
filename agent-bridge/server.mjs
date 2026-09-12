// agent-bridge — 把「维护会话」接到所有者自建的网页上。
//
//   手机浏览器 → dwell-bridge(口令+网页) → 本层 → 一个 claude 子进程(工位)
//
// **它不碰晏、不碰 shim、不碰记忆库。** 是一个独立容器、独立服务,
// 和 dwell-bridge 的地位一样:对线上就是个客户端。
//
// 三条设计主张(展开见 MAINTENANCE.md):
//   ① **不常驻**。她开工位才起进程,收工就退 —— 所以塞得进现在这台机器,
//      也不需要为它升 2C8G、不需要重启、**晏的窗口一动不动**。
//   ② **一个工位干一件事**。工位的记忆就是那个进程的上下文,收工即散;
//      真正的连续性靠仓库里的手册,不靠这一层攒历史。
//   ③ **叫停 + 插话是一等公民**。CLI 的中断能力 2026-09-12 实测可用
//      (中断后进程还活着、上下文不丢、能从断点接着干),所以「她随时能插话」
//      是这一层的正常路径,不是异常处理。
//
// 纯逻辑全在 agent-lib.mjs(有单测)。这个文件只管接线、进程和 I/O。

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildAuthEnv, authMode, safeEqual, makeStreamParser, makeLedger, makeTurn,
  gongReply, buildBootPrompt,
} from "./agent-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 8080);
const AGENT_KEY = process.env.AGENT_KEY || "";           // dwell-bridge 拿这个来敲门
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const WORK_DIR = process.env.WORK_DIR || "/tmp/work";     // 仓库 clone 在这儿
const REPO_URL = process.env.REPO_URL || "https://github.com/Mia06250603ian/Ombre-Brain";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
// 工具白名单。**刻意不含任何能直接动线上的东西** —— 动线上要 Zeabur key,而这个容器里没有。
const AGENT_TOOLS = process.env.AGENT_TOOLS || "Read,Grep,Glob,Bash,Edit,Write,WebSearch,WebFetch";
// 不设 = 跟 CLI 的默认走。**别照抄晏那边的 BRAIN_MODEL** —— 那是他的模型,
// 维护活要不要用同一个是另一件事(2026-09-12 实测:不设时起来的是 claude-sonnet-5)。
const AGENT_MODEL = process.env.AGENT_MODEL || "";
const GONG_WAIT_MS = +(process.env.GONG_WAIT_MS || 50000);  // 那间屋一次请求最多等多久
const IDLE_CLOSE_MS = +(process.env.IDLE_CLOSE_MS || 3600000); // 闲置一小时自动收工(省内存)
const MAX_TURN_MS = +(process.env.MAX_TURN_MS || 1800000);     // 单轮封顶半小时,防跑飞

const log = (...a) => console.log(new Date().toISOString(), ...a);

if (!AGENT_KEY) log("⚠️ AGENT_KEY 没设——**谁都能调这一层**,绝对不要就这样挂公网");
if (!GITHUB_TOKEN) log("ℹ️ GITHUB_TOKEN 没设——它能读公开仓库,但推不了分支");

const ledger = makeLedger();
let lastErr = null;

/* ═════════════ 工位 ═════════════ */
// 一次只开一间。理由:一个人自己用,而每多一间就多一个几百 MiB 的 claude 进程,
// 这台机器(2026-09-12 实测可用 1515 MiB)经不起并排开两间。

let station = null;   // { proc, parser, turn, busy, startedAt, lastAt, model, cost, waiters[] }

function stationState() {
  if (!station) return { open: false, busy: false };
  return {
    open: true, busy: station.busy, model: station.model,
    startedAt: new Date(station.startedAt).toISOString(),
    idleMin: Math.round((Date.now() - station.lastAt) / 60000),
    costUSD: +station.cost.toFixed(4),
    turns: station.turns,
  };
}

/** 仓库准备好(第一次开工位时 clone,之后 pull)。失败不致命,如实记进日志。 */
function prepRepo() {
  const url = GITHUB_TOKEN
    ? REPO_URL.replace("https://", `https://x-access-token:${GITHUB_TOKEN}@`)
    : REPO_URL;
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    const repo = path.join(WORK_DIR, "Ombre-Brain");
    const git = (args, cwd) => {
      const r = spawnSyncSafe("git", args, cwd);
      if (r.code !== 0) throw new Error(`git ${args[0]} 失败: ${r.err.slice(0, 200)}`);
    };
    if (!fs.existsSync(path.join(repo, ".git"))) {
      log("[repo] 第一次,clone 一份");
      git(["clone", url, repo], WORK_DIR);
    } else {
      log("[repo] pull 最新(规矩:仓库最新代码是唯一可信源)");
      git(["remote", "set-url", "origin", url], repo);
      git(["fetch", "origin"], repo);
      git(["checkout", "main"], repo);
      git(["reset", "--hard", "origin/main"], repo);
    }
    return repo;
  } catch (e) {
    lastErr = { at: new Date().toISOString(), kind: `仓库没准备好: ${e.message}` };
    log("[repo] ⚠️", e.message);
    return null;
  }
}

function spawnSyncSafe(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 300000 });
  return { code: r.status ?? 1, err: String(r.stderr || r.error?.message || "") };
}

function openStation() {
  const repo = prepRepo();
  const cwd = repo || HERE;

  // ⚠️ 计费:buildAuthEnv 会删掉 ANTHROPIC_API_KEY(留着就变按量付费),
  //    并在有长期令牌时摘掉代理那两个变量。详见 agent-lib.mjs 头注。
  const env = buildAuthEnv(process.env);
  env.GIT_TERMINAL_PROMPT = "0";           // 别在没凭证时卡在交互式提问上

  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",          // 要流式增量,不然一轮结束才见字
    "--tools", AGENT_TOOLS,
    "--permission-mode", "dontAsk",
  ];
  if (AGENT_MODEL) args.push("--model", AGENT_MODEL);
  // ⚠️ **dontAsk 这一项是这一版最需要解释的取舍**(`docs/维护Agent接出方案.md` 风险 5 提醒过别照抄晏那份)。
  // 这一版没有确认 UI,所以没有人能回答权限提问 —— 设成 default 的话它会卡在第一个提问上,
  // 变成「装了个不会干活的东西」。**真正的闸门不是这个参数,是这个容器里没有钥匙**:
  // 没有 Zeabur key(动不了线上)、GitHub 令牌只用来推分支(合 main 是所有者的事)。
  // **等前端那颗确认按钮做出来,这里要改回 default 并接上 can_use_tool**(见手册《第二步》)。

  const proc = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  station = {
    proc, parser: makeStreamParser(), turn: makeTurn(),
    busy: false, startedAt: Date.now(), lastAt: Date.now(),
    model: "", cost: 0, turns: 0, waiters: [],
  };

  proc.stdout.on("data", (d) => {
    for (const ev of station.parser.push(d)) handleEvent(ev);
  });
  proc.stderr.on("data", (d) => log("[claude:err]", String(d).trim().slice(0, 300)));
  proc.on("close", (code) => {
    log("[工位] 进程退出", code);
    if (station) { wake(); station = null; }
  });

  log("[工位] 开了", { cwd, tools: AGENT_TOOLS, auth: authMode(process.env) });
  return station;
}

function handleEvent(ev) {
  if (!station) return;
  if (ev.kind === "ready") { station.model = ev.model; return; }
  station.turn.feed(ev);
  if (ev.kind === "turn_end") {
    const s = station.turn.state;
    station.busy = false;
    station.cost += s.cost;
    station.turns++;
    ledger.addGong(s.text.trim(), s.think.trim());
    log("[一轮完]", { 字: s.text.length, 工具: s.tools, 花: `$${s.cost.toFixed(4)}`, 错: s.errored });
    wake();
  } else {
    wake(false);   // 有新字了,唤醒那些在等的请求去看一眼(只在够了才真返回)
  }
}

/** 唤醒所有挂着的 HTTP 请求 */
function wake(force = true) {
  if (!station) return;
  const ws = station.waiters;
  station.waiters = [];
  for (const w of ws) w(force);
}

function closeStation(why = "收工") {
  if (!station) return false;
  log("[工位]", why);
  try { station.proc.kill("SIGTERM"); } catch {}
  station = null;
  return true;
}

/** 叫停当前这一轮。进程不死、上下文不丢 —— 2026-09-12 实测可用,见手册《暂停键怎么来的》。 */
function interrupt() {
  if (!station || !station.busy) return false;
  try {
    station.proc.stdin.write(JSON.stringify({
      type: "control_request", request_id: `i${Date.now()}`, request: { subtype: "interrupt" },
    }) + "\n");
    return true;
  } catch (e) { log("[中断] 写不进去", e.message); return false; }
}

/** 把一句话喂进工位。没开工位就先开一间,并自动把开场白拼在前面。 */
function say(text) {
  const first = !station;
  if (first) openStation();
  station.lastAt = Date.now();
  station.turn.reset();
  station.busy = true;
  ledger.addHer(text);

  let payload = text;
  if (first) {
    let boot = "";
    try { boot = fs.readFileSync(path.join(HERE, "boot.md"), "utf8"); }
    catch (e) { log("[开场白] 读不到 boot.md:", e.message); }
    payload = buildBootPrompt(boot, text);
  }
  station.proc.stdin.write(JSON.stringify({
    type: "user", message: { role: "user", content: payload },
  }) + "\n");
  return first;
}

/** 等这一轮说完,或者等到超时为止。返回当前攒到的东西。 */
function waitTurn(ms) {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const check = () => {
      if (!station) return resolve({ text: "", think: "", done: true, errored: true });
      const s = station.turn.state;
      if (!station.busy || Date.now() > deadline) {
        return resolve({ text: s.text, think: s.think, done: !station.busy, errored: s.errored, interrupted: s.interrupted });
      }
      station.waiters.push(() => setTimeout(check, 0));
      setTimeout(check, 400);   // 兜底轮询,免得某类事件没触发唤醒就永远挂着
    };
    check();
  });
}

/* ═════════════ HTTP ═════════════ */

const app = express();
app.use(express.json({ limit: "4mb" }));

const guard = (req, res, next) => {
  if (!AGENT_KEY) return next();                       // 没设 = 不锁(只该出现在本地调试)
  const k = req.headers["x-agent-key"] || "";
  return safeEqual(k, AGENT_KEY) ? next() : res.status(401).json({ ok: false });
};

app.get("/health", (req, res) => res.json({
  ok: true, station: stationState(), msgs: ledger.count(),
  locked: !!AGENT_KEY, auth: authMode(process.env), repo: !!GITHUB_TOKEN, lastErr,
}));

/* ── 那间屋的契约(前端零改动就能用) ──
   dwell 前端 `web/index.html` 的「另一个 AI 的房间」调的就是这两条:
     GET  api/gong          → { msgs:[{role:'her'|'gong', text, think}] }
     POST api/gong {text}   → { reply, think }
   ⚠️ role 只认 'her' / 'gong',字段名别改(前端 gongRow 直接读)。 */

app.get("/api/gong", guard, (req, res) => {
  res.json({ msgs: ledger.all().map((m) => ({ role: m.role, text: m.text, think: m.think || "" })) });
});

app.post("/api/gong", guard, async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ ok: false, reply: "（没有内容）" });

  // **这就是这一版的暂停键**:它还在干活的时候你再说一句 = 叫停 + 插话。
  // 前端那间屋没有按钮(第一版零改动),所以这条路必须成立,不能回 409。
  if (station && station.busy) {
    interrupt();
    await new Promise((r) => setTimeout(r, 600));   // 给 CLI 一点时间把中断落地
  }
  say(text);
  const s = await waitTurn(GONG_WAIT_MS);
  res.json(gongReply(s));
});

/* ── 工位 API(给以后重做的 UI 用;那颗真正的暂停键接这里) ── */

app.get("/api/agent/state", guard, (req, res) => res.json({ ok: true, ...stationState(), msgs: ledger.count() }));

app.post("/api/agent/say", guard, (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ ok: false, why: "没有内容" });
  if (station && station.busy) return res.status(409).json({ ok: false, why: "它还在上一轮里,先叫停" });
  say(text);
  res.json({ ok: true });
});

app.post("/api/agent/interrupt", guard, (req, res) => res.json({ ok: interrupt() }));

app.post("/api/agent/close", guard, (req, res) => {
  const had = closeStation("她点了收工");
  ledger.clear();
  res.json({ ok: true, had });
});

/* 闲置自动收工:她忘了关也不会让一个几百 MiB 的进程挂一夜。 */
setInterval(() => {
  if (station && !station.busy && Date.now() - station.lastAt > IDLE_CLOSE_MS) {
    closeStation(`闲置超过 ${Math.round(IDLE_CLOSE_MS / 60000)} 分钟,自动收工`);
  }
  if (station && station.busy && Date.now() - station.lastAt > MAX_TURN_MS) {
    log("[看门] 单轮超过封顶时长,叫停");
    interrupt();
  }
}, 60000).unref?.();

app.listen(PORT, () => log(`agent-bridge 起来了 :${PORT}${AGENT_KEY ? "" : "（⚠️ 没上锁）"}`));

export { app };

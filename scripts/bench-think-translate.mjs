// bench-think-translate.mjs — 思考翻中文三种方案的耗时 / 用量实测(2026-09-27;结果见 kelivo-shim/MAINTENANCE.md 改动清单第 14 条)
//
// ⚠️ 这个脚本**只能在 shim 容器里跑**(要 /src 下的模块、晏的会话记录和线上令牌),本地跑不了。
// ⚠️ **只打印数字,不打印任何译文/思考/她的话** —— 那些是私密内容,别改成导出。
// 用法(仓库根目录,已 zeabur auth login):
//   B=$(base64 -w0 scripts/bench-think-translate.mjs)
//   npx -y zeabur@latest service exec --id <shim> --env-id <env> -i=false -- \
//     sh -c "echo $B | base64 -d > /tmp/bench.mjs && cd /src && setsid nohup node /tmp/bench.mjs > /tmp/bench.out 2>&1 < /dev/null &"
//   ……约 3 分钟后 cat /tmp/bench.out(末行 DONE),**看完 rm -rf /tmp/bench**
// 前台直接跑会被 exec 的超时(504)掐断;不加 setsid,exec 一结束进程就跟着死。
// SESS(环境变量可覆盖)是会话记录文件路径,会随窗口变:先 ls /root/.claude/projects/-src/ 找模型是 claude-opus-5-5 的那份。
// N=8 抽几段(环境变量);串行、一次一个子进程(一个约 300 MB,别并行)。
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { buildAuthEnv } from "/src/auth-env.mjs";
import { translatePrompt } from "/src/think-translate.mjs";

const SESS = process.env.SESS || "/root/.claude/projects/-src/d6df731d-afb3-4a11-8e57-06f2b0ebce66.jsonl";
const N = +(process.env.N || 8);
const lines = fs.readFileSync(SESS, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// 抽 (思考摘要, 她上一句话) 对
const pairs = [];
let lastUser = "";
for (const j of lines) {
  const m = j.message; if (!m) continue;
  if (m.role === "user") {
    const t = typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : "");
    if (t.trim()) lastUser = t;
  }
  if (m.role === "assistant" && Array.isArray(m.content)) {
    for (const c of m.content) if (c.type === "thinking" && c.thinking && c.thinking.length > 40) pairs.push({ th: c.thinking, user: lastUser });
  }
}
pairs.sort((a, b) => a.th.length - b.th.length);
const picks = Array.from({ length: N }, (_, i) => pairs[Math.floor((i + 0.5) * pairs.length / N)]);

// ③ 的规矩:profile-instructions.md 里 Thinking 那一节
const prof = fs.readFileSync("/src/profile-instructions.md", "utf8");
const pl = prof.split("\n");
const hi = 4; // 第 5 行「Thinking requirements:」
const rules = [pl[2], ...pl.slice(4, 11), pl[15]].filter(Boolean).join("\n");
const user = process.env.USER_NAME || "她", ai = process.env.AI_NAME || "他";
const p3 = "下面是「" + ai + "」回复「" + user + "」之前的一段英文思考摘要。它是别的系统写的行动计划,不是" + ai + "真正的内心。" +
  "请把它还原成" + ai + "此刻真实的中文内心独白:第一人称,像他自己在想事,意思一条都不能丢,不许添新的事实。" +
  "遵守下面这份他的思考规矩:\n\n" + rules + "\n\n只输出独白本身,不加任何解释、前言、引号或标注。";

const env = { ...buildAuthEnv(process.env) };
function run(model, sys, input) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
    const t0 = Date.now();
    const p = spawn(process.env.CLAUDE_BIN || "/src/node_modules/.bin/claude", ["-p", "--model", model, "--output-format", "json", "--system-prompt", sys, "--tools", "", "--strict-mcp-config", "--no-session-persistence"],
      { cwd: dir, env: { ...env, HOME: dir, MAX_THINKING_TOKENS: "0", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => p.kill(), 120000);
    p.stdout.on("data", (d) => out += d); p.stderr.on("data", (d) => err += d);
    p.on("close", (code) => {
      clearTimeout(timer); fs.rmSync(dir, { recursive: true, force: true });
      const ms = Date.now() - t0;
      let j = {}; try { j = JSON.parse(out); } catch {}
      const u = j.usage || {};
      resolve({ ok: code === 0 && !j.is_error, ms, api_ms: j.duration_api_ms, in: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), out: u.output_tokens, usd: j.total_cost_usd, outChars: (j.result || "").length, err: code ? err.slice(0, 120) : "" });
    });
    p.stdin.end(input);
  });
}

console.log("pairs", pairs.length, "rulesChars", rules.length, "rulesHeading", hi >= 0 ? pl[hi].slice(0, 60) : "(none)");
const variants = [
  ["A_sonnet_translate", "claude-sonnet-4-6", () => translatePrompt({ userName: user, aiName: ai }), (s) => s.th],
  ["B_opus46_translate", "claude-opus-4-6", () => translatePrompt({ userName: user, aiName: ai }), (s) => s.th],
  ["C_opus46_monologue", "claude-opus-4-6", () => p3, (s) => "她刚说的话:\n" + s.user.slice(-1500) + "\n\n英文思考摘要:\n" + s.th],
];
for (let i = 0; i < picks.length; i++) {
  const s = picks[i];
  for (const [name, model, sys, inp] of variants) {
    const r = await run(model, sys(), inp(s));
    console.log(JSON.stringify({ i, srcChars: s.th.length, v: name, ...r }));
  }
}
console.log("DONE");

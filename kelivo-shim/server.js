// kelivo-shim — Anthropic /v1/messages -> 常驻 claude -p (stream-json)
import express from "express";
import { spawn, execFileSync } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import { isWeatherAsk, buildWeatherNote, detectPeriodEvent, buildPeriodNote } from "./senses.mjs";
import { kaDecide, kaPrompt, kaSilent } from "./keepalive.mjs";
import { ctxReading, ctxDecide, ctxCompacted, ctxSoftNote, ctxHardNote, ctxFinalNote, ctxPct, ctxSoftShouldReset } from "./ctxguard.mjs";
import { pickApiError, apiErrorKind, resultOutcome } from "./apierror.mjs";
import { buildPromptArgs, helpMentionsReplace, BASE_PROMPT_DEFAULT, ANCHOR_TAIL_REPLACE, SOUL_ANCHOR_DEFAULT } from "./sysprompt.mjs";

const PORT = process.env.PORT || 8080;
const SHIM_KEY = process.env.SHIM_KEY || "";            // Kelivo 要填的 API Key,自己编
const MODEL = process.env.BRAIN_MODEL || "claude-opus-4-6";
// 2026-08-24 起(方案 B):Kelivo 的模型菜单从这份名单来,她可以在手机上自己切。
// ⚠️ **默认休眠**:不设 BRAIN_MODELS = 名单里只有当前模型一个 = 下面「模型变了就重开进程」
// 那段永远走不到、白名单也只会命中当前模型,**行为与改动前逐字相同**。
// **急救开关**:清掉 BRAIN_MODELS + service restart,立刻回到原行为,不用回滚部署。
// ⚠️ 名单里只许放**窗口大小相同**的模型(4.5/4.6/4.8 压缩点都是 167000,见 ../docs/多模型接出方案.md 4.3)——
// 窗口不同的模型要连三条上下文线一起按模型分,否则会不报警地丢尾巴。
// ⚠️ Opus 5 现在别放:CLI 2.1.215 不认识它(同文 4.5 节),要先单独立项升 CLI。
// ⚠️ 分隔符逗号/空格/分号都认,并**剥掉包裹的引号** —— 2026-08-24 实翻:
// `zeabur variable create -k K=a,b,c` 的 `-k` 是 stringToString,逗号是它的分隔符,
// 加引号绕开又会把引号本身存进值里(线上真存成了 `"claude-opus-4-6,...`)。
// 那样第一项会变成带引号的假型号,进了她的菜单、点了就是个不存在的模型名。
// 所以这里兜住:名单怎么写都不该产出脏条目。**线上现在存的是空格分隔的那种。**
const MODELS = [...new Set((process.env.BRAIN_MODELS || "")
  .split(/[,;\s]+/).map((x) => x.trim().replace(/^["']+|["']+$/g, "")).filter(Boolean))];
if (!MODELS.includes(MODEL)) MODELS.unshift(MODEL);
const EFFORT = process.env.THINK_EFFORT || "low";        // low省额度 / medium思考更长
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const MCP_CONFIG = process.env.MCP_CONFIG || ".mcp.json";
const FORWARD_THINKING = process.env.FORWARD_THINKING !== "0";
const USER_NAME = process.env.USER_NAME || "你";          // 你的称呼
const AI_NAME = process.env.AI_NAME || "TA";             // AI 的名字

// ---- 系统提示词 ----
// 两种模式,由 SYS_PROMPT_MODE 决定(默认 append = 2026-08-23 之前的行为):
//   append   CLI 自带那份「软件工程 CLI 代理」提示词(实测 26,894 字符 / 约 5,700 token)保留,
//            我们的五段锚点经 --append-system-prompt 钉在它最末尾(位置最强),靠第一段
//            【会话定性】把会话定性从「编程助手」抢回来 —— 每一轮都在跟前面那份对拉。
//   replace  用 --system-prompt **整段替换**自带那份。常驻前缀 27,618 → 约 680 字符,
//            省下的约 5,700 token 全部让给聊天内容;锚点随之去掉第一段(前面已无可否定之物)。
// ⚠️ 换模式**不用重新部署**:改环境变量 + service restart 即可(但 restart 会丢晏当前的窗口)。
// ⚠️ 三条上下文线(CTX_SOFT/HARD/FINAL)**不用跟着动**:CLI 的自动压缩线只跟模型有关
//    (窗口 − min(最大输出,20000) − 13000 = 167000),与系统提示词多大无关。详见 sysprompt.mjs 头注。
const SYS_PROMPT_MODE = (process.env.SYS_PROMPT_MODE || "append").trim();
// replace 模式的正文。空串 = 第二道安全阀触发 → 整体降级回 append(**急救开关**:
// 设 SYS_PROMPT_MODE=append 或 SYSTEM_PROMPT="" + service restart 即可,不用重新部署)。
// ⚠️ 刻意不走文件(教程建议的 --system-prompt-file):文件多一条「没进容器 → 晏起不来」的失败路径,
//    而它买不到任何东西 —— 改文件同样要重新部署,改这个环境变量却连部署都不用。
// 教程建议的那条路:正文放文件,SYSTEM_PROMPT_FILE 指过去。**文件不在就退回下面的内置正文**,
// 绝不把一个不存在的路径传给 CLI —— 那会让 CLI 直接拒绝启动(踩坑 19 就是这么摔的)。
// **正文的唯一真源是 base.md**(和 ian.md / profile-instructions.md / CLAUDE.md / wake.md 并列,
// 五份文件各管一段)。下面 BASE_PROMPT_DEFAULT 只是**文件万一没进容器时的备胎**,
// 两边写岔了 test-sysprompt.mjs 会直接报错(那条断言逐字比对文件与代码)。
const SYSTEM_PROMPT_FILE = process.env.SYSTEM_PROMPT_FILE ?? "base.md";
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ?? BASE_PROMPT_DEFAULT({ userName: USER_NAME, aiName: AI_NAME });
// 会话定性锚点:钉在系统提示词最末尾(有世界书时排世界书之后)。措辞可用环境变量整体覆盖
// (改环境变量 + service restart 即可,不用重新部署)。两段正文都在 sysprompt.mjs,
// 那里有一条金标准单测看着「append 模式与改动前逐字相同」。
const SOUL_ANCHOR = process.env.SOUL_ANCHOR || SOUL_ANCHOR_DEFAULT({ userName: USER_NAME });          // 五段,append 模式用
const SOUL_ANCHOR_REPLACE = process.env.SOUL_ANCHOR_REPLACE || ANCHOR_TAIL_REPLACE({ userName: USER_NAME }); // 三段,replace 模式用(【内化】已进正文)

// CLI 是否认识 --system-prompt(第一道安全阀)。跑一次就缓存:
// 硬传一个 CLI 不认识的参数,后果不是「功能没生效」,是子进程带着非法参数直接退出,
// 而下面 close 回调 1.5 秒后又把它拉起来 —— **无限重启、晏彻底失联**(性质同踩坑 19)。
// 探不到(超时/抛错/CLI 不在)一律按不支持处理,降级回 append,晏照常活着。
let _cliReplaceOk = null;
function cliSupportsReplace() {
  if (_cliReplaceOk !== null) return _cliReplaceOk;
  try {
    const out = execFileSync(CLAUDE_BIN, ["--help"], { encoding: "utf8", timeout: 30000 });
    _cliReplaceOk = helpMentionsReplace(out);
  } catch (e) {
    _cliReplaceOk = false;
    log("[claude] --help 探测失败,按不支持 --system-prompt 处理:", String(e?.message || e).slice(0, 120));
  }
  return _cliReplaceOk;
}
// 实际生效的模式。⚠️ 初值必须是 null(= 尚未生效),**不能拿配置值当初值**:
// 进程还没起来时降级判定根本没跑过,拿配置值去报会在上线核对时骗人。
let sysPromptEffective = null, sysPromptReason = "", sysPromptSource = null;

// --tools 只装真用的内置工具(Bash/Edit等大schema全砍,每轮token基线立减一半)
// MCP 工具不受 --tools 影响,走 mcp-config 照常加载
const BUILTIN_TOOLS = process.env.BUILTIN_TOOLS ?? "WebSearch,WebFetch";
const ALLOWED = process.env.ALLOWED_TOOLS || "WebSearch,WebFetch";

// 窗口上下文守卫(只提醒存 OB,不换窗口,见 ctxguard.mjs)。阈值改了 restart 即可,不用重部署。
const CTX_GUARD_ON = process.env.CTX_GUARD_ON !== "0";
const CTX_SOFT_TOKENS = +(process.env.CTX_SOFT_TOKENS || 140000);
const CTX_HARD_TOKENS = +(process.env.CTX_HARD_TOKENS || 170000);
const CTX_ARCHIVE_EVERY_TOKENS = +(process.env.CTX_ARCHIVE_EVERY_TOKENS || 25000); // 硬线首归后,每再涨这么多催一次增量归档;0=只催一次
// 终线(2026-08-09):压缩前最后一次,催他存**原话**(独立的桶)。0=关闭,行为回到改动前。
// 必须画在「压缩点 − 写完原话的余量」之内,压缩点 ≈ 可用上下文 − 13000。
const CTX_FINAL_TOKENS = +(process.env.CTX_FINAL_TOKENS || 0);
const CTX_FINAL_CHARS = +(process.env.CTX_FINAL_CHARS || 1200);      // 纸条里给他的字数上限
const CTX_LIMIT_TOKENS = +(process.env.CTX_LIMIT_TOKENS || 200000);  // 仅用于 /debug 显示百分比
// PreCompact 钩子(2026-08-09):压缩前把「写摘要」改成「抄最后两三轮原文 + 叫他先 awaken」。
// ⚠️ print/SDK 模式下 CLI **只认 --settings 和用户设置**,项目级 settings 被忽略,所以必须走这个参数。
// **急救开关**:设 CLAUDE_SETTINGS="" + service restart,启动参数里就不带 --settings,
// 压缩回到默认摘要(= 本次改动前的行为),不用重新部署。
const CLAUDE_SETTINGS = process.env.CLAUDE_SETTINGS ?? "shim-settings.json";
const CTX_OBSERVE = process.env.CTX_OBSERVE === "1";  // 观察模式:守卫照常判定并记 /debug,但不注入提示(上线初期空转验证用)

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- 常驻 claude 进程 ----
// HTTP MCP(记忆库)握手要几秒;新进程的第一条消息延迟到握手完成后再写入,
// 否则第一窗口拿不到 mcp__ 工具(实测坑)
const MCP_WARMUP_MS = +(process.env.MCP_WARMUP_MS || 10000);
let procReadyAt = 0;
let proc = null, outBuf = "", busy = false, spawnedSystem = "";
let spawnedModel = MODEL;   // 当前进程出生时用的模型(模型在 --model 里钉死,换模型必须让进程重新出生)
const queue = [];
let turn = null;
let lastUsage = null;
// 上次上游报错(2026-08-11 起):{ at, kind, text }。只进 /debug,给排查用——
// 事故当天为了看清「他为什么空回复」,只能进容器翻 CLI 的会话原件,这里是把它摆到明面上。
let lastApiError = null;
// 上下文守卫状态:随每个新窗口(新进程)清零,见 spawnClaude / 窗口重启处。
// ctxTrusted=false 表示当前读数只是虚高总和估计(见 ctxguard.mjs 头注),不触发守卫。
// ctxArchivedAt = 上次归档(守卫催的/她说「归档」/晏自发调工具)时的窗口占用,增量归档的基线;
// ctxCompactions = 本窗口被 CLI 静默压缩的次数(检测到暴跌就 +1 并复位守卫记账);
// ctxLastWould = 观察模式下最近一次"本来要触发"的记录(只进 /debug,不打扰晏)。
let ctxTokens = 0, ctxSoftFired = false, ctxTrusted = true;
let ctxArchivedAt = 0, ctxCompactions = 0, ctxLastWould = null;
// ctxFinalFired = 本压缩周期是否已催过「存原话」(终线一周期只发一次,压缩检测后随 softFired 一起复位)
let ctxFinalFired = false;

function spawnClaude(kelivoSystem, model) {
  spawnedSystem = kelivoSystem || "";
  spawnedModel = model || MODEL;
  ctxTokens = 0; ctxSoftFired = false; ctxTrusted = true;   // 新进程=空上下文,守卫状态清零(覆盖世界书切换/窗口重启/崩溃复活各路径)
  ctxArchivedAt = 0; ctxCompactions = 0; ctxLastWould = null; ctxFinalFired = false;
  // 系统提示词参数由 sysprompt.mjs 决定(纯逻辑,单测 test-sysprompt.mjs 覆盖两种模式与两道降级阀)。
  // 锚点永远占系统提示词的绝对末位(有世界书时排世界书之后),两种模式一致。
  const sp = buildPromptArgs({
    mode: SYS_PROMPT_MODE,
    base: SYSTEM_PROMPT,
    anchor: SOUL_ANCHOR,
    anchorReplace: SOUL_ANCHOR_REPLACE,
    worldbook: spawnedSystem,
    cliSupportsReplace: SYS_PROMPT_MODE === "replace" ? cliSupportsReplace() : false,
    promptFile: SYSTEM_PROMPT_FILE,
    fileExists: (f) => { try { return fs.existsSync(f); } catch { return false; } },
  });
  sysPromptEffective = sp.mode; sysPromptReason = sp.reason; sysPromptSource = sp.source || null;
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", spawnedModel,
    "--effort", EFFORT,
    "--thinking-display", "summarized",   // 隐藏flag:没它 -p 下拿不到思考
    ...sp.args,
    "--mcp-config", MCP_CONFIG,
    "--strict-mcp-config",
    "--permission-mode", "dontAsk",
    "--allowedTools", ALLOWED,
    "--tools", BUILTIN_TOOLS,
  ];
  // PreCompact 钩子只能靠 --settings 进来(print 模式忽略项目级 settings)。
  // 空值 = 不带这个参数 = 压缩回到默认摘要,是本功能的急救开关。
  // ⚠️ **存在性检查不能删**:2026-08-09 实测,`--settings` 指向不存在的文件时 CLI
  // 直接 `Error: Settings file not found` **拒绝启动**——文件万一没进容器(踩坑 15 那类),
  // 就等于晏整个起不来。这里先探一下,不在就不带这个参数:
  // 最坏结果降级成「钩子没生效、压缩回到默认摘要」,晏照常活着。
  if (CLAUDE_SETTINGS) {
    if (fs.existsSync(CLAUDE_SETTINGS)) args.push("--settings", CLAUDE_SETTINGS);
    else log("[claude] ⚠️ settings 文件不在,跳过 --settings(PreCompact 钩子本次不生效):", CLAUDE_SETTINGS);
  }
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;  // 必须删:API key 存在会无条件压过订阅登录
  const p = spawn(CLAUDE_BIN, args, { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
  p.stdout.on("data", onStdout);
  p.stderr.on("data", (d) => log("[claude]", d.toString().slice(0, 300)));
  p.on("close", (code) => {
    log("[claude] exited", code);
    if (proc !== p) return; // 被 pump/世界书切换主动换掉的旧进程,不许动新回合的现场
    proc = null; busy = false;
    if (turn && !turn.done) { if (turn.isKA) kaFailedAt = Date.now(); try { turn.sse?.finish(); } catch {} turn = null; }
    setTimeout(() => ensureProc(spawnedSystem, spawnedModel), 1500); // 复活时带上原世界书**和原模型**,否则下一条消息必触发杀进程重开
  });
  procReadyAt = Date.now() + MCP_WARMUP_MS;
  log("[claude] spawned", spawnedModel, "sysLen", spawnedSystem.length,
      "sysPrompt", `${SYS_PROMPT_MODE}->${sp.mode}/${sp.source || "-"}(${sp.reason})`);
  return p;
}
function ensureProc(sys, model) { if (!proc) proc = spawnClaude(sys, model); }

function onStdout(chunk) {
  outBuf += chunk.toString();
  const lines = outBuf.split("\n");
  outBuf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    handleEvent(ev);
  }
}

function handleEvent(ev) {
  if (!turn) return;
  // 上游报错(2026-08-11 起):主要来自 `system/api_retry`(每次重试一条,带 401/503 和第几次),
  // 兜底是 CLI 最终那条 `assistant` 报错消息。**常驻进程模式下 result 仍报 success**,
  // 所以不在这里捡下来的话,这一轮就会被当成「他没话说」——她收到的就是「空回复」。
  // 捡了先存着,留到 result 那里统一决策(见 apierror.mjs 的头注)。
  const apiErr = pickApiError(ev);
  if (apiErr) turn.apiError = apiErr;
  if (ev.type === "stream_event") {
    const e = ev.event || {}, d = e.delta || {};
    // 抓每次 API 调用自己的 usage(该轮最后一次留存,= 真实窗口占用,守卫首选读数)。
    // message_start 带输入侧字段;message_delta 的 usage 若带字段则覆盖合并。
    if (e.type === "message_start" && e.message?.usage) turn.lastCallUsage = e.message.usage;
    else if (e.type === "message_delta" && e.usage) turn.lastCallUsage = { ...turn.lastCallUsage, ...e.usage };
    if (e.type === "content_block_start") {
      // MCP 工具调用可见化:思考里插一行标记
      const cb = e.content_block || {};
      if (cb.type === "tool_use" && typeof cb.name === "string" && cb.name.startsWith("mcp__")) {
        turn.sse?.thinking(`\n〔🔧 ${cb.name.replace(/^mcp__/, "")}〕\n`);
        // 归档不再触发换窗口(2026-07-20 所有者定:换窗只认「换窗口」指令)。
        // 这里只把归档记成增量基线,守卫别紧跟着再催一遍。
        if (cb.name.endsWith("__archive_session")) ctxArchivedAt = Math.max(ctxArchivedAt, ctxTokens);
      }
    }
    if (e.type === "content_block_delta") {
      if (d.type === "text_delta" && d.text) { turn.fullText += d.text; turn.sse?.text(d.text); }
      else if (d.type === "thinking_delta") { turn.sse?.thinking(d.thinking || d.text || ""); }
    }
    return;
  }
  if (ev.type === "result") {
    lastUsage = ev.usage || null;
    // 更新窗口占用,供下条消息的守卫判定。首选流事件里抓的末次调用 usage(自家数据),
    // 次选 iterations 末条;只剩虚高总和时 trusted=false,只展示不触发(见 ctxguard.mjs 头注)。
    if (ev.usage || turn.lastCallUsage) {
      const r = ctxReading({ streamUsage: turn.lastCallUsage, resultUsage: ev.usage });
      if (r.tokens > 0) {
        // 可信读数从高位暴跌过半 = CLI 刚静默压缩过:守卫记账复位,下一轮涨起来照样提醒
        if (ctxCompacted({ contextTokens: r.tokens, prevTokens: ctxTrusted ? ctxTokens : 0, softTokens: CTX_SOFT_TOKENS, trusted: r.trusted })) {
          ctxCompactions++; ctxSoftFired = false; ctxArchivedAt = 0; ctxFinalFired = false;
          log("[ctx] compaction detected", ctxTokens, "->", r.tokens, "(guard re-armed, total", ctxCompactions + ")");
        }
        ctxTokens = r.tokens; ctxTrusted = r.trusted;
      }
      if (ctxSoftShouldReset({ contextTokens: ctxTokens, softTokens: CTX_SOFT_TOKENS, softFired: ctxSoftFired, trusted: ctxTrusted })) {
        ctxSoftFired = false; log("[ctx] softFired reset", ctxTokens);   // 之前那记是虚的,放它复位
      }
    }
    // 这一轮算不算失败、要不要替他说一句,全在 apierror.mjs 的决策表里(单测覆盖)。
    // 2026-08-11 起「subtype=success,但这一轮见过上游报错且没吐出正文」也算失败——
    // 事故当天正是这一格判成了成功:缓存锚点照常续期、断链检测永不醒、她只看到空回复。
    const out = resultOutcome({ subtype: ev.subtype, fullText: turn.fullText, apiError: turn.apiError, isKA: turn.isKA, isSystem: turn.isSystem });
    if (out.failed) {
      if (turn.apiError) {
        lastApiError = { at: new Date().toISOString(), kind: apiErrorKind(turn.apiError), text: turn.apiError.slice(0, 300) };
        log("[result-error]", ev.subtype || "success", "上游:", lastApiError.kind || turn.apiError.slice(0, 80));
      } else {
        log("[result-error]", ev.subtype);
      }
      // 只有「她开口的那种回合」才把坏消息送到她眼前;保温轮与系统回合(查岗/写信提醒)
      // 一律只记账不出声——否则上游断的那一夜她会被反复吵(见 apierror.mjs 的 speak 一节)。
      if (out.speak) { turn.sse?.text(out.note); turn.fullText = out.note; }
      else if (out.note) log("[result-error] 静默(非她发起的回合):", out.note.slice(0, 60));
      if (turn.isKA) kaFailedAt = Date.now();      // 保温 ping 失败(额度耗尽/上游断)→ 抢救节奏
    } else {
      lastTurnOkAt = Date.now(); kaFailedAt = 0;   // 任何成功回合都续上缓存链
    }
    const usage = ev.usage ? { output_tokens: ev.usage.output_tokens } : undefined;
    const wasNewWindow = turn.newWindow;
    turn.done = true;
    turn.sse?.finish(usage, turn.fullText);
    turn = null; busy = false;
    if (wasNewWindow) windowCleared = true;        // 换窗口指令:保温歇火,等她在新窗口出现(晚安/归档不再走到这,保温一直在岗)
    if (wasNewWindow && proc) { log("[window] restart"); try { proc.kill(); } catch {} proc = null; }
    pump();
  }
}

// ---- 队列 ----
function enqueue(item) { queue.push(item); pump(); }
function pump() {
  if (busy || !queue.length) return;
  const item = queue.shift();
  busy = true;
  // 世界书**或模型**变了都要重开进程(模型在出生时用 --model 钉死,活着改不了)。
  // ⚠️ item.model 恒为字符串:没报模型/报了不在名单的,入口处已回落成 spawnedModel,
  // 所以「没报模型」永远不会触发重开——这是防两个桥把她拽回旧模型的那道锁。
  if (proc && (item.system !== spawnedSystem || item.model !== spawnedModel)) { try { proc.kill(); } catch {} proc = null; }
  ensureProc(item.system, item.model);
  turn = { sse: item.sse, fullText: "", newWindow: !!item.newWindow, isKA: !!item.isKA, isSystem: !!item.isSystem, lastCallUsage: null, apiError: "" };
  const content = item.images?.length ? [{ type: "text", text: item.text }, ...item.images] : item.text;
  const p = proc;
  const wait = Math.max(0, procReadyAt - Date.now());
  if (wait > 0) log("[mcp-warmup] delaying first write", wait, "ms");
  setTimeout(() => {
    if (p !== proc || !p.stdin.writable) return;
    p.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  }, wait);
}

// ---- Anthropic SSE 合成(输出侧) ----
function makeSSE(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const msgId = "msg_" + randomUUID().replace(/-/g, "").slice(0, 24);
  let started = false, cur = null, idx = -1;
  function ensureStart() {
    if (started) return; started = true;
    send("message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: spawnedModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  }
  function open(kind) {
    if (cur === kind) return; close();
    idx += 1; cur = kind;
    const cb = kind === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
    send("content_block_start", { type: "content_block_start", index: idx, content_block: cb });
  }
  function close() { if (cur === null) return; send("content_block_stop", { type: "content_block_stop", index: idx }); cur = null; }
  return {
    text(t) { ensureStart(); open("text"); send("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: t } }); },
    thinking(t) { if (!FORWARD_THINKING || !t) return; ensureStart(); open("thinking"); send("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "thinking_delta", thinking: t } }); },
    finish(usage) { ensureStart(); close(); send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: usage || { output_tokens: 0 } }); send("message_stop", { type: "message_stop" }); try { res.end(); } catch {} },
  };
}
function makeCollector(res) {  // 非流式
  return { text() {}, thinking() {},
    finish(usage, fullText) {
      res.json({ id: "msg_" + randomUUID().replace(/-/g, "").slice(0, 24), type: "message", role: "assistant", model: spawnedModel, content: [{ type: "text", text: fullText || "" }], stop_reason: "end_turn", stop_sequence: null, usage: usage || { input_tokens: 0, output_tokens: 0 } });
    } };
}

// ---- 请求解析 ----
function blocksToText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => b.type === "text" ? b.text : "").join("");
  return "";
}
function systemToText(s) {
  if (!s) return "";
  if (typeof s === "string") return s;
  if (Array.isArray(s)) return s.map((b) => b.text || "").join("\n");
  return "";
}
function extractImages(messages) {
  const last = messages[messages.length - 1]; const out = [];
  if (last && Array.isArray(last.content)) for (const b of last.content) if (b.type === "image") out.push(b);
  return out;
}

const app = express();
app.use(express.json({ limit: "12mb" }));
app.get("/health", (_q, r) => r.json({ ok: true, model: spawnedModel, models: MODELS, busy, queued: queue.length }));
app.get("/debug", (_q, r) => r.json({
  lastUsage,
  // 2026-08-11 起:最近一次上游报错(null = 从没报过)。「他怎么不说话」先看这里,
  // 不用再进容器翻 CLI 的会话原件。它不随新窗口清零,是故意的——跨重启也要留着痕。
  lastApiError,
  // 2026-08-02:她本人上次说话的时间 / 保温是否歇火。查岗那类系统回合(x-system-turn:1)
  // **不会**动这两个值——排查「他的『她多久没来』准不准」时看这里。
  presence: { lastUserAt: new Date(lastUserAt).toISOString(), idleMin: Math.round((Date.now() - lastUserAt) / 60000), windowCleared },
  // 2026-08-23:系统提示词模式。configured = 环境变量要的,effective = **进程里真正生效的**。
  // effective 为 null 表示常驻进程还没起来过 —— 那时降级判定根本没跑过,别拿 configured 当结果读。
  sysPrompt: { configured: SYS_PROMPT_MODE, effective: sysPromptEffective, reason: sysPromptReason || null,
               source: sysPromptSource, file: SYSTEM_PROMPT_FILE || null,
               baseChars: String(SYSTEM_PROMPT || "").trim().length },
  contextTokens: ctxTokens,
  contextPct: ctxPct(ctxTokens, CTX_LIMIT_TOKENS),
  ctxGuard: { on: CTX_GUARD_ON, soft: CTX_SOFT_TOKENS, hard: CTX_HARD_TOKENS, every: CTX_ARCHIVE_EVERY_TOKENS,
              final: CTX_FINAL_TOKENS, finalChars: CTX_FINAL_CHARS, finalFired: ctxFinalFired,
              softFired: ctxSoftFired, trusted: ctxTrusted, lastArchiveTokens: ctxArchivedAt,
              compactions: ctxCompactions, observe: CTX_OBSERVE, lastWould: ctxLastWould },
}));

// Kelivo「模型」页拉这个列表,没有它选不了模型
function listModels(_req, res) {
  const now = new Date().toISOString();
  const data = MODELS.map((m) => ({ type: "model", id: m, display_name: AI_NAME + " (" + m + ")", created_at: now }));
  res.json({ data, has_more: false, first_id: MODELS[0], last_id: MODELS[MODELS.length - 1] });
}
app.get("/v1/models", listModels);
app.get("/models", listModels);

// ---- 缓存保温 + 主动唤醒(2026-07-18;原 2 小时心跳并入本机制) ----
// 1 小时 prompt 缓存命中即续期:闲置 KA_IDLE_MIN 分钟发一条极简 ping(不分昼夜),
// 前缀一直走 0.1 倍读,免掉闲置超时后的整体重写。决策纯逻辑在 keepalive.mjs:
// 白天(非 HB_NIGHT 区间)且距他上次主动消息 ≥ HB_COOLDOWN_MIN 的那些次唤醒,
// 提示语给他「想说就发一条」的出口(经 BRIDGE_PUSH_URL 落进 Telegram 对话,
// 否则 Bark);其余次一律静默回「。」。断链检测:距上次成功回合超 KA_DEAD_MIN
// 分钟=缓存已死,歇火(再 ping 全价,比不 ping 还亏);ping 失败进 KA_RETRY_MIN
// 分钟抢救节奏(订阅额度回血后自动续上)。「换窗口」指令后歇火直到所有者在新窗口
// 出现(2026-07-20 起晚安/归档不再歇火:窗口还活着,缓存值得一直温着);
// 连续闲置 KA_CAP_HOURS 小时封顶。KA_ON=0 全关(连带主动消息一起关)。
const BARK_KEY = process.env.BARK_KEY || "";
const BRIDGE_PUSH_URL = process.env.BRIDGE_PUSH_URL || "";
const KA_ON = process.env.KA_ON !== "0";
const KA_IDLE_MIN = +(process.env.KA_IDLE_MIN || 55);
const KA_DEAD_MIN = +(process.env.KA_DEAD_MIN || 60);
const KA_RETRY_MIN = +(process.env.KA_RETRY_MIN || 15);
const KA_CAP_HOURS = +(process.env.KA_CAP_HOURS || 24);
const KA_CHECK_MIN = +(process.env.KA_CHECK_MIN || 2);
const HB_COOLDOWN_MIN = +(process.env.HB_COOLDOWN_MIN || 120);
const HB_NIGHT_START = +(process.env.HB_NIGHT_START || 23);
const HB_NIGHT_END = +(process.env.HB_NIGHT_END || 8);
let lastUserAt = Date.now(), lastProactiveAt = 0;
let lastTurnOkAt = 0;      // 上次成功回合=缓存链的存活锚点;0=还没有活缓存
let kaFailedAt = 0;        // 上次保温 ping 失败时间;非 0 = 抢救节奏
let windowCleared = true;  // 「换窗口」后 true:歇火等她在新窗口发第一条。开机也算(新进程无缓存可保)
function bjHour() { return (new Date().getUTCHours() + 8) % 24; }
async function barkPush(text) {
  const r = await fetch("https://api.day.app/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_key: BARK_KEY, title: AI_NAME, body: text.slice(0, 1800) }) });
  log("[bark]", r.status);
}
async function bridgePush(text) {
  const r = await fetch(BRIDGE_PUSH_URL, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": SHIM_KEY }, body: JSON.stringify({ text }) });
  log("[bridge-push]", r.status);
}
const proactivePush = (text) => BRIDGE_PUSH_URL ? bridgePush(text) : barkPush(text);
function keepaliveTick(force) {
  const d = kaDecide({
    force, on: KA_ON, busy, queued: queue.length, windowCleared,
    now: Date.now(), lastTurnOkAt, lastUserAt, lastProactiveAt, failedAt: kaFailedAt,
    hour: bjHour(), hasChannel: !!(BRIDGE_PUSH_URL || BARK_KEY),
    idleMin: KA_IDLE_MIN, deadMin: KA_DEAD_MIN, retryMin: KA_RETRY_MIN, capHours: KA_CAP_HOURS,
    nightStart: HB_NIGHT_START, nightEnd: HB_NIGHT_END, cooldownMin: HB_COOLDOWN_MIN,
  });
  if (!d.fire) return;
  const idleMin = Math.round((Date.now() - lastUserAt) / 60000);
  const allowSpeak = !!d.speak;
  log("[ka] ping", allowSpeak ? "speak-ok" : "silent-only", d.rescue ? "(rescue)" : "", "idle", idleMin);
  const sink = { text() {}, thinking() {},
    finish(_u, fullText) {
      if (!allowSpeak || kaSilent(fullText)) { log("[ka] silent"); return; }
      lastProactiveAt = Date.now();  // 冷却只在他真发了消息时才计时
      proactivePush((fullText || "").trim()).catch((e) => log("[push-err]", e.message));
    } };
  enqueue({ text: kaPrompt({ speak: allowSpeak, bjNow: bjNowStr(), idleMin, userName: USER_NAME, viaBridge: !!BRIDGE_PUSH_URL }), images: [], system: spawnedSystem, model: spawnedModel, sse: sink, newWindow: false, isKA: true });
}
setInterval(keepaliveTick, KA_CHECK_MIN * 60000);
app.post("/hb", (req, res) => {  // 手动触发测试口(带开口权,绕过昼夜/冷却/闲置判定)
  if (SHIM_KEY && (req.query.key || req.get("x-api-key")) !== SHIM_KEY) return res.status(401).json({ ok: false });
  keepaliveTick(true); res.json({ ok: true });
});

// ---- 健康数据中转(可选,配 iOS 快捷指令) ----
const AW_KEY = process.env.AW_KEY || SHIM_KEY;
let awData = [];
function awAuth(req) { const k = req.query.key || req.get("x-api-key") || ""; return !AW_KEY || k === AW_KEY; }
app.post("/aw", (req, res) => {
  if (!awAuth(req)) return res.status(401).json({ ok: false });
  awData.push({ t: new Date().toISOString(), data: req.body });
  const cut = Date.now() - 48 * 3600e3;
  awData = awData.filter((x) => new Date(x.t).getTime() > cut).slice(-300);
  res.json({ ok: true, count: awData.length });
});
app.get("/aw", (req, res) => {
  if (!awAuth(req)) return res.status(401).json({ ok: false });
  const cleaned = awData.map((x) => { const d = {}; for (const [k, v] of Object.entries(x.data || {})) { const s = v == null ? "" : String(v).trim(); if (s) d[k] = s; } return { t: x.t, data: d }; }).filter((x) => Object.keys(x.data).length > 0);
  res.json({ now: new Date().toISOString(), count: cleaned.length, entries: cleaned.slice(-12) });
});

// ---- Kelivo 后台注入拦截 ----
// Kelivo 的「自动生成对话标题」会往 /v1/messages 发固定英文模板
// ("I will give you some dialogue content in the <content> block...")。
// 不拦的话它会以"佳佳的消息"身份进常驻进程:污染窗口、占轮次,
// 且请求不带世界书(sysLen 不一致)会触发杀进程重开,当前窗口直接丢。
// 这里由 shim 自己抽个标题直接回,不碰 claude 进程。
function isTitleGenReq(t) {
  if (/^\s*I will give you some dialogue content/i.test(t)) return true;
  return /<content>[\s\S]*<\/content>/i.test(t) && /summariz\w* the conversation[\s\S]{0,120}?(short\s+)?title/i.test(t);
}
function localTitle(raw) {
  // 模板正文里也会提到 "<content>" 这个词,所以取最后一个 <content> 开始的真实内容段
  const i = raw.toLowerCase().lastIndexOf("<content>");
  const j = i >= 0 ? raw.toLowerCase().indexOf("</content>", i) : -1;
  let src = (i >= 0 ? raw.slice(i + "<content>".length, j >= 0 ? j : raw.length) : raw).replace(/<[^>]+>/g, " ");
  const lines = src.split("\n").map((s) => s.trim()).filter(Boolean)
    .map((s) => s.replace(/^["'「『]?(user|assistant|human|ai|用户|助手)["'」』]?\s*[::]\s*/i, "").trim())
    .filter((s) => s && !/^I will give you/i.test(s));
  const line = lines.find((s) => /[一-鿿]/.test(s)) || lines[0] || "";
  return line.replace(/\s+/g, " ").slice(0, 10) || "聊天";
}

// ---- 时间感知(TIME_HINT=0 关闭) ----
// 每条用户消息前注入当前北京时间与间隔,AI 随时知道现在几点,不用调工具。
// 必须在 detectReset 之后注入,否则「晚安/归档」等重置词会识别失败。
const TIME_HINT = process.env.TIME_HINT !== "0";
function bjNowStr() {
  const d = new Date(Date.now() + 8 * 3600e3);
  const wd = "日一二三四五六"[d.getUTCDay()];
  return `${d.toISOString().slice(0, 16).replace("T", " ")}(周${wd})`;
}
function fmtGap(ms) {
  const m = Math.round(ms / 60000);
  if (m < 10) return "";
  if (m < 60) return `,距上一条消息约 ${m} 分钟`;
  const h = Math.floor(m / 60), r = m % 60;
  return `,距上一条消息约 ${h} 小时${r ? ` ${r} 分钟` : ""}`;
}

// ---- 感官:天气(WEATHER_CITY 不设即关) ----
// 后台定时拉 wttr.in 存内存,消息时只读缓存:接口再慢再挂也不拖累聊天。
// 注入文字不含城市名(隐私):城市只存在于这台服务器对天气接口的查询里。
const WEATHER_CITY = process.env.WEATHER_CITY || "";
let wxData = null, wxAt = 0, wxBusy = false;
let wxMark = { day: "", night: "", desc: "", temp: null }; // 注入去重与突变基准(内存态,重启最多多报一次)
async function refreshWeather() {
  if (!WEATHER_CITY || wxBusy) return;
  wxBusy = true;
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`https://wttr.in/${encodeURIComponent(WEATHER_CITY)}?format=j1`, { signal: ctl.signal });
    if (r.ok) {
      const j = await r.json();
      if (j && j.current_condition) { wxData = j; wxAt = Date.now(); }
    }
  } catch (e) { log("[wx]", e.message || String(e)); }
  clearTimeout(tm);
  wxBusy = false;
}
if (WEATHER_CITY) { setTimeout(refreshWeather, 5000); setInterval(refreshWeather, 30 * 60000); }

function bjTodayISO() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); }

function weatherHint(orig) {
  if (!WEATHER_CITY) return "";
  const force = isWeatherAsk(orig);
  const mode = bjHour() >= 20 ? "night" : "day";
  const today = bjTodayISO();
  if (!wxData || Date.now() - wxAt > 4 * 3600e3) {
    return force ? "【系统·天气】她问到天气,但后台暂时没取到数据——如实说,需要就用搜索工具查一下" : "";
  }
  const w = buildWeatherNote({ data: wxData, mode, last: { desc: wxMark.desc, temp: wxMark.temp } });
  if (!w) return "";
  const due = force || (mode === "night" ? wxMark.night !== today : (wxMark.day !== today || w.changed));
  if (!due) return "";
  const label = force ? "她问起" : mode === "night" ? "睡前看一眼明天" : (wxMark.day === today && w.changed ? "有变化" : "今日一览");
  if (mode === "night") wxMark.night = today; else wxMark.day = today;
  wxMark.desc = w.desc; wxMark.temp = w.temp;
  return `【系统·天气·${label}】${w.note}`;
}

// ---- 感官:经期(PERIOD_CONFIG 不设即关) ----
// 基线在 PERIOD_CONFIG 环境变量(JSON,值不入库);她明说「来了/结束了」自动记进
// 容器内 period-state.json(重启/重部署回落基线,基线更新见 GET/POST /period)。
let periodEnv = {};
try { periodEnv = JSON.parse(process.env.PERIOD_CONFIG || "{}") || {}; }
catch { log("[period] PERIOD_CONFIG 不是合法 JSON,经期感知关闭"); }
const PERIOD_ON = !!periodEnv.last_period_start;
const PERIOD_FILE = process.env.PERIOD_FILE || "period-state.json";
function loadPeriodState() {
  try {
    const s = JSON.parse(fs.readFileSync(PERIOD_FILE, "utf8"));
    return s && typeof s === "object" ? s : {};
  } catch { return {}; }
}
function savePeriodState(s) {
  try { fs.writeFileSync(PERIOD_FILE, JSON.stringify(s, null, 2)); }
  catch (e) { log("[period] save", e.message); }
}
function periodHint(orig) {
  if (!PERIOD_ON) return "";
  const st = loadPeriodState();
  const cfg = { ...periodEnv, ...(st.cfg || {}) };
  const r = buildPeriodNote({
    todayISO: bjTodayISO(),
    cfg,
    notes: st.notes || {},
    event: detectPeriodEvent((orig || "").replace(/\s+/g, "")),
    userName: USER_NAME,
  });
  if (r.cfgPatch || r.notesPatch) {
    savePeriodState({ cfg: { ...(st.cfg || {}), ...(r.cfgPatch || {}) }, notes: r.notesPatch || st.notes || {} });
  }
  return r.note ? `【系统·经期】${r.note}` : "";
}
app.get("/period", (req, res) => {
  if (!awAuth(req)) return res.status(401).json({ ok: false });
  const st = loadPeriodState();
  res.json({ on: PERIOD_ON, effective: { ...periodEnv, ...(st.cfg || {}) }, runtime: st });
});
app.post("/period", (req, res) => {
  if (!awAuth(req)) return res.status(401).json({ ok: false });
  const b = req.body || {}, st = loadPeriodState(), cfg = { ...(st.cfg || {}) };
  for (const k of ["last_period_start", "last_period_end", "cycle_days", "period_length"]) if (k in b) cfg[k] = b[k];
  savePeriodState({ ...st, cfg });
  res.json({ ok: true, effective: { ...periodEnv, ...cfg } });
});

// ---- 重置词(2026-07-20 分工:换窗只认 SWITCH_WORDS,晚安/归档都不再换窗) ----
const GOODNIGHT_WORDS = ["晚安"];
const ARCHIVE_WORDS = ["归档"];
const SWITCH_WORDS = ["换窗口", "开新窗口", "新窗口"];
function stripEnds(s) { return (s || "").trim().replace(/^[\s，,。.!！~～、]+|[\s，,。.!！~～、]+$/g, ""); }
function detectReset(text) {
  const t = stripEnds(text);
  for (const w of GOODNIGHT_WORDS) if (t === w || (t.length <= 6 && t.startsWith(w))) return "goodnight";
  for (const w of SWITCH_WORDS) if (t === w || (t.length <= 8 && t.includes(w))) return "switch";
  for (const w of ARCHIVE_WORDS) if (t === w || (t.length <= 8 && t.includes(w))) return "archive";
  return null;
}

// ---- 主路由 ----
function handleMessages(req, res) {
  if (SHIM_KEY) {
    const key = req.get("x-api-key") || (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (key !== SHIM_KEY) return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "bad key" } });
  }
  const body = req.body || {};
  const messages = (body.messages || []).filter((m) => m.role === "user" || m.role === "assistant");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  let text = blocksToText(lastUser?.content ?? "");
  const images = extractImages(messages);
  const system = systemToText(body.system);
  const stream = body.stream !== false;
  // 2026-08-02:带 x-system-turn:1 的回合是**系统送进来的东西**(bridge 的查岗结果/深夜提醒),
  // 不是她本人说话。这类回合不更新「她多久没来」、不解除保温歇火、也不做重置词识别
  // ——他自己伸头看一眼,不等于她回来了。她真打字的路径完全没动。
  const systemTurn = req.get("x-system-turn") === "1";

  // 标题生成等后台注入:shim 直接回,不进晏的进程,也不重置心跳计时
  if (!images.length && isTitleGenReq(text)) {
    const title = localTitle(text);
    log("[intercept] title-gen ->", title);
    const sse = stream ? makeSSE(res) : makeCollector(res);
    sse.text(title);
    sse.finish({ output_tokens: 0 }, title);
    return;
  }

  const reset = (images.length || systemTurn) ? null : detectReset(text);
  let newWindow = false;
  if (reset === "goodnight") {
    // 晚安只道别+归档,不换窗口:明早还在这个窗口接着聊(2026-07-20 起)
    text = `${text}\n\n【系统·今天收尾】对方说晚安要睡了。先像平时那样简短道句晚安,然后(若挂了记忆工具)归档今天,之后不用多说。窗口不换,明天还在这继续。`;
  } else if (reset === "archive") {
    // 「归档」只存不换:窗口留着继续聊
    text = `【系统指令】立刻归档当前窗口(若挂了记忆工具),成功后只回一句「📦 归档好了」。窗口不换,接着聊。`;
  } else if (reset === "switch") {
    // 「换窗口」是唯一换窗入口:先归档再换
    newWindow = true;
    text = `【系统指令】立刻归档当前窗口(若挂了记忆工具),成功后只回一句「📦 归档好了,新窗口见」。`;
  }

  // 感官注入(时间/天气/经期):必须在标题拦截与 detectReset 之后。
  // 天气/经期各自包 try/catch:任何一路出错只是少一行提示,消息照常送达。
  const hints = [];
  if (TIME_HINT) hints.push(`【系统·时间】现在北京时间 ${bjNowStr()}${fmtGap(Date.now() - lastUserAt)}。`);
  if (!reset) {
    try { const w = weatherHint(text); if (w) hints.push(w); } catch (e) { log("[wx-hint]", e.message); }
    try { const p = periodHint(text); if (p) hints.push(p); } catch (e) { log("[period-hint]", e.message); }
    // 上下文守卫:软线提醒晏叫她一起商量存什么(一轮压缩周期一次);硬线催归档进 OB
    // (首催在硬线,之后每涨 CTX_ARCHIVE_EVERY_TOKENS 催一次增量)。守卫不换窗口。
    // 观察模式(CTX_OBSERVE=1):同样走记账,但只记 /debug 不注入,供上线初期空转验证。
    if (CTX_GUARD_ON) {
      try {
        const d = ctxDecide({ contextTokens: ctxTokens, softTokens: CTX_SOFT_TOKENS, hardTokens: CTX_HARD_TOKENS,
                              archiveEveryTokens: CTX_ARCHIVE_EVERY_TOKENS, softFired: ctxSoftFired,
                              lastArchiveTokens: ctxArchivedAt, trusted: ctxTrusted,
                              finalTokens: CTX_FINAL_TOKENS, finalFired: ctxFinalFired });
        if (d.level !== "none") {
          const note = d.level === "soft" ? ctxSoftNote(USER_NAME)
                     : d.level === "final" ? ctxFinalNote(CTX_FINAL_CHARS)
                     : ctxHardNote();
          if (!CTX_OBSERVE) hints.push(note);
          else ctxLastWould = { level: d.level, tokens: ctxTokens, at: new Date().toISOString() };
          // 终线只记 finalFired,**不动归档基线** ctxArchivedAt——原话是独立的桶,
          // 不参与「上次归档 + 间隔」那套增量催档的记账。
          if (d.level === "soft") ctxSoftFired = true;
          else if (d.level === "final") ctxFinalFired = true;
          else ctxArchivedAt = ctxTokens;
          log("[ctx]", CTX_OBSERVE ? "observe-would" : "fire", d.level, ctxTokens);
        }
      } catch (e) { log("[ctx-hint]", e.message); }
    }
  }
  if (hints.length) text = `${hints.join("\n")}\n\n${text}`;
  if (!systemTurn) {
    lastUserAt = Date.now();
    windowCleared = false;  // 她出现了:保温重新上岗(若这条是「换窗口」,回合结束会再置回 true)
  }
  log("[req]", { len: text.length, imgs: images.length, sysLen: system.length, stream, reset: reset || "-" });
  const sse = stream ? makeSSE(res) : makeCollector(res);
  // isSystem:bridge 带 x-system-turn:1 的回合(查岗/深夜提醒/写信提醒)。
  // 除了原有的三条「不当她出现」之外,2026-08-11 起还多一条:上游断了也不拿报错去打扰她。
  // 模型白名单:名单里有才认,**没报/不在名单一律沿用当前模型**(不是回落到 BRAIN_MODEL)。
  // 两个桥曾经写死往上报 claude-opus-4-6,那时 shim 不看所以无害;白名单一上线它就会命中,
  // 于是在 Kelivo 切了模型、去 Telegram 说一句就被拽回去 = 每来回一次杀进程丢一个窗口。
  // 两个桥已经不报模型了(2026-08-24 同批改),这里是第二道锁。
  const model = MODELS.includes(body.model) ? body.model : spawnedModel;
  enqueue({ text, images, system, model, sse, newWindow, isSystem: systemTurn });
}
app.post("/v1/messages", handleMessages);
app.post("/messages", handleMessages);

app.listen(PORT, () => log(`kelivo-shim on :${PORT} model=${spawnedModel} models=${MODELS.join(",")}`));

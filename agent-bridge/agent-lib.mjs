// agent-lib.mjs — agent-bridge 的纯逻辑层。
//
// **这个文件不碰网络、不碰进程、不碰文件**,只做数据变换,所以能被 test-agent.mjs 全量覆盖。
// 接线和 I/O 在 server.mjs。这条分法照抄 dwell-bridge(`dwell-lib.mjs` / `server.js`),
// 那一层两个月里改了六次都没翻过车,是本仓库验证过的形状。
//
// ⚠️ **刻意和 dwell-bridge / kelivo-shim 零跨目录依赖**(START-HERE 的规矩:
// 一个目录 = 一个独立服务)。所以 safeEqual / makeToken / buildAuthEnv 这几样
// 和那两个目录里的**长得很像但是各存一份**,不是忘了抽公共库。
// 改其中一处**不会**自动传到另一处 —— 真要改鉴权或计费这类事,三处都要过一遍。

import crypto from "node:crypto";

/* ═════════════ 一、交给 claude 子进程的环境变量 ═════════════ */

/**
 * ⚠️ **这个函数是承重的,动它之前先读 `../kelivo-shim/auth-env.mjs` 的头注**(规矩 6:跨服务)。
 * 那份头注解释了 CLI 的凭据优先级为什么必须**摘掉代理那两个变量**,
 * 以及为什么「光设 CLAUDE_CODE_OAUTH_TOKEN 是没有用的」。
 *
 * 本函数是那份逻辑的**同源副本**(2026-09-12 抄写),两条铁律一模一样:
 *   ① `ANTHROPIC_API_KEY` 任何时候都删 —— 它排在订阅授权前面,留着这一轮就变成
 *      **按量计费**而不是吃订阅额度(`docs/维护Agent接出方案.md` 风险 3 就是这条)。
 *   ② 有长期令牌时才摘代理那两个,不摘等于没换路、而且一声不吭。
 */
export function buildAuthEnv(src = {}) {
  const env = { ...src };
  delete env.ANTHROPIC_API_KEY;
  if (String(src.CLAUDE_CODE_OAUTH_TOKEN || "").trim() !== "") {
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
  }
  return env;
}

/** 这一趟走的哪条路,只用于日志和 /health,**永远不返回任何密钥值**。 */
export function authMode(src = {}) {
  return String(src.CLAUDE_CODE_OAUTH_TOKEN || "").trim() !== "" ? "direct" : "proxy";
}

/* ═════════════ 二、口令 ═════════════ */

export function safeEqual(a, b) {
  // 「没给」永远不等于任何东西 —— 少一个请求头不该因为 String(undefined→"") 而
  // 撞上一个空配置。空串对空串仍然相等(那是配置问题,由调用方决定锁不锁)。
  if (a == null || b == null) return false;
  const x = Buffer.from(String(a ?? ""), "utf8");
  const y = Buffer.from(String(b ?? ""), "utf8");
  if (x.length !== y.length) return false;          // 长度本来就是公开信息
  return crypto.timingSafeEqual(x, y);
}

/** 盐每次启动换一把 = 重启即踢掉所有已登录会话。对一个维护入口来说这是想要的。 */
export function makeToken(pass, salt) {
  return crypto.createHash("sha256").update(`${salt}:${pass}`).digest("hex").slice(0, 32);
}

/* ═════════════ 三、stream-json 解析 ═════════════ */

/**
 * 把 `claude -p --output-format stream-json` 的 stdout 翻成本层认的事件。
 *
 * ⚠️ **必须自己处理跨块断行**:stdout 是字节流,一行 JSON 被切成两半是常态
 * (dwell-bridge 踩坑 1 是同一颗雷的 SSE 版本)。所以留一个 `buf` 扣住没写完的尾巴。
 * ⚠️ **解析不了的行一律丢掉,不抛异常**:CLI 升级随时可能多吐新类型的行,
 * 让一行看不懂的日志把整个工位打死是不值当的。
 *
 * 产出的事件(kind):
 *   ready       子进程起来了(system/init),带 model / tools
 *   text        正文增量
 *   think       思考增量
 *   tool        它要跑一个工具(name + input 摘要)
 *   tool_done   工具回来了(ok=false 表示被拒/出错)
 *   turn_end    这一轮结束(error / cost / 被中断)
 */
export function makeStreamParser() {
  let buf = "";
  return {
    push(chunk) {
      buf += String(chunk);
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";                       // 最后一段可能没写完,扣住
      const out = [];
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        let j;
        try { j = JSON.parse(s); } catch { continue; }
        out.push(...normalize(j));
      }
      return out;
    },
    /** 进程结束时把扣住的尾巴吐出来(正常情况下是空的)。 */
    flush() {
      const rest = buf; buf = "";
      const s = rest.trim();
      if (!s) return [];
      try { return normalize(JSON.parse(s)); } catch { return []; }
    },
  };
}

function normalize(j) {
  const out = [];
  if (j.type === "system" && j.subtype === "init") {
    out.push({ kind: "ready", model: j.model || "", tools: j.tools || [] });
    return out;
  }
  if (j.type === "stream_event") {
    const d = j.event?.delta || {};
    if (d.type === "text_delta" && d.text) out.push({ kind: "text", text: d.text });
    else if (d.type === "thinking_delta" && (d.thinking || d.text)) {
      out.push({ kind: "think", text: d.thinking || d.text });
    }
    return out;
  }
  if (j.type === "assistant") {
    for (const c of j.message?.content || []) {
      if (c.type === "tool_use") {
        out.push({ kind: "tool", name: c.name || "工具", input: summarizeInput(c.input) });
      }
    }
    return out;
  }
  if (j.type === "user") {
    for (const c of j.message?.content || []) {
      if (c.type === "tool_result") {
        out.push({ kind: "tool_done", ok: !c.is_error });
      } else if (c.type === "text" && /interrupted/i.test(c.text || "")) {
        // CLI 收到中断后会回插一条 "[Request interrupted by user]" 的 user 帧
        out.push({ kind: "interrupted" });
      }
    }
    return out;
  }
  if (j.type === "result") {
    out.push({
      kind: "turn_end",
      error: !!j.is_error,
      reason: j.terminal_reason || "",
      costUSD: typeof j.total_cost_usd === "number" ? j.total_cost_usd : 0,
    });
    return out;
  }
  return out;
}

/** 工具入参压成一行,**给人看的**,不要求可还原。长的截断,别把整份文件内容灌进记录。 */
export function summarizeInput(input, max = 160) {
  if (input == null) return "";
  let s;
  if (typeof input === "string") s = input;
  else if (typeof input === "object") {
    // 常见的几个键优先,读起来像话:命令、路径、关键词
    const pick = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url;
    s = pick != null ? String(pick) : JSON.stringify(input);
  } else s = String(input);
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/* ═════════════ 四、账本 ═════════════ */

/**
 * 界面上翻得到的记录。**不是 agent 的记忆** —— 它的记忆在自己那个 claude 进程里,
 * 收工就没了(这是刻意的,见手册《为什么不做常驻》)。
 * 这里只是让网页重新打开时还能看见刚才说过什么。
 */
export function makeLedger(cap = 2000) {
  let list = [];
  const trim = () => { if (list.length > cap) list = list.slice(-cap); };
  return {
    addHer(text) { list.push({ role: "her", text: String(text), ts: Date.now() }); trim(); return list.at(-1); },
    addGong(text, think) {
      list.push({ role: "gong", text: String(text), think: think ? String(think) : "", ts: Date.now() });
      trim(); return list.at(-1);
    },
    all() { return list.slice(); },
    count() { return list.length; },
    restore(arr) { list = Array.isArray(arr) ? arr.slice(-cap) : []; return list.length; },
    clear() { const n = list.length; list = []; return n; },
  };
}

/* ═════════════ 五、一轮的攒字器 ═════════════ */

/**
 * 把一轮里的事件攒成「正文 / 思考 / 工具行」三样。
 * 工具行写进**思考**那一栏(和晏那边的做法一致:`〔🔧 名字〕`),
 * 这样前端那间屋不用改就能把它折进灰字里。
 */
export function makeTurn() {
  let text = "", think = "", tools = 0, cost = 0, ended = false, errored = false, interrupted = false;
  return {
    feed(ev) {
      if (ev.kind === "text") text += ev.text;
      else if (ev.kind === "think") think += ev.text;
      else if (ev.kind === "tool") {
        tools++;
        think += `\n〔🔧 ${ev.name}〕${ev.input ? ` ${ev.input}` : ""}\n`;
      } else if (ev.kind === "interrupted") { interrupted = true; think += "\n〔⏸ 被你叫停〕\n"; }
      else if (ev.kind === "turn_end") { ended = true; errored = ev.error; cost += ev.costUSD || 0; }
    },
    get state() { return { text, think, tools, cost, ended, errored, interrupted }; },
    reset() { text = ""; think = ""; tools = 0; ended = false; errored = false; interrupted = false; },
  };
}

/* ═════════════ 六、给那间屋的回话 ═════════════ */

/**
 * `POST /api/gong` 要在**一次 HTTP 应答里**给出结果,而维护活经常跑得比一次请求长。
 * 所以超时之后如实回「还在干」,并告诉她下一步怎么办 —— **不要假装说完了**。
 *
 * ⚠️ 这段话本身就是这一版的「暂停键说明书」:那间屋的前端还没有按钮
 * (第一版刻意零前端改动),**再发一句话就是叫停 + 插话**,所以必须在这儿讲清楚。
 */
export function gongReply({ text, think, done, interrupted, errored }) {
  const body = String(text || "").trim();
  if (done) {
    if (errored && !body) return { reply: "（他这一轮出错了,没说出话来。看 /api/health 的 lastErr）", think };
    return { reply: body || "（他没说话）", think, done: true };
  }
  const note = interrupted
    ? "〔已叫停,你刚才那句我收到了〕"
    : "〔还在干活…再发一句「?」看进度;直接说话就是叫停我、并让我照你说的改方向〕";
  return { reply: (body ? body + "\n\n" : "") + note, think, done: false };
}

/* ═════════════ 七、开场白 ═════════════ */

/**
 * 每开一间工位,喂给它的第一句话 = 开场指令 + 这一版的权限边界 + 她这次要干的活。
 *
 * **为什么要拼开场指令**:接出去的那个 claude 是全新的,什么都不知道 ——
 * 它靠读手册把自己装回维修工(START-HERE → OPERATIONS 前四节)。
 * 这正是所有者平时手动粘贴的那段,这里替她粘。
 *
 * ⚠️ `boot.md` 的内容**必须和 `../OPERATIONS.md` 的《开场指令》保持一致**,
 * 那段改了这儿要跟着改(规矩 6:跨服务两边留指路)。
 */
export function buildBootPrompt(boot, task) {
  const t = String(task || "").trim();
  return `${String(boot || "").trim()}\n\n────────\n本次要干的活:\n${t}`;
}

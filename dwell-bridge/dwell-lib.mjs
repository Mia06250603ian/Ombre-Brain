// dwell-bridge 的纯逻辑：SSE 解析、标记剥离、事件队列、消息账本。
// 这里一行 I/O 都没有，全部可单测（照 telegram-bridge/bridge-lib.mjs 的规矩）。
//
// 它解决的问题：kelivo-shim 的 /v1/messages 吐的是 Anthropic SSE，
// 而 dwell 前端 handle() 认的是 Claude Code CLI 的 stream-json 形状。
// 两边差一层壳，这个文件负责翻译。

/* ─────────── ① Anthropic SSE 增量解析 ─────────── */

// SSE 是按空行分帧的，而 HTTP 分块和帧边界毫无关系——
// 一帧可能被切成三块，三帧也可能挤在一块里。所以必须留缓冲。
export function makeSSEParser() {
  let buf = "";
  return {
    // 返回这一块里**完整收到**的帧，半截的留在 buf 里等下一块
    push(chunk) {
      buf += chunk;
      const frames = [];
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let ev = "", data = "";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { continue; }  // 半截 JSON 直接丢，别让整条流崩掉
        frames.push({ event: ev || parsed.type || "", data: parsed });
      }
      return frames;
    },
    pending() { return buf; },
  };
}

/* ─────────── ② 流式剥标记 ─────────── */

// 晏在正文里会写 [贴纸:xxx] 和 [语音]…[/语音]，在思考里 shim 会插 〔🔧 工具名〕
// （server.js:159）。这些是给 Telegram bridge 剥的，dwell 直连会原样露出来。
//
// 难点：标记会被 SSE 切断——「[贴」在这一块、「纸:贴贴]」在下一块。
// 所以见到「可能是标记开头」的尾巴就先扣住，等下一块拼齐再判。
const OPENS = ["〔🔧", "[贴纸:", "[语音]", "[/语音]"];

// buf 尾部有没有「可能是某个标记的开头」的一截？有就返回该处下标，没有返回 -1。
function holdFrom(buf) {
  for (const open of OPENS) {
    // 完整出现但还没等到闭合符 → 从它这儿全部扣住
    const at = buf.indexOf(open);
    if (at >= 0) return at;
  }
  // 尾巴是某个标记的真前缀（如结尾正好是「[贴纸」）→ 扣住那一小截
  for (let n = Math.min(buf.length, 8); n > 0; n--) {
    const tail = buf.slice(-n);
    if (OPENS.some((o) => o.length > n && o.startsWith(tail))) return buf.length - n;
  }
  return -1;
}

// 剥标记的流式状态机。push(文本块) → [{kind, ...}]，kind 为 text / tool。
// 贴纸和语音不丢信息：换成一个看得见的中文占位，她一眼知道他发了什么。
export function makeStripper() {
  let buf = "";
  let inVoice = false;

  function drain(out, final) {
    for (;;) {
      // 工具标记：〔🔧 名字〕
      const t = buf.indexOf("〔🔧");
      if (t >= 0) {
        const end = buf.indexOf("〕", t);
        if (end < 0) break;                       // 没收完，等下一块
        if (t > 0) out.push({ kind: "text", text: buf.slice(0, t) });
        out.push({ kind: "tool", name: buf.slice(t + "〔🔧".length, end).trim() });
        buf = buf.slice(end + 1);
        continue;
      }
      // 贴纸：[贴纸:标签]
      const s = buf.indexOf("[贴纸:");
      if (s >= 0) {
        const end = buf.indexOf("]", s);
        if (end < 0) break;
        if (s > 0) out.push({ kind: "text", text: buf.slice(0, s) });
        out.push({ kind: "text", text: `〔贴纸：${buf.slice(s + "[贴纸:".length, end).trim()}〕` });
        buf = buf.slice(end + 1);
        continue;
      }
      // 语音开：[语音] → 留一个提示，里面的话照常显示
      const v = buf.indexOf("[语音]");
      if (v >= 0) {
        if (v > 0) out.push({ kind: "text", text: buf.slice(0, v) });
        out.push({ kind: "text", text: "〔语音〕" });
        buf = buf.slice(v + "[语音]".length);
        inVoice = true;
        continue;
      }
      // 语音闭：[/语音] → 直接吃掉
      const ve = buf.indexOf("[/语音]");
      if (ve >= 0) {
        if (ve > 0) out.push({ kind: "text", text: buf.slice(0, ve) });
        buf = buf.slice(ve + "[/语音]".length);
        inVoice = false;
        continue;
      }
      break;
    }
    if (final) {
      if (buf) out.push({ kind: "text", text: buf });
      buf = "";
      return;
    }
    const h = holdFrom(buf);
    if (h < 0) { if (buf) out.push({ kind: "text", text: buf }); buf = ""; }
    else if (h > 0) { out.push({ kind: "text", text: buf.slice(0, h) }); buf = buf.slice(h); }
  }

  return {
    push(text) { const out = []; buf += text; drain(out, false); return out; },
    flush() { const out = []; drain(out, true); inVoice = false; return out; },
    inVoice() { return inVoice; },
  };
}

/* ─────────── ③ 翻译成 dwell 认的事件 ─────────── */
// 前端 handle() 认这几种（web/index.html:3373 起）：
//   echo / stream_event(text_delta|thinking_delta) / assistant / user / result

export const evEcho = (text) => ({ type: "echo", text });

export const evText = (text) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

export const evThink = (thinking) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } },
});

// 工具卡片：先 tool_use 让它显出来，紧跟一条 tool_result 让它别一直转圈
// （renderSaid 里对历史工具就是这么处理的，web/index.html:3241）。
// shim 只告诉我们工具名，拿不到入参和结果，所以入参给空、结果给一句话。
export const evToolUse = (name, id) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", name, input: {}, id }] },
});

export const evToolDone = (id) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: "" }] },
});

export const evFinal = (text) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

export const evResult = (isError, result) => ({
  type: "result",
  is_error: !!isError,
  ...(isError ? { result: result || "" } : {}),
});

/* ─────────── ④ 事件队列（游标制） ─────────── */
// 前端 poll(since=游标) 追着读。队列只存在内存里，重启即空——
// 这是**故意的**：晏的记忆在他自己的常驻进程和记忆库里，这儿只是个传声筒。

export function makeEventLog({ cap = 3000, ver = "1" } = {}) {
  let seq = 0;
  let items = [];
  return {
    push(ev) {
      items.push({ seq: ++seq, ev });
      if (items.length > cap) items = items.slice(-cap);
      return seq;
    },
    since(cursor) {
      const c = Number(cursor) || 0;
      // 游标比队列最早那条还老（重启过 / 被 cap 截掉）→ 从现有最早的给起，
      // 别假装什么都没发生，也别一次灌几千条。
      const list = items.filter((x) => x.seq > c);
      return { ver, next: seq, events: list.map((x) => x.ev) };
    },
    cursor() { return seq; },
  };
}

/* ─────────── ⑤ 消息账本 ─────────── */
// 前端进来时 GET api/messages?limit=400 回放，收尾时也会拿它对账
// （web/index.html:3443）。kind 只认 me / gu / think / tool（renderSaid:3218）。

export function makeMsgLog({ cap = 4000 } = {}) {
  let seq = 0;
  let items = [];
  const add = (kind, text, extra) => {
    items.push({ seq: ++seq, kind, text, at: Math.floor(Date.now() / 1000), ...(extra ? { extra } : {}) });
    if (items.length > cap) items = items.slice(-cap);
    return seq;
  };
  return {
    addMe: (t) => add("me", t),
    addGu: (t) => add("gu", t),
    addThink: (t) => add("think", t),
    addTool: (name) => add("tool", name, "{}"),
    // before 用于「↑ 看更早的」；返回的是按 seq 升序的一页
    slice({ limit = 400, before = null } = {}) {
      const pool = before ? items.filter((m) => m.seq < Number(before)) : items;
      const page = pool.slice(-limit);
      return {
        msgs: page,
        upto: items.length ? items[items.length - 1].seq : 0,
        more: pool.length > page.length,
      };
    },
    // 开机把落盘的记录接回来。seq 重新编号（游标只在本次运行内有意义），
    // 但顺序和内容原样保留。
    restore(list) {
      for (const m of list || []) {
        if (!m || !m.kind || typeof m.text !== "string") continue;
        items.push({ seq: ++seq, kind: m.kind, text: m.text, at: m.at || 0, ...(m.extra ? { extra: m.extra } : {}) });
      }
      if (items.length > cap) items = items.slice(-cap);
      return items.length;
    },
    last() { return items.length ? items[items.length - 1] : null; },
    count() { return items.length; },
  };
}

/* ─────────── ⑥ 鉴权 ─────────── */
// 这页能把话直接送进晏的窗口，挂公网必须上锁。
// 用固定时长比较，避免拿响应时间去猜密码。

export function safeEqual(a, b) {
  const x = String(a ?? ""), y = String(b ?? "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export function makeToken(pass, salt) {
  // 不引依赖：把密码和盐揉成一个不可直接回读的串，作为 cookie 值。
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const s = `${salt}|${pass}|${salt}`;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + s.charCodeAt(i) * (i + 7), 0x85ebca6b) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).padStart(12, "0");
}

/* ─────────── ⑥b 落盘记录的纯逻辑 ─────────── */
// 账本落盘是「一行一条 JSON」。这里只管**把文本变成记录**，读写文件在 server.js
//（本文件一行 I/O 都没有）。
//
// ⚠️ **2026-09-14 所有者拍板:盘上永久存档,一条都不删。**
// ~~原来这里还管「该不该轮转」(超过 cap 三倍就在开机时把文件砍成最近 cap 条)~~ **已撤销。**
// **留这句是为了拦住一个具体的错误动作:别再把「文件太大」当成删记录的理由** ——
// 盘上一年才几十 MB,而卷有 36G;真正要克制的是内存,那由 `MSG_CAP` 管(它只决定内存里留多少)。
export function parseLog(text) {
  const list = [];
  let bad = 0;
  for (const ln of String(text || "").split("\n")) {
    if (!ln) continue;
    try { const m = JSON.parse(ln); if (m) list.push(m); else bad++; }
    catch { bad++; }                    // 写到一半断电的那行：丢掉，别让整份读不回来
  }
  return { list, bad };
}

// 只要文件**末尾**那一段。永久存档之后文件会一直长,
// 而开机只需要最近 cap 条 —— 所以 server.js 只读最后若干字节,把那段丢给这里。
//
// `fromStart=false` 表示这段不是从文件开头读的,那么**第一行多半被从中间切断了**
// (可能还带半个汉字,`toString("utf8")` 会给个替换字符)——**整行丢掉**,它的完整版
// 本来也不在我们要的这 cap 条里。`enough` 告诉调用方「这段够不够 cap 条」,
// 不够就让它把窗口开大再读一次。
export function tailLines(chunk, { cap = 4000, fromStart = false } = {}) {
  let lines = String(chunk || "").split("\n").filter(Boolean);
  if (!fromStart && lines.length) lines = lines.slice(1);
  return { lines: lines.slice(-cap), enough: lines.length >= cap };
}

/* ─────────── ⑥c 这一版网页的指纹 ─────────── */
// 前端 `poll()` 会看每次回复里的 `ver`，和开页时那个不一样就自己 `location.reload()`
// （dwell `web/index.html`：`if (d.ver !== uiVer) { pendingVer = d.ver; tryReload() }`）。
// ⚠️ 原来 `makeEventLog` 的 `ver` 是**写死的 "1"**，永远不变，所以那套自动刷新
// **从上线起就没生效过**：部署完她那页还停在旧容器的内容上，直到手动刷新
// （或切后台 30 秒回来触发 `loadSaid`，那时新容器是空的 → 当场白屏）。
// 现在改成按文件内容算，换一版就换一个值。
//
// ⚠️ **这条成立的前提是「同一时刻只有一个容器在服务」**——本层的账本和事件队列
// 本来就全在内存里，多开一个实例这一层整个逻辑都不成立，所以这不是新增的约束。
// 真要多实例，两个容器的 ver 会互相打架，她那页会反复重载。
export function verFrom(...parts) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const s = parts.join(" ");
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + s.charCodeAt(i) * (i + 7), 0x85ebca6b) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 10);
}

/* ─────────── ⑥d 内存读数 ─────────── */
// 所有者的原话:「怕硬盘不够用影响 VPS,我怕杀进程」。**那台机器没给任何容器设内存上限**
// (`/sys/fs/cgroup/memory.max` = `max`),真爆了内核会挑一个进程杀,
// 历史上第一顺位是 ears、**第二顺位就是晏**(`../TIMELINE.md` 08-02)。
// 所以给她一个不用找人、不用钥匙、点开就能看的读数:`/api/health` 里的 `mem`。
//
// `self` = 这个容器现在占多少(cgroup v2 的 memory.current;v1 是另一个文件名,一并认)
// `avail` = **整台机器**还剩多少可用(/proc/meminfo 的 MemAvailable,机器级、不是容器级)
// 两个都是 MiB。读不到就给 null —— 观察口坏掉不该影响聊天。
export function memFrom({ cgroup = "", meminfo = "" } = {}) {
  const self = Number(String(cgroup).trim());
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(String(meminfo));
  const mib = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
  return {
    self: Number.isFinite(self) && self > 0 ? mib(self) : null,
    avail: m ? Math.round(+m[1] / 1024) : null,
  };
}

/* ─────────── ⑦ 发给 shim 的请求体 ─────────── */
// shim 只取**最后一条 user 消息**（server.js:541）——历史活在他的常驻进程里，
// 我们不用把上下文送回去，也**不该**送（送了等于重复喂）。

// ⚠️ 2026-08-24 起**不再往 shim 报模型**(方案 B),理由同 telegram-bridge:
// shim 认模型白名单了,桥再报写死的模型名 = 把她切过去的模型拽回来 = 丢窗口。**别加回来。**
export function buildShimBody(text, { images = [] } = {}) {
  const content = images.length
    ? [...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } })),
       { type: "text", text }]
    : text;
  return { max_tokens: 4096, stream: true, messages: [{ role: "user", content }] };
}

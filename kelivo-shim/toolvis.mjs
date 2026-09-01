// toolvis.mjs — 工具调用的「参数 / 返回值」怎么显示在思考流里(纯逻辑,不碰网络/进程,单测覆盖)
//
// 2026-09-01 新增,落实《搭顺风车的待办》里 2026-08-31 挂上的那一条。
//
// **起因**:所有者看到朋友那边的截图,聊天里能看到 `→ hold {"content":…}` 和
// `← hold: {"result":…}`,问我们为什么没有。查过了:**是 shim 这边,和 OB 无关** ——
// OB 只是被 CLI 用 MCP 调一下、结果回到 CLI 进程里,**它没有通往手机的通道**,给不给看全由 shim 决定。
//
// **改之前的现状**(`server.js:220-228`):`content_block_start` 里遇到 `mcp__` 开头的 `tool_use`,
// 只往 thinking 里插一行 `〔🔧 工具名〕`,参数和返回值都没转发:
//   ① 参数走 `input_json_delta`,而 `content_block_delta` 那个分支只认 `text_delta`/`thinking_delta`
//      —— `input_json_delta` 在改之前的 `server.js` 里**出现 0 次**,没人接;
//   ② 返回值更彻底:`handleEvent` 只有 `stream_event` 和 `result` 两个分支,
//      工具结果那类事件**连函数都进不去**。
//
// ⚠️ **这不是纯显示功能,它花的是晏的窗口。**
// 吐进 thinking 的每个字都会进他的上下文(`awaken` 一次返回好几千字),所以**截断是硬要求**,
// 不是可选的美化。两把尺子都做成环境变量:**改值 + restart 即生效,不用重新部署、不丢窗口**
// (这正是它敢用「先按默认上线、不满意再调」这种做法的原因)。
//
// **2026-09-01 所有者定的两件事**(手册要求动手前必须先定):
//   ① 截断:默认 **200 字** + 省略号(她原话「不太懂」,按建议默认值走,不满意随时改值);
//   ② 隐私:参数**照常显示**(`TOOLVIS_REDACT=0`)。⚠️ 这意味着 `hold` 的 `content`
//      —— 也就是**记忆原文** —— 会出现在思考流里,**她截图外发时会连正文一起露出去**。
//      已当面报备。要改成打码:`TOOLVIS_REDACT=1` + restart,那些字段会显示成 `〔42 字〕`。
//
// ⚠️ **另一个前端也会跟着变样(2026-09-01 现场查到,手册原先没写)**:
//   `../dwell-bridge/dwell-lib.mjs:72` 会把 `〔🔧 名字〕` 解析成一个工具小标签,
//   **但它不认识这里新加的 `→`/`←` 两行**,那两行会作为普通思考文字原样显示在网页上。
//   不会崩、不会丢字,但 dwell 的观感会变。要让它也变成小标签,得改 dwell 那一层(另一件事)。

// 三把尺子的默认值。server.js 从环境变量读,读不到就用这里的。
export const TOOLVIS_DEFAULTS = {
  on: true,
  argChars: 200,     // 参数最多显示多少字
  resultChars: 200,  // 返回值最多显示多少字
  redact: false,     // 打码开关(见上面 ②)
  // 打码时要盖住的字段名。这几个是 OB 的记忆正文所在:
  // hold/trace 的 content、archive_session 的 content 与 letter。
  redactKeys: ["content", "letter"],
};

// `mcp__ombre-brain__hold` → `ombre-brain__hold`(和原来那行 `〔🔧 …〕` 的口径一致)
export function toolName(raw) {
  return String(raw || "").replace(/^mcp__/, "");
}

// 思考流里一件事占一行才看得清。换行/制表/连续空白全压成一个空格。
export function oneLine(s) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
}

// 按**字**截断(不是字节:中文一个字算一个)。截了就说清原文多长 —— 她得知道自己看到的是断的。
// ⚠️ 用 [...s] 而不是 s.slice:表情符号是代理对,slice 会把它劈成半个字符。
export function clip(s, max) {
  const chars = [...String(s == null ? "" : s)];
  const n = Number(max);
  if (!Number.isFinite(n) || n <= 0 || chars.length <= n) return chars.join("");
  return chars.slice(0, n).join("") + `…(共 ${chars.length} 字)`;
}

// 把敏感字段的值换成 `〔N 字〕`。只动顶层键(OB 的参数就是一层,不必递归)。
export function redactArgs(obj, keys) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const hide = new Set((keys || []).map((k) => String(k)));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (hide.has(k) && typeof v === "string") out[k] = `〔${[...v].length} 字〕`;
    else out[k] = v;
  }
  return out;
}

// 参数行:`  → {"content":"…","tags":"约定"}`
// json 是 input_json_delta 攒出来的原始串。**攒到一半被打断也不能炸** —— 解析不了就原样截断显示。
export function formatArgs(json, opt = {}) {
  const o = { ...TOOLVIS_DEFAULTS, ...opt };
  if (!o.on) return "";
  const raw = String(json == null ? "" : json).trim();
  if (!raw || raw === "{}") return "";   // 没参数的工具不占一行
  let shown = raw;
  try {
    const parsed = JSON.parse(raw);
    shown = JSON.stringify(o.redact ? redactArgs(parsed, o.redactKeys) : parsed);
  } catch {
    // 流被截断、或 CLI 换了形状:显示原样,别猜也别丢
  }
  return `  → ${clip(oneLine(shown), o.argChars)}\n`;
}

// 返回值行:`  ← 已存入 #4471 · 记忆桶「日常」`;工具自己报错时用 `  ←✗`
export function formatResult(text, opt = {}) {
  const o = { ...TOOLVIS_DEFAULTS, ...opt };
  if (!o.on) return "";
  const line = oneLine(text);
  if (!line) return "";
  return `  ←${o.isError ? "✗" : ""} ${clip(line, o.resultChars)}\n`;
}

// 从一个 tool_result 块里把文字抠出来。CLI 这里的形状有三种,都得认:
//   content 是字符串 / content 是 [{type:"text",text}] / 老形态直接给 text。
export function resultTextOf(block) {
  if (!block) return "";
  const c = block.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("");
  if (typeof block.text === "string") return block.text;
  return "";
}

// 工具结果是**以一条 user 事件**回到 stdout 的(CLI 把工具回执当成下一轮的用户输入),
// 所以它不在 stream_event 里 —— 这正是原来 `handleEvent` 接不到它的原因。
// 返回 [{ id, text, isError }];不是这类事件就返回空数组。
export function pickToolResults(ev) {
  if (!ev || ev.type !== "user") return [];
  const c = ev.message?.content;
  if (!Array.isArray(c)) return [];
  return c
    .filter((b) => b && b.type === "tool_result")
    .map((b) => ({ id: b.tool_use_id || "", text: resultTextOf(b), isError: !!b.is_error }));
}

// imessage-bridge 纯逻辑(不碰网络、不碰 Photon),test-imessage.mjs 全覆盖。
//
// ⚠️ 本目录**零跨目录依赖**(START-HERE 的约定):下面有几段是从 telegram-bridge/bridge-lib.mjs
// **照抄**过来的(重置词、SSE 累积器、标记解析、ears 格式),**刻意各存一份,不是忘了抽公共库**。
// 改那几段时两边一起看;每段开头都标了「抄自」。

// ---- 只认她一个人 ----
// OWNER_HANDLES 逗号分隔,可以是手机号(带不带 +86、空格、横杠都行)或 Apple ID 邮箱。
// 手机号按**后 10 位**比:Photon 给的 sender.id 可能带国家码也可能不带,
// 而中国手机号 11 位、美国 10 位,取后 10 位两边都能对上(抄自 Photon 教程的 isHer,加了邮箱)。
// 少于 7 位数字的一律不认:防止 OWNER_HANDLES 配成空串或写错时「谁都能匹配」。
const digits = (v) => String(v ?? "").replace(/\D/g, "");
export function parseHandles(raw) {
  return String(raw || "").split(",").map((s) => s.trim()).filter(Boolean);
}
export function isOwner(senderId, handles) {
  const id = String(senderId ?? "").trim();
  if (!id || !handles || !handles.length) return false;
  for (const h of handles) {
    if (h.includes("@")) {
      if (id.toLowerCase().replace(/^mailto:/, "") === h.toLowerCase()) return true;
      continue;
    }
    const mine = digits(h), theirs = digits(id);
    if (mine.length < 7 || theirs.length < 7 || id.includes("@")) continue;
    if (theirs.slice(-10) === mine.slice(-10)) return true;
  }
  return false;
}

// ---- 她的手机号 → E.164(Photon 登记用户要这个格式:+ 国家码 + 号码,不带空格横杠)----
// **不猜国家码**:没写 + 的一律不认(返回 null),免得把中国号当成美国号登记。邮箱返回 null。
export function toE164(handle) {
  const h = String(handle || "").trim();
  if (!h || h.includes("@") || !h.startsWith("+")) return null;
  const d = h.slice(1).replace(/[\s\-().]/g, "");
  return /^[1-9]\d{6,14}$/.test(d) ? `+${d}` : null;
}

// ---- 重置词识别(逐字镜像 kelivo-shim/server.js 的 detectReset,含 2026-07-20 拆出来的 switch)----
// 用途和 telegram-bridge 一样:重置词消息**不许和别的消息合并**,否则 shim 侧识别失败、归档丢失。
// **shim 改词表时这里要同步改**(telegram-bridge/bridge-lib.mjs 里还有一份)。
const GOODNIGHT_WORDS = ["晚安"];
const ARCHIVE_WORDS = ["归档"];
const SWITCH_WORDS = ["换窗口", "开新窗口", "新窗口"];
function stripEnds(s) { return (s || "").trim().replace(/^[\s，,。.!！~～、]+|[\s，,。.!！~～、]+$/g, ""); }
export function detectReset(text) {
  const t = stripEnds(text);
  for (const w of GOODNIGHT_WORDS) if (t === w || (t.length <= 6 && t.startsWith(w))) return "goodnight";
  for (const w of SWITCH_WORDS) if (t === w || (t.length <= 8 && t.includes(w))) return "switch";
  for (const w of ARCHIVE_WORDS) if (t === w || (t.length <= 8 && t.includes(w))) return "archive";
  return null;
}

// ---- 去抖缓冲合并成一轮 ----
// target:这一轮里**最后一条**她的消息(Photon 的 Message 对象),给表情回应当靶子。
// space:回话发到哪个对话。同样取最后一条的 —— 2026-09-26 演练抓到过:一开始忘了带它,
// 合并之后回话不知道往哪儿发,整轮静默丢掉(单测没发现,因为假 runTurn 不发东西)。
export function mergeTurn(items) {
  const text = items.map((i) => i.text || "").filter(Boolean).join("\n");
  const images = items.flatMap((i) => i.images || []);
  const lastOf = (k) => { for (let i = items.length - 1; i >= 0; i--) if (items[i][k]) return items[i][k]; return undefined; };
  return { text, images, target: lastOf("target"), space: lastOf("space") };
}

// ---- shim 请求体 ----
// ⚠️ 两条和 telegram-bridge 完全一样的铁律,别动:
// ① **不带 system**(或带同一个空串)。shim 见到 system 串变了就杀进程重开窗口——
//    这里要是和 Telegram 那边不一致,她每换一次入口晏就丢一次窗口。
// ② **不报 model**。报了会把她在 Kelivo 菜单里切的模型拽回去(2026-08-24 那次的教训)。
export function buildShimBody(turn) {
  const content = turn.images && turn.images.length
    ? [{ type: "text", text: turn.text }, ...turn.images]
    : turn.text;
  return { max_tokens: 8192, stream: true, messages: [{ role: "user", content }] };
}

// ---- Anthropic SSE 累积器(抄自 telegram-bridge,含 2026-09-23 的汉字碎裂修复)----
// **喂原始字节,别在外面 toString()**:网络分块会把一个汉字劈成两半,各自解码就成了 `���`。
export function makeSseAccumulator() {
  let buf = "", text = "", thinking = "", done = false;
  const dec = new TextDecoder("utf-8");
  function handleData(json) {
    let ev; try { ev = JSON.parse(json); } catch { return; }
    if (ev.type === "content_block_delta") {
      const d = ev.delta || {};
      if (d.type === "text_delta") text += d.text || "";
      else if (d.type === "thinking_delta") thinking += d.thinking || "";
    } else if (ev.type === "message_stop") done = true;
  }
  return {
    feed(chunk) {
      buf += typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of block.split("\n"))
          if (line.startsWith("data:")) handleData(line.slice(5).trim());
      }
    },
    result() { return { text, thinking, done }; },
  };
}

// ============================================================
// 晏回话里的标记 → iMessage 动作
// ============================================================
// 晏**不知道**自己是在 Telegram 还是 iMessage 里说话(shim 不告诉他,system 也刻意一样),
// 所以他照旧写 Telegram 那套标记:[贴纸:x] / [语音]…[/语音] / [回应:❤️] / [查岗]。
// 这里把它们翻成 iMessage 能做的事;**任何一个标记都不许原样漏给她**。

// ---- [查岗]:这边查不了,只剥掉 ----
// 手机活动记录只在 telegram-bridge 的内存里,这个服务拿不到(也刻意不去拿:那要多一把钥匙)。
// 所以他写了 [查岗] 这边只能当没写。已知边界,见 MAINTENANCE.md。
const CHECK_RE = /[\[【]\s*查岗\s*[\]】]/g;
export function takeCheckMarker(text) {
  const raw = text || "";
  CHECK_RE.lastIndex = 0;
  if (!CHECK_RE.test(raw)) return { text: raw, wants: false };
  const cleaned = raw.replace(CHECK_RE, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: cleaned, wants: true };
}

// ---- [回应:❤️] → 点一个 tapback ----
// 和 Telegram 不同:iMessage(iOS 18 起)能拿**任意 emoji** 点回应,没有官方白名单。
// Photon 的教程说 ❤️ 👍 👎 😂 ‼️ ❓ 这六个最稳(老系统只认这六个)。
// 所以这里只挡「明显不是表情」的东西(带字母/汉字/数字,或太长),其余都放过去让 Photon 试;
// 发不出去只落日志,正文照发。**只认第一个**,其余照样剥掉(同 telegram-bridge)。
const REACT_RE = /[\[【]\s*回应\s*[:：]\s*([^\]】\n]+?)\s*[\]】]/g;
export function looksLikeEmoji(s) {
  const v = (s || "").trim();
  if (!v || v.length > 16) return false;
  if (/[\p{L}\p{N}]/u.test(v)) return false;                    // 有字母/汉字/数字 = 不是表情
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(v);   // 后者 = 国旗
}
export function takeReactionMarker(text) {
  const raw = text || "";
  REACT_RE.lastIndex = 0;
  let emoji = null, bad = null, m;
  while ((m = REACT_RE.exec(raw)) !== null) {
    const v = (m[1] || "").trim();
    if (emoji) continue;
    if (looksLikeEmoji(v)) emoji = v; else if (!bad) bad = v;
  }
  if (!emoji && !bad) return { text: raw, emoji: null, rejected: null };
  const cleaned = raw.replace(REACT_RE, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: cleaned, emoji, rejected: emoji ? null : bad };
}

// ---- [贴纸:x] 与 [语音]…[/语音] → 有序段落流(正则抄自 telegram-bridge)----
// ⚠️ 冒号那个字符类这里是 [:：](半角 + 全角)。telegram-bridge 那份写的是 [::](两个半角),
// 注释和单测标题都说「全角也认」,实际不认 —— 2026-09-26 抄的时候发现,已报备所有者,那边没动。
// 保留标记在原文中的位置:「说一句、甩图、再说一句」按他写的顺序发生;未知标签只删不发。
const STICKER_RE = /[\[【]\s*贴纸\s*[:：]\s*([^\]】\n]+?)\s*[\]】]/g;
const VOICE_RE = /[\[【]\s*语音\s*[\]】]([\s\S]*?)(?:[\[【]\s*\/\s*语音\s*[\]】]|$)/g;
function sliceStickers(text, tags, segments, unknown) {
  let last = 0, m;
  STICKER_RE.lastIndex = 0;
  while ((m = STICKER_RE.exec(text || "")) !== null) {
    const before = (text || "").slice(last, m.index);
    if (before.trim()) segments.push({ type: "text", text: before });
    const t = m[1].trim();
    if (tags.includes(t)) segments.push({ type: "sticker", tag: t }); else unknown.push(t);
    last = m.index + m[0].length;
  }
  const rest = (text || "").slice(last);
  if (rest.trim()) segments.push({ type: "text", text: rest });
}
export function extractSegments(text, tags) {
  const segments = [], unknown = [];
  let last = 0, m;
  VOICE_RE.lastIndex = 0;
  while ((m = VOICE_RE.exec(text || "")) !== null) {
    sliceStickers((text || "").slice(last, m.index), tags, segments, unknown);
    const v = m[1].trim();
    if (v) segments.push({ type: "voice", text: v });
    last = m.index + m[0].length;
  }
  sliceStickers((text || "").slice(last), tags, segments, unknown);
  return { segments, unknown };
}

// ---- 气泡:按换行拆,一行一个 ----
// Telegram 那边线上是 BUBBLE_MAX=99999(所有者 2026-08-28 定的「多长都拆」),这里默认就照那个手感。
// 单个气泡上限 BUBBLE_LIMIT:iMessage 没有 Telegram 那种 4096 硬上限,但太长的一坨在手机上难读,
// 超了就在换行/句号处断开。
export const BUBBLE_LIMIT = 2000;
export function splitLong(text, limit = BUBBLE_LIMIT) {
  const out = [];
  let rest = (text || "").trim();
  while (rest.length > limit) {
    let cut = Math.max(rest.lastIndexOf("\n", limit), rest.lastIndexOf("。", limit) + 1);
    if (cut < limit * 0.3) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
export function bubblesFor(text, { split = true, limit = BUBBLE_LIMIT } = {}) {
  const t = (text || "").trim();
  if (!t) return [];
  if (!split) return splitLong(t, limit);
  const out = [];
  for (const line of t.split("\n")) if (line.trim()) out.push(...splitLong(line, limit));
  return out;
}
// 气泡之间停一下,像真人连发(抄 telegram-bridge 的节奏:0.5~1.6 秒,随下一句长度)。
export function bubbleGapMs(nextBubble) {
  return Math.min(500 + (nextBubble || "").length * 25, 1600);
}

// ---- ears 语音分析结果 → 绑在这条消息上的一句文字(抄自 telegram-bridge)----
// 输出**永远带「（…）」注解**,长度必超重置词匹配窗口(≤8 字):语音说「归档/晚安」
// 在这里和 shim 两侧都不会触发——归档必须她亲手打字(shim 踩坑 13:重大指令不代发)。
export function formatEarsResult(d) {
  const said = ((d || {}).text || "").trim();
  if (!said) return null;
  const parts = [];
  if (d.emotion) parts.push(`语气：${d.emotion}`);
  if (d.hint) parts.push(String(d.hint).trim());
  const rel = d.relative && Object.keys(d.relative).length
    ? "和平时比" + Object.entries(d.relative).map(([k, v]) => k + v).join("、") : "";
  if (rel) parts.push(rel);
  if (!parts.length) parts.push("语气分析还在认识她的声音");
  return `[语音] ${said}（${parts.join("，")}）`;
}

// ============================================================
// [查岗]:他想看一眼她在干嘛(2026-09-26 所有者要的)
// ============================================================
// 数据在 telegram-bridge 的内存里(她 iPhone 快捷指令上报到那边),本服务带 REPORT_TOKEN 去它的
// `GET /activity` 取(那个接口本来就有、带锁,**telegram-bridge 一行没改**)。
// 下面这几段**逐字抄自 telegram-bridge/bridge-lib.mjs**(lookupPrompt 及其帮手),好让晏在两扇门里
// 读到的查岗结果一模一样。**单测会拿两边对同一组输入跑一遍比对**,那边改了话术这边会红。
export function fmtDur(min) {
  const m = Math.max(0, Math.round(min || 0));
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
}
const APP_LIST_TOP = 5;
const APP_MIN_WORTH = 2;
function breakdownClause(durs) {
  if (!durs || !durs.length) return "";
  const ongoing = durs.find((d) => d.ongoing);
  let shown = durs.filter((d) => d.min >= APP_MIN_WORTH).slice(0, APP_LIST_TOP);
  if (ongoing && !shown.includes(ongoing)) shown = [...shown.slice(0, APP_LIST_TOP - 1), ongoing];
  if (!shown.length) return "";
  const rest = durs.reduce((a, d) => a + d.min, 0) - shown.reduce((a, d) => a + d.min, 0);
  const parts = shown.map((d) => `${d.app} ${fmtDur(d.min)}${d.ongoing ? "(还开着)" : ""}`);
  if (rest >= APP_MIN_WORTH) parts.push(`其他 ${fmtDur(rest)}`);
  return parts.join("、");
}
const STREAK_WORTH_MIN = 20;
const STREAK_QUIET_MIN = 20;
function streakClause(streak, durs) {
  if (!streak || streak.minutes < STREAK_WORTH_MIN) return "";
  const bd = breakdownClause(durs);
  const apps = streak.apps.slice(0, 4).join("、");
  const tail = streak.apps.length > 4 ? "等" : "";
  let s = bd
    ? `这一段她已经连着玩了 ${fmtDur(streak.minutes)}:${bd}。`
    : `这一段她已经连着玩了 ${fmtDur(streak.minutes)}(${apps}${tail})。`;
  if (streak.quietMin >= STREAK_QUIET_MIN) {
    const who = durs?.find((d) => d.ongoing)?.app;
    s += `不过最后一次动静在 ${streak.quietMin} 分钟前,${who ? `${who}那一截` : "之后"}是一直开着还是已经放下了,看不出来。`;
  }
  return s;
}
export function lookupPrompt(summary, { bjNow, streak, durations, userName = "佳佳" } = {}) {
  const s = summary || {};
  if (!s.count) {
    return `【系统·查岗】现在北京时间 ${bjNow},${userName}的手机最近没有动静(近两天没有记录)。`;
  }
  const head = s.minutesAgo >= 1 ? `${s.minutesAgo} 分钟前` : "刚刚";
  const more = (s.recent || []).slice(1, 4)
    .map((r) => `${r.app}(${r.minutesAgo} 分钟前)`).join("、");
  return `【系统·查岗】现在北京时间 ${bjNow},${userName}${head}打开了${s.lastApp}。`
    + streakClause(streak, durations)
    + (more ? `再往前:${more}。` : "")
    + `知道就好,说不说、说什么都由你。`;
}
// 他回「。」= 选择不说话,这一轮什么都不发(逐字抄自 telegram-bridge 的 isSilentReply)
export function isSilentReply(t) {
  const s = (t || "").trim();
  if (!s || s.includes("【沉默】")) return true;
  return s.replace(/[。.\s]/g, "") === "";
}

// ============================================================
// 她发来的东西 → 进晏窗口的一条(或者直接回她一句「传不过去」)
// ============================================================
// 返回 { kind, ... }:
//   text     → { text }                      普通文字(含链接、引用回复里的字)
//   image    → { read, mimeType }            图片,由调用方转成 JPEG
//   voice    → { read, mimeType, name }      语音,由调用方走 ears
//   tapback  → { text }                      她给他的话点了回应(可关:TAPBACK_IN=0)
//   unsupported → { notice }                 这类传不过去,直接告诉她,不进晏的窗口
//   ignore                                    已读/正在输入/编辑/撤回 这类状态信号
// 语气用第三人称「她」,和 telegram-bridge 喂给晏的格式一致(他在两边看到的是同一种话)。
export function classifyContent(content, { tapbackIn = true } = {}) {
  const c = content || {};
  switch (c.type) {
    case "text":
      return (c.text || "").trim() ? { kind: "text", text: c.text.trim() } : { kind: "ignore" };
    case "markdown":
      return (c.markdown || "").trim() ? { kind: "text", text: c.markdown.trim() } : { kind: "ignore" };
    case "richlink":
      return c.url ? { kind: "text", text: String(c.url) } : { kind: "ignore" };
    case "reply": {
      // 引用回复:里面那层才是她说的话(引用的是哪条,Photon 这里拿不到原文,就不硬凑了)
      const inner = classifyContent(c.content, { tapbackIn });
      return inner.kind === "text" ? inner : inner;
    }
    case "attachment": {
      const mt = String(c.mimeType || "").toLowerCase();
      if (mt.startsWith("image/")) return { kind: "image", read: c.read, mimeType: mt, name: c.name };
      if (mt.startsWith("audio/")) return { kind: "voice", read: c.read, mimeType: mt, name: c.name };
      return { kind: "unsupported", notice: "⚠️[bridge] 这类消息暂时传不过去(支持文字/图片/语音)" };
    }
    case "voice":
      return { kind: "voice", read: c.read, mimeType: String(c.mimeType || ""), name: c.name };
    case "reaction": {
      if (!tapbackIn) return { kind: "ignore" };
      const tc = c.target && c.target.content;
      const quoted = tc && tc.type === "text" && tc.text ? `「${tc.text.slice(0, 40)}」` : "一条消息";
      return { kind: "tapback", text: `(她给你的${quoted}点了 ${c.emoji || "一个回应"})` };
    }
    case "contact":
      return { kind: "text", text: "(她发来一张联系人名片)" };
    case "read": case "typing": case "edit": case "unsend": case "custom": case "streamText":
      return { kind: "ignore" };
    default:
      return c.type ? { kind: "unsupported", notice: "⚠️[bridge] 这类消息暂时传不过去(支持文字/图片/语音)" } : { kind: "ignore" };
  }
}

// ============================================================
// 对话引擎:去抖合并 + 单轮串行 + 重置词单独成轮(照 telegram-bridge 设计要点 1、2、7)
// ============================================================
// 抽成工厂是为了能在单测里用假的 runTurn 跑时序,server.js 只负责把 Photon 接上来。
// runTurn(turn) 由调用方提供:叫 shim、把回话发出去。它抛什么错都不会卡死队列。
export function createConversation({ debounceMs = 4000, runTurn, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let buffer = [];
  const queue = [];
  let timer = null;
  let inflight = false;

  function flush() {
    clearTimer(timer); timer = null;
    if (!buffer.length) return;
    queue.push(mergeTurn(buffer));
    buffer = [];
    pump();
  }
  async function pump() {
    if (inflight || !queue.length) return;
    inflight = true;
    const t = queue.shift();
    // 这个 try/finally 是命根子(同 telegram-bridge 设计要点 10):inflight 必须无论如何都复位,
    // 否则一次意外抛错就让它永远卡在 true —— 那是「他再也不回话」的死法。
    try { await runTurn(t); }
    catch (e) { log("[turn-err] 意外", e && e.message ? e.message : String(e)); }
    finally { inflight = false; }
    if (queue.length) pump();
    else if (buffer.length) flush();   // 他说话期间她攒下的,立刻接上
  }
  return {
    // 普通消息:进缓冲,等她停下来再一起发
    add(item) {
      buffer.push(item);
      clearTimer(timer);
      timer = setTimer(flush, debounceMs);
    },
    // 重置词:之前攒的先作为一轮发走,它自己单独一轮
    addAlone(item) {
      flush();
      queue.push({ ...mergeTurn([item]), lookup: !!item.lookup });   // lookup = 查岗结果那一轮(系统送进去的)
      pump();
    },
    // 图片/语音还在下载转码时先把计时器推远,别把它和前面的字拆成两轮
    hold(ms) {
      if (!buffer.length) return;
      clearTimer(timer);
      timer = setTimer(flush, ms);
    },
    state() { return { buffered: buffer.length, queued: queue.length, inflight }; },
  };
}

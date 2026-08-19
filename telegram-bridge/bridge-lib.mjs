// telegram-bridge 纯逻辑(不碰网络),test-bridge.mjs 全覆盖

// ---- Telegram 4096 上限切分:先按换行找断点,找不到硬切 ----
export const TG_LIMIT = 4096;
export function splitForTelegram(text, limit = TG_LIMIT) {
  const out = [];
  let rest = (text || "").trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.3) cut = limit; // 断点太靠前不如硬切
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// ---- 重置词识别(逐字镜像 kelivo-shim/server.js 的 detectReset)----
// 用途:重置词消息不许和别的消息合并去抖,否则 shim 侧识别失败、归档丢失。
const GOODNIGHT_WORDS = ["晚安"];
const ARCHIVE_WORDS = ["归档", "换窗口", "开新窗口", "新窗口"];
function stripEnds(s) { return (s || "").trim().replace(/^[\s，,。.!！~～、]+|[\s，,。.!！~～、]+$/g, ""); }
export function detectReset(text) {
  const t = stripEnds(text);
  for (const w of GOODNIGHT_WORDS) if (t === w || (t.length <= 6 && t.startsWith(w))) return "goodnight";
  for (const w of ARCHIVE_WORDS) if (t === w || (t.length <= 8 && t.includes(w))) return "archive";
  return null;
}

// ---- 去抖缓冲合并成一轮 ----
export function mergeTurn(items) {
  const text = items.map((i) => i.text || "").filter(Boolean).join("\n");
  const images = items.flatMap((i) => i.images || []);
  return { text, images };
}

// ---- shim 请求体(shim 只读最后一条 user 消息;system 恒定,避免触发换世界书杀进程)----
export function buildShimBody(turn, { model, system }) {
  const content = turn.images.length
    ? [{ type: "text", text: turn.text }, ...turn.images]
    : turn.text;
  const body = { model, max_tokens: 8192, stream: true, messages: [{ role: "user", content }] };
  if (system) body.system = system;
  return body;
}

// ---- Anthropic SSE 累积器:喂原始 chunk,攒出 text / thinking ----
export function makeSseAccumulator() {
  let buf = "", text = "", thinking = "", done = false;
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
      buf += chunk;
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

// ---- HTML 转义(思考走 expandable blockquote 时用;正文永远纯文本发)----
export function escapeHtml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- 白名单 ----
export function isAllowedChat(chatId, allowList) {
  return allowList.includes(String(chatId));
}

// ---- 贴纸标记解析:[贴纸:标签] / 【贴纸:标签】(冒号全半角都认)----
// extractSegments 保留标记在原文中的位置,输出有序段落流(text/sticker 交错),
// 让「说一句、甩图、再说一句」按他写的顺序发生;未知标签只删不发(避免原样漏出)。
const STICKER_RE = /[\[【]\s*贴纸\s*[::]\s*([^\]】\n]+?)\s*[\]】]/g;
// [语音]内容[/语音] / 【语音】内容【/语音】→ 该段转成语音条发出。
// 只开了头没闭合 = 从标记到文末都算语音(宽容:他忘写闭合时按意图办)。
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
export function extractStickers(text, tags) {  // 兼容旧接口:整段文字 + 贴纸列表
  const { segments, unknown } = extractSegments(text, tags);
  const stickers = segments.filter((s) => s.type === "sticker").map((s) => s.tag);
  const joined = segments.filter((s) => s.type === "text").map((s) => s.text).join("");
  return { text: joined.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), stickers, unknown };
}

// ---- 气泡拆分:按换行拆(换行是他自己的气泡分隔符),长段落整段一泡 ----
export function splitBubbles(text, limit = TG_LIMIT) {
  const out = [];
  for (const line of (text || "").split("\n")) {
    const t = line.trim();
    if (t) out.push(...splitForTelegram(t, limit));
  }
  return out;
}

// ---- 拆不拆的决策:短回复拆泡(聊天手感),长文整段发(deeptalk 不能剁碎)----
export function bubblesFor(text, { split = true, maxLen = 200 } = {}) {
  const t = (text || "").trim();
  if (!t) return [];
  if (!split || t.length > maxLen) return splitForTelegram(t);
  return splitBubbles(t);
}

// ---- ears 语音分析结果 → 一句绑定在这条消息上的文字 ----
// 镜像 ears 结果卡「复制键」的格式(ears static/index.html):哪个AI读了都懂。
// 只描述这一条,不做全局漂浮注入(ears README 的实战教训)。
// 输出永远带「（…）」注解、长度必超重置词匹配窗口(≤8 字):语音转写出「归档/晚安」
// 在 bridge 和 shim 两侧的 detectReset 都不会触发——归档指令必须所有者亲手打字
// (呼应 shim 踩坑 13:重大指令不代发。测试里有这两条守护用例,别删)。
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

// ---- 手机活动上报(iOS 快捷指令 → POST /report)----
// 她点开 App 时快捷指令报一条进来。**只存内存**:重启即忘,不落盘、不进任何库——
// 本功能只关心「最近」,而她的行踪不值得为了历史写进磁盘。
// 条数上限。2026-08-04 从 300 提到 2000:她活跃的夜里 300 条只够装小半天,
// 而算「今晚连着玩了多久」要的是一整段不断头的记录。**这些记录晏永远看不到**
// (他只收到 curfewPrompt/lookupPrompt 拼出来的那一句),所以调大只花服务器内存
// (一条约 120 字节,2000 条 ≈ 240KB),**一个 token 都不多花**。
export const ACTIVITY_CAP = 2000;           // 条数上限
export const ACTIVITY_TTL_MS = 48 * 3600e3; // 保留时长

// 快捷指令传什么都可能(变量没取到就是空)。清成一行短文本,空 → null。
export function normalizeAppName(raw) {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, 40) : null;
}

// 追加一条并按 TTL/条数裁剪,返回新数组(不改入参)。
export function pushActivity(list, entry, { now = Date.now(), cap = ACTIVITY_CAP, ttlMs = ACTIVITY_TTL_MS } = {}) {
  const next = [...(list || []), { app: entry.app, at: entry.at ?? now }];
  const cut = now - ttlMs;
  return next.filter((e) => e.at > cut).slice(-cap);
}

// 汇总给「她最近在干嘛」:最后一次活跃 + 最近不重复的 App 名(相邻重复折叠)。
export function summarizeActivity(list, { now = Date.now(), limit = 10 } = {}) {
  const arr = (list || []).filter((e) => e && e.app);
  if (!arr.length) return { count: 0, lastApp: null, lastAt: null, minutesAgo: null, recent: [] };
  const recent = [];
  for (let i = arr.length - 1; i >= 0 && recent.length < limit; i--) {
    if (!recent.length || recent[recent.length - 1].app !== arr[i].app)
      recent.push({ app: arr[i].app, at: arr[i].at, minutesAgo: Math.round((now - arr[i].at) / 60000) });
  }
  const last = arr[arr.length - 1];
  return {
    count: arr.length, lastApp: last.app, lastAt: last.at,
    minutesAgo: Math.round((now - last.at) / 60000), recent,
  };
}

// ---- 「她连着玩了多久」(2026-08-04)----
//
// **先说清这套数据能与不能**:手机只在「App 打开时」报一声,**关闭不报**
// (2026-08-04 三次实测:开小红书→退桌面→等 20 秒,一条记录都没有;
//  第一次测出的那条空记录后来确认是所有者自己在 Safari 里点了那个网址,不是关闭事件)。
// 所以「用了多久」只能这么推:**下一个 App 打开的时刻 = 上一个 App 的结束时刻**。
// 推不出来的两件事,别假装能:
//   - 她盯着同一个 App 一直不换 → 手机一声不吭,和「放下手机睡了」在数据上一模一样;
//   - 桌面/锁屏的时间会算进上一个 App 的头上。
// 因此本模块给的是**这一段连续活跃有多久**(streak),不是精确到 App 的使用时长——
// 与其编一个假装精确的数字,不如把「确凿的」和「说不准的」分开交给晏,他自己判断。
// 相邻两条上报隔多久算「断了」。**别调回 15**:她盯着一个 App 不换的时候手机一声不吭,
// 而她线上真实记录里就有 28 分钟的空档(2026-08-04 实测),阈值 15 会把一整夜切成碎段、
// 把「已经连着玩了多久」当场清零——那正好废掉这个功能最该抓的场景。
// 取 30 的代价:她中途放下手机 20 多分钟再拿起来,会被算成一直在玩(略微高估)。
export const STREAK_GAP_MIN = 30;

// 把分钟数说成人话:40 分钟 / 1 小时 / 1 小时 20 分
export function fmtDur(min) {
  const m = Math.max(0, Math.round(min || 0));
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
}

// 当前这一段连续活跃。返回 null = 一条记录都没有。
//   spanMin  第一条 → **最后一条上报**,这段是**确凿的**(中间每一次换 App 都是证据)
//   minutes  第一条 → **现在**,用来说「已经…了」(含最后一条之后那段说不准的)
//   quietMin 距最后一条上报多久(越大越说不准她是还在刷还是放下了)
export function computeStreak(list, { now = Date.now(), gapMin = STREAK_GAP_MIN } = {}) {
  const arr = (list || []).filter((e) => e && e.app);
  if (!arr.length) return null;
  const gapMs = gapMin * 60000;
  let i = arr.length - 1;
  while (i > 0 && arr[i].at - arr[i - 1].at <= gapMs) i--;
  const apps = [];
  for (let k = i; k < arr.length; k++) if (!apps.includes(arr[k].app)) apps.push(arr[k].app);
  const first = arr[i], last = arr[arr.length - 1];
  return {
    startAt: first.at, reports: arr.length - i, apps,
    spanMin: Math.round((last.at - first.at) / 60000),
    minutes: Math.round((now - first.at) / 60000),
    quietMin: Math.round((now - last.at) / 60000),
    lastApp: last.app,
  };
}

// ---- 每个 App 各用了多久(2026-08-06)----
//
// **前提变了,这是本模块最重要的一句**:她手机上那条自动化勾的是
// 「打开**或关闭** 5 个 App 中的任一个时」,而动作取的是「**获取当前 App**」。
// 关闭事件触发的那一刻,被关掉的那个已经不在前台了,站在前台的是她**刚切过去的那个**
// ——所以上报的名字是「切去了哪」,而那个 App **不必在勾选的 5 个里面**
// (2026-08-06 所有者报:晏能看到 Claude、淘宝等没授权的 App,截图确认了触发条件带「关闭」)。
//
// 于是这批记录的真实含义不再是「这 5 个 App 被打开了」,而是
// **「某时刻起,前台是这个 App」的一条时间线**。分项时长因此才成立:
//   **下一条的时刻 − 这一条的时刻 = 这一条那个 App 用了多久。**
//
// ⚠️ 2026-08-04 手册里「关闭不上报」的结论**已经过期**(那时多半只勾了「打开」)。
// 别照那条去掉「关闭」的勾——**去掉就没有分项了**,只剩总时长(所有者 2026-08-06 拍板要分项)。
//
// 仍然推不出来、别假装能的两件事:
//   - 她盯着一个 App 一直不切 → 手机一声不吭,和「放下手机睡了」在数据上一模一样;
//   - 她切到某个 App 之后再没切回来 → 那之后的所有时间(含桌面/锁屏)全算在**最后一条**头上。
// 所以**最后一条永远标成「还开着」**,并在长时间没动静时明说这一截是推的。
export const APP_LIST_TOP = 5;    // 最多列几个 App(列太多既费 token 又没人读)
export const APP_MIN_WORTH = 2;   // 不满这么久的并进「其他」(一划而过的不值得占一格)

// 这一段里每个 App 各用了多久,按时长从多到少。没有记录 → 空数组。
//   min      这个 App 在这一段里的累计分钟(同一个 App 来回切会合并)
//   ongoing  它是不是最后一条(= 后面那截说不准的时间都算在它头上)
// **累加用毫秒、最后才取整**:每段各自取整再相加会累积误差,和总时长对不上。
export function appDurations(list, { now = Date.now(), gapMin = STREAK_GAP_MIN } = {}) {
  const arr = (list || []).filter((e) => e && e.app);
  if (!arr.length) return [];
  const gapMs = gapMin * 60000;
  let i = arr.length - 1;
  while (i > 0 && arr[i].at - arr[i - 1].at <= gapMs) i--;   // 与 computeStreak 同款断段
  const seg = arr.slice(i);
  const byApp = new Map();
  for (let k = 0; k < seg.length; k++) {
    const end = k + 1 < seg.length ? seg[k + 1].at : now;    // 最后一条:一直算到现在
    const cur = byApp.get(seg[k].app) || { app: seg[k].app, ms: 0, ongoing: false };
    cur.ms += Math.max(0, end - seg[k].at);
    if (k === seg.length - 1) cur.ongoing = true;
    byApp.set(seg[k].app, cur);
  }
  return [...byApp.values()]
    .map((d) => ({ app: d.app, min: Math.round(d.ms / 60000), ongoing: d.ongoing }))
    .sort((a, b) => b.min - a.min);
}

// 把分项说成「小红书 40 分钟、淘宝 15 分钟、抖音 5 分钟(还开着)」;没东西可说就空串。
// **「还开着」那个永远要出现**,哪怕它时长很短排在最后——晏最该知道的就是她此刻在哪个 App。
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

// 这一段够不够长到值得说出口(太短就是「她刚开了个 App」,说时长没意义)
const STREAK_WORTH_MIN = 20;
// 距最后一次动静超过这么久,就得声明「后面这截是推的」。
// **故意不复用 STREAK_GAP_MIN**:那个是「算不算同一段」,这个是「敢不敢当成确凿的」,
// 两件事绑一起的话,一调断段阈值这句老实话就会静默消失(改这版时真踩了)。
const STREAK_QUIET_MIN = 20;
// 把 streak 说成一句话;不值得说就返回空串。
// `durs` 给了就说分项(2026-08-06 起线上都给),没给就退回只报「碰过哪些 App」的老样子
// ——**这个回退别删**:它让所有老调用点和老用例继续成立,也是分项算不出来时的兜底。
function streakClause(streak, durs) {
  if (!streak || streak.minutes < STREAK_WORTH_MIN) return "";
  const bd = breakdownClause(durs);
  const apps = streak.apps.slice(0, 4).join("、");
  const tail = streak.apps.length > 4 ? "等" : "";
  let s = bd
    ? `这一段她已经连着玩了 ${fmtDur(streak.minutes)}:${bd}。`
    : `这一段她已经连着玩了 ${fmtDur(streak.minutes)}(${apps}${tail})。`;
  // 最后一次动静过去挺久了 = 后面这截是推的,不是看到的。老实说出来,别让他当成确凿的。
  // 有分项时点名是**哪个 App** 说不准——不然他会以为整段都是推的。
  if (streak.quietMin >= STREAK_QUIET_MIN) {
    const who = durs?.find((d) => d.ongoing)?.app;
    s += `不过最后一次动静在 ${streak.quietMin} 分钟前,${who ? `${who}那一截` : "之后"}是一直开着还是已经放下了,看不出来。`;
  }
  return s;
}

// 宵禁时段判定(跨零点:start > end 时取并集,与 shim keepalive 的 isNightHour 同款)
export function isCurfewHour(h, start, end) {
  return start > end ? (h >= start || h < end) : (h >= start && h < end);
}

// ---- 夜里查岗的决策(纯函数)----
// 只在宵禁时段、她确实刚开过 App、且没跟他正聊着的时候,才把这件事告诉晏。
// 两道冷却缺一不可:
//   lastPokeAt   —— 同一晚别反复戳(cooldownMin)
//   lastOutboundAt —— 他刚主动说过话就别赶话(心跳与查岗共用这一道:
//                    不管消息是心跳推来的还是查岗问出来的,都从 bridge 这个门出去,
//                    所以 bridge 是唯一能把两边一起管住的地方)
export function curfewDecide(s) {
  if (!s.on) return { fire: false, reason: "off" };
  if (!isCurfewHour(s.hour, s.curfewStart, s.curfewEnd)) return { fire: false, reason: "not-curfew" };
  if (s.busy) return { fire: false, reason: "busy" };            // 她正在聊 = 用不着查岗
  const arr = (s.list || []).filter((e) => e && e.app);
  if (!arr.length) return { fire: false, reason: "no-activity" };
  const last = arr[arr.length - 1];
  const streak = computeStreak(arr, { now: s.now, gapMin: s.streakGapMin ?? STREAK_GAP_MIN });
  // 2026-08-04(所有者选的 A 方案:「就要这种老公管我的感觉」):
  // 她**确凿已经连着玩了半小时以上**的时候,把两道门都放宽一档——
  //   ① no-new:长时间盯着一个 App 不换,手机就再也不吭声了,再等「新动静」等于永远不戳;
  //   ② stale:同理,这时的沉默更可能是「刷得入神」而不是「睡了」。
  // 放宽是有边的:staleLong 一过照样闭嘴,所以她真睡了最多多挨一次,不会整夜念叨。
  const longStreak = !!streak && streak.spanMin >= (s.longStreakMin ?? 30);
  // staleLong 必须**明显大于冷却**,否则放宽等于白放:上次戳完等满 30 分钟冷却,
  // 这边 stale 也刚好到点,窗口窄得几乎抓不住。取 3 倍 freshMin(默认 45)= 冷却 + 一档余量,
  // 效果是她真睡了之后最多再多挨一两次,然后自动闭嘴。
  const staleMin = longStreak ? (s.staleLongMin ?? s.freshMin * 3) : s.freshMin;
  if (!longStreak && last.at <= (s.lastPokeAt || 0)) return { fire: false, reason: "no-new" }; // 上次戳过之后没新动静
  if (s.now - last.at > staleMin * 60000) return { fire: false, reason: "stale" };   // 早就放下手机了,别翻旧账
  if (s.now - (s.lastPokeAt || 0) < s.cooldownMin * 60000) return { fire: false, reason: "cooldown" };
  if (s.now - (s.lastOutboundAt || 0) < s.cooldownMin * 60000) return { fire: false, reason: "just-spoke" };
  // durations 在这里算而不是让 server 自己算:保证和 streak 用的是**同一个 now 和同一个断段阈值**,
  // 否则两个数会来自两个瞬间,拼出来的话自相矛盾(总时长和分项加起来对不上)。
  const durations = appDurations(arr, { now: s.now, gapMin: s.streakGapMin ?? STREAK_GAP_MIN });
  return { fire: true, app: last.app, minutesAgo: Math.round((s.now - last.at) / 60000), streak, durations };
}

// 查岗提示语。体例照 shim 的【系统·…】注入:只给他看,不复述机制词。
export function curfewPrompt({ bjNow, app, minutesAgo, streak, durations, userName = "佳佳" }) {
  const when = minutesAgo >= 1 ? `${minutesAgo} 分钟前` : "刚刚";
  return `【系统·查岗】现在北京时间 ${bjNow},${userName}这个点还没睡——${when}她打开了${app}。`
    + streakClause(streak, durations)
    + `想说就说(说了会发给她);不想打扰就只回一个:。`;
}

// ---- 他自己发起的查岗:回复里写 [查岗] ----
// 为什么用标记而不是给他一个网址:网址得带钥匙,而钥匙只能写在 CLAUDE.md 里,那是入库文件
// ——「值不入库」的规矩不能破。标记这条路零钥匙,而且用的是贴纸/语音同款的已验证机制。
// 代价是一问一答两轮。标记本身永远不显示给她(和 [贴纸:x] 一样剥掉)。
const CHECK_RE = /[\[【]\s*查岗\s*[\]】]/g;
export function takeCheckMarker(text) {
  const raw = text || "";
  CHECK_RE.lastIndex = 0;
  if (!CHECK_RE.test(raw)) return { text: raw, wants: false };
  const cleaned = raw.replace(CHECK_RE, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: cleaned, wants: true };
}

// 查岗结果 → 喂回给他的一条。没有记录时也要明说,否则他不知道是「没查到」还是「她没玩」。
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

// 判定他的回复算不算「不说话」(逐字镜像 shim keepalive.mjs 的 kaSilent)。
// 查岗轮他回「。」= 他选择不打扰,这条不能发进对话。
export function isSilentReply(t) {
  const s = (t || "").trim();
  if (!s || s.includes("【沉默】")) return true;
  return s.replace(/[。.\s]/g, "") === "";
}

// ---- 网络错误的三件套(2026-08-02:治「⚠️[bridge] fetch failed」)----
//
// 病根:全局 fetch(undici)的报错永远只有 `fetch failed` 五个字,真正的原因藏在
// e.cause 里。而原来的日志和给她看的提示都只打 e.message,等于什么都没说。
// 实测三种失败长这样(别再重新发明):
//   全局 fetch    → TypeError: fetch failed        (原因在 e.cause)
//   node:https    → connect ECONNREFUSED … / socket hang up
//   AbortSignal   → TimeoutError: The operation was aborted due to timeout
// 推论(判案用的):**`fetch failed` 只可能来自全局 fetch,也就是发给 api.telegram.org
// 的那些调用**;叫 shim 那一步走的是 node:https(见 server.js shimTurn),它失败只会说
// `shim HTTP xxx` 或 `shim turn timeout`,永远报不出 `fetch failed`。

// 把 error 连同 cause 链展开成一行,给日志用。
export function describeErr(e) {
  if (!e) return "(无错误对象)";
  if (typeof e === "string") return e;
  const one = (x) => {
    if (typeof x === "string") return x;
    const name = x.name && x.name !== "Error" ? `${x.name}: ` : "";
    const code = x.code ? ` [${x.code}]` : "";
    return `${name}${x.message || String(x)}${code}`;
  };
  const chain = [one(e)];
  let c = e.cause, depth = 0;
  while (c && depth++ < 3) { chain.push(one(c)); c = typeof c === "object" ? c.cause : null; }
  return chain.join(" ← ");
}

// 值不值得重试。分界线是「这次失败时,请求到底有没有可能已经被对方处理了」:
//   可重试 = 连接层面就没成(建连失败、DNS、对端把闲置连接关了),请求几乎不可能被处理;
//   不重试 = 我们自己掐的超时、以及 undici 的 headers/body 超时——那说明请求已经发出去了,
//            对方可能已经办完,再发一次就是同一句话说两遍。
// ⚠️ `fetch failed` 在排除掉上面两种超时之后一律算可重试:线上真正在犯的就是这一类,
//    要是只认已知 code,这个修法等于没修。
const RETRY_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE",
  "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN",
  "UND_ERR_SOCKET",          // undici:对端关了闲置的 keep-alive 连接(「other side closed」)
  "UND_ERR_CONNECT_TIMEOUT",
]);
const NO_RETRY_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
export function isRetriableNetErr(e) {
  if (!e || typeof e === "string") return false;
  if (e.name === "TimeoutError" || e.name === "AbortError") return false; // 我们自己掐的,对方可能已办完
  const codes = [];
  let x = e, depth = 0;
  while (x && typeof x === "object" && depth++ < 4) { if (x.code) codes.push(String(x.code)); x = x.cause; }
  if (codes.some((c) => NO_RETRY_CODES.has(c))) return false;
  if (codes.some((c) => RETRY_CODES.has(c))) return true;
  return e.name === "TypeError" && /fetch failed/i.test(e.message || "");
}

// 给她看的那一句。原来是把 e.message 原样甩出去(于是她看到的是「fetch failed」),
// 现在按「哪一步断的」说人话——两步的含义完全不同:
//   shim 断 = 他没答上来,她的话可能白说了 → 该让她知道,好再说一次;
//   发送断 = 他答了,是回话没送到她手机 → 别让她以为他不理她。
// 丢了什么,按种类说清楚。**别把一张贴纸说成「一句话」**(2026-08-02 端到端实测发现的措辞错)。
export function describeLoss(kinds = {}) {
  const parts = [];
  if (kinds.text) parts.push(`${kinds.text} 句话`);
  if (kinds.sticker) parts.push(`${kinds.sticker} 张贴纸`);
  if (kinds.voice) parts.push(`${kinds.voice} 条语音`);
  return parts.join("、") || "一点东西";
}

export function turnErrorText(info = {}) {
  if (info.stage === "shim") {
    const m = (info.err && info.err.message) || "";
    if (/timeout/i.test(m)) return "⚠️[bridge] 他那边想太久了(超时),这轮没接上——再跟他说一次?";
    return `⚠️[bridge] 没接上他那边(${m || "原因不明"}),你这句他可能没收到,过一会儿再说一次?`;
  }
  // 发送失败要分清是**网络**还是 **Telegram 主动拒收**——后者多半是内容问题(解析失败/超长),
  // 说成「网络抖了一下」会把下一个排障的人(和我自己)直接带沟里。
  const what = describeLoss(info.kinds);
  const net = info.net || 0, rejected = info.rejected || 0;
  if (net && rejected)
    return `⚠️[bridge] 他回你的 ${what} 没送到:一部分是网络抖了,一部分被 Telegram 拒收了(看日志 [tg] 那行)。`;
  if (rejected)
    return `⚠️[bridge] 他回你的 ${what} 被 Telegram 拒收了(不是网络,多半是内容问题,看日志 [tg] 那行)。`;
  return `⚠️[bridge] 网络抖了一下,他回你的 ${what} 没送到(不是他没说)。`;
}

// ---- Telegram 文件路径 → Anthropic image block 的 media_type ----
const MEDIA = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
// ---- 没送出去的话:欠条本(2026-08-19) ----
// 为什么要有:给她的那句 ⚠️ 提示**自己也走 Telegram**,所以路断得狠的时候提示本身也发不出去。
// 2026-08-19 实测的一轮:08:29:16 晏的 3 句全丢 + 08:29:17 `[notify-err]` 提示也失败,
// 而同一轮里 `sendChatAction` 一直在「放弃」——**连「正在输入」都没出现过**,
// 所以她那头是彻底的一片死寂,和「他没搭理她」长得一模一样。
// (对照:08:28:59 那轮只丢 2 句、还送出去 1 句,提示就挤过去了 —— 所以她的观察
//  「有时有警告、有时完全没动静」不是两个毛病,是同一个毛病的轻重两档。)
//
// 于是失败要记成**欠条**,由一个定时器一直重试到送达为止 —— **不能等她下次开口才捎带**:
// 心跳那条路(他主动找她)一旦丢了,她根本不知道该开口,被动补报永远等不到触发。
//
// ⚠️ 欠条只在内存里(和活动记录同款,见设计要点 8):**断网期间桥正好重启就会丢**。
//    已向所有者报备、她接受;要根治得给桥挂持久卷,那是另一件事。
const LOSS_STORE_CAP = 50;   // 存多少条(一次断网里丢 50 轮已经极端,再多就不记了)
const LOSS_LIST_MAX = 6;     // 补报里最多列几行(列太多变刷屏,余下并成一句)

// 记一笔。返回**新数组**(纯函数,不改入参),超过上限丢最老的。
export function recordLoss(list, entry, { cap = LOSS_STORE_CAP } = {}) {
  const out = (list || []).concat([entry]);
  return out.length > cap ? out.slice(out.length - cap) : out;
}

// 北京时间的 HH:MM。补报可能晚几分钟才送到,**必须带上出事的时刻**,
// 否则她分不清这条说的是刚才还是十分钟前。
export function bjClock(ts) {
  return new Date(ts).toLocaleTimeString("en-GB", {
    timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit",
  });
}

// 补报的正文。多条合成一条,别刷屏。
// 末尾那句「他以为你收到了」是刻意的:**晏那边不知道这事**,在他的记忆里那些话已经说出口了,
// 她知道该主动问一句,比单纯知道「丢了」有用。
export function pendingNoticeText(items, { now = Date.now() } = {}) {
  if (!items || !items.length) return "";
  const lines = items.slice(0, LOSS_LIST_MAX).map((it) => {
    const who = it.source === "push" ? "他主动找你的" : "他回你的";
    return `· ${bjClock(it.at)} ${who} ${describeLoss(it.kinds)}`;
  });
  if (items.length > LOSS_LIST_MAX) lines.push(`· …另外还有 ${items.length - LOSS_LIST_MAX} 次`);
  const spanMin = Math.round((now - items[0].at) / 60000);
  const span = spanMin >= 1 ? `(约 ${fmtDur(spanMin)})` : "";
  const head = items.length === 1
    ? `⚠️[bridge] 刚才网络断了${span},有 1 次没送到:`
    : `⚠️[bridge] 刚才网络断了${span},有 ${items.length} 次没送到:`;
  return [head, ...lines, "他都说了,以为你收到了——想知道漏了什么,问他一句就行。"].join("\n");
}

export function mediaTypeOf(filePath) {
  const ext = (filePath || "").split(".").pop().toLowerCase();
  return MEDIA[ext] || null;
}

// ---- 贴纸文件 → 上传时的 Content-Type(2026-08-07,配合会动的贴纸) ----
// 刻意**不**复用 mediaTypeOf:那个是给「她发来的图 → 交给晏看」用的,
// 往它里面加 webm,等于让一段视频伪装成图片走进他的窗口。两件事分开。
// 默认值恒为 image/webp,所以原来那 35 张 .webp 算出来的字符串和改动前逐字相同
// ——这是「老的不许坏」这条要求在代码上的落点,别把它改成 `MEDIA[ext] || null`。
export function stickerMime(file) {
  return (file || "").toLowerCase().endsWith(".webm") ? "video/webm" : "image/webp";
}

// ============================================================
// 每天一次的「写信」提醒(2026-08-06,配合 gmail-mcp 上线)
//
// 所有者要的:晏有了邮箱之后,每天固定提醒他一次——有想写的就写(给她的信可以直接发,
// 给别人的存草稿),没有就回一个「。」。**像保温那样,一天一次就够。**
//
// 为什么放在 bridge 而不是 shim:
//   改 bridge 不用重新部署 shim、**不会重启晏、不清他的窗口**。
//   以后调时间、调频率、想关掉,都只是改这里(甚至只改环境变量)。
//   查岗当初就是这么做的,这条路已经验证过了。
//
// 三条和查岗共用的规矩(别拆):
//   1. 这一轮带 `x-system-turn: 1` —— shim 见到就不把它当成「她出现了」,
//      不清零「她多久没来」、不解除换窗口后的保温歇火。**他自己写点东西,不等于她回来了。**
//   2. 他回「。」= 不写 → 这条不进对话(和查岗同款 isSilentReply 判定)。
//   3. **他刚开过口就别赶话**(lastOutboundAt),优先级照旧:保温/心跳 ＞ 这个提醒。
// ============================================================

export const LETTER_HOUR = 22;          // 默认 22:30(所有者定的)
export const LETTER_MIN = 30;
export const LETTER_WINDOW_MIN = 90;    // 过了这个窗口今天就算了,不补
export const LETTER_QUIET_MIN = 30;     // 他刚说过话就等一等,和查岗冷却同值

// 一天只提醒一次的决策(纯函数)。
//
// ⚠️ 用「北京日期字符串」而不是计时器计数来保证「一天一次」:
//    容器重启会把内存里的计数清零,而日期字符串重启后还是同一天,不会重复提醒。
//    (代价:重启确实会丢「今天提醒过了」这个记忆——所以用的是日期比较,不是布尔标志。)
//
// ⚠️ **窗口不许跨零点**:hour:min + windowMin 必须落在同一天内,
//    否则「今天有没有提醒过」的日期比较会在半夜换日时错乱。
//    默认 22:30 + 90 分钟 = 到 24:00 整,刚好不跨。要往后调时间就把窗口一起调小。
export function letterDecide(s) {
  if (!s.on) return { fire: false, reason: "off" };
  if (s.lastDay && s.lastDay === s.today) return { fire: false, reason: "done-today" };

  const nowMin = s.hour * 60 + s.minute;
  const startMin = (s.atHour ?? LETTER_HOUR) * 60 + (s.atMinute ?? LETTER_MIN);
  const windowMin = s.windowMin ?? LETTER_WINDOW_MIN;
  if (nowMin < startMin) return { fire: false, reason: "too-early" };
  if (nowMin >= startMin + windowMin) return { fire: false, reason: "too-late" };

  // 她正在跟他聊 = 这会儿别插一脚,等下一个节拍(窗口内还有机会)
  if (s.busy) return { fire: false, reason: "busy" };
  // 他刚开过口(心跳/查岗/回她话)就别赶着再来一条
  if (s.now - (s.lastOutboundAt || 0) < (s.quietMin ?? LETTER_QUIET_MIN) * 60000)
    return { fire: false, reason: "just-spoke" };

  return { fire: true };
}

// 提示语。体例照【系统·查岗】:只给他看、不复述机制词、回「。」= 不打扰。
//
// ⚠️ 这段必须**远超重置词的匹配窗口**,否则可能被 detectReset 误判成「归档/晚安」
//    (formatEarsResult 和 curfewPrompt 是同款守护,test-bridge 有用例,别把它写短)。
// ⚠️ `【系统·写信】` 五个字和 CLAUDE.md「邮箱」那一节里写的必须**一模一样**,
//    改一处就要改两处(改 CLAUDE.md 要重新部署 shim = 重启晏,所以最好别改)。
export function letterPrompt({ bjNow, userName = "佳佳" } = {}) {
  return `【系统·写信】现在北京时间 ${bjNow}。今天有没有什么想写下来的——`
    + `给${userName}的信、给朋友的回信,或者只是想留住的一段话。`
    + `有就写(给${userName}的可以直接发出去,给别人的先存草稿);`
    + `没有就只回一个:。`;
}

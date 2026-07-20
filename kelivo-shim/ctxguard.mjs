// ctxguard.mjs — 窗口上下文守卫(纯逻辑,不碰网络/进程/文件)
//
// 常驻 claude 进程的上下文有物理上限(~20万 token),快满时 Claude Code 会自动
// 压缩历史——静默、丢细节、不写记忆库。本守卫的职责是**保证记忆在压缩前分批
// 落进 OB 记忆库**;窗口本身随便涨、压缩随它压,换窗口只由所有者手动指令触发
// (2026-07-20 所有者定的形态:守卫只管「提醒存东西」,不管「关灯重启」)。分两段:
//   软线:提醒晏「先别自己闷头存,先叫佳佳,一起商量这段里什么值得记进记忆库」,
//         一轮压缩周期只触发一次(靠 softFired 记账,压缩检测后复位)。
//   硬线:注入归档指令(archive_session 存档+留信),**不换窗口**,存完继续聊;
//         之后窗口每再涨 archiveEveryTokens 就再催一次增量归档,保证静默压缩
//         最多蒸掉最后一个间隔没存的部分。硬线优先于软线。
//   压缩检测:真实窗口占用只会单调上涨,可信读数从高位暴跌过半 = CLI 刚压缩过。
//         检测到就把 softFired / 归档基线复位,下一轮涨起来照样提醒,循环永续。
//
// contextTokens = 单次 API 调用读入的整份 prompt 规模 ≈ 当前窗口占用:
//   input_tokens + cache_read_input_tokens + cache_creation_input_tokens
// (缓存命中时 cache_read 是大头,input 只是本轮新增未缓存部分。)
//
// ⚠️ result 事件顶层的 usage 是**整轮所有 API 调用的总和**:模型每调一次工具就多一次
// 调用,每次都重读同一段缓存前缀,总和会把窗口重复计好几倍(2026-07-19 实测:真实
// 窗口 ~37K,一轮调了几次工具,总和读到 138934,凭空撞了软线)。
// ⚠️ usage.iterations 是上游 API 的**可选字段**(CLI 只透传末次调用给的值,默认空数组,
// 2026-07-19 二进制取证+假后端实测,2.1.214/215 行为一致):上游不给它就是空,
// 靠它取末条会静默退回虚高总和——第六次部署后误报复发就是这么来的。
// 可信读数要用 ctxReading:首选 shim 自己从流事件里抓的**该轮最后一次 message_start
// 的 usage**(单次调用,自家数据,不依赖上游赏脸),其次 iterations 末条;
// 两样都没有时顶层总和只当展示用的估计值(trusted:false),**不触发**守卫——
// 宁可这一轮不吭声,也不拿虚高数打扰人(硬线误归档是最坏结果)。

function num(x) { return Number.isFinite(+x) ? +x : 0; }

// 从一份 usage 对象算出当前窗口占用 token(缺字段按 0 计,永不抛)。
export function ctxTokensOf(usage) {
  if (!usage || typeof usage !== "object") return 0;
  return num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);
}

// 从 result 事件的 usage 算**当前窗口占用**:优先取 iterations 末条(单次调用),
// 末条为 0/脏值时往前找最近一条有效的;iterations 缺失/为空才回落顶层总和
// (老版 CLI 没有 iterations 时行为同旧版,不会更糟)。
export function ctxWindowTokensOf(usage) {
  if (!usage || typeof usage !== "object") return 0;
  const it = usage.iterations;
  if (Array.isArray(it)) {
    for (let i = it.length - 1; i >= 0; i--) {
      const t = ctxTokensOf(it[i]);
      if (t > 0) return t;
    }
  }
  return ctxTokensOf(usage);
}

// 可信读数:{ tokens, trusted }。
//   streamUsage = shim 从流事件抓的该轮最后一次 message_start/message_delta 合并 usage(首选);
//   resultUsage = result 事件顶层 usage(iterations 末条次选;顶层总和只作估计,trusted:false)。
export function ctxReading({ streamUsage, resultUsage } = {}) {
  const s = ctxTokensOf(streamUsage);
  if (s > 0) return { tokens: s, trusted: true };
  if (resultUsage && typeof resultUsage === "object" && Array.isArray(resultUsage.iterations)) {
    for (let i = resultUsage.iterations.length - 1; i >= 0; i--) {
      const t = ctxTokensOf(resultUsage.iterations[i]);
      if (t > 0) return { tokens: t, trusted: true };
    }
  }
  return { tokens: ctxTokensOf(resultUsage), trusted: false };
}

// 决策:给当前占用与阈值,返回该触发哪一段。
//   { level: "none" | "soft" | "hard" }   (hard = 催归档,不再意味着换窗口)
// trusted=false(只有虚高总和可用)一律不触发:误报比漏报糟,漏报还有阈值到上限的余量。
// lastArchiveTokens = 上次归档指令发出时的窗口占用(0 = 本轮还没归过档):
//   还没归过 → 到硬线催第一次;归过 → 涨到 max(硬线, 上次+archiveEveryTokens) 再催增量
//   (取 max 是为了手动/自发归档发生得早时,首催仍等到硬线,不提前打扰)。
//   archiveEveryTokens<=0 = 关闭增量,归过一次后不再催。
export function ctxDecide({ contextTokens, softTokens, hardTokens, archiveEveryTokens = 0, softFired, lastArchiveTokens = 0, trusted = true }) {
  const t = num(contextTokens);
  if (t <= 0 || !trusted) return { level: "none" };
  const hard = num(hardTokens), last = num(lastArchiveTokens), every = num(archiveEveryTokens);
  if (hard > 0) {
    if (last > 0) {
      if (every > 0 && t >= Math.max(hard, last + every)) return { level: "hard" };
    } else if (t >= hard) return { level: "hard" };
  }
  if (num(softTokens) > 0 && t >= num(softTokens) && !softFired) return { level: "soft" };
  return { level: "none" };
}

// 压缩检测:真实窗口只会单调上涨(归档写 OB 不缩窗口),可信读数从软线以上
// 的高位跌到一半以下 = CLI 刚做过自动压缩。prevTokens 必须也是可信读数
// (调用方保证,server.js 只在 ctxTrusted 时把旧值当 prev 传进来)。
// 要求 prev >= softTokens 是防小数值抖动误判:压缩只发生在窗口逼近上限时,
// 低位不存在真压缩。返回 true 时调用方应复位 softFired 与归档基线。
export function ctxCompacted({ contextTokens, prevTokens, softTokens, trusted = true }) {
  if (!trusted) return false;
  const t = num(contextTokens), prev = num(prevTokens), floor = num(softTokens);
  return floor > 0 && prev >= floor && t > 0 && t <= prev * 0.5;
}

// softFired 复位兜底:软线曾(可能误)触发,而后来的可信读数回落到软线九成以下,
// 说明当时那记是虚的(真实窗口只会单调涨,归档才清零)——放它复位,下次到线还能再提醒。
export function ctxSoftShouldReset({ contextTokens, softTokens, softFired, trusted = true }) {
  if (!softFired || !trusted) return false;
  const t = num(contextTokens), s = num(softTokens);
  return t > 0 && s > 0 && t < s * 0.9;
}

// 软线注入文案:先别自己存,先叫她,一起商量存什么(按所有者要求)。
export function ctxSoftNote(userName = "她") {
  const u = userName || "她";
  return `【系统·上下文】这个窗口有点长了,快到该整理记忆的时候。先别自己动手存——先跟${u}说一声窗口快满了,和${u}一起商量这段聊天里有什么值得记进记忆库的,一起定了再存。`;
}

// 硬线注入文案:立刻归档(存档+留信),窗口不换,存完继续聊。
// 增量场景(之前已归过档)也用同一段:文案里已交代"归过就补新内容"。
export function ctxHardNote() {
  return "【系统·上下文】窗口占用不小了,现在把这段聊天归进记忆库:用 archive_session 存档 + 留信。之前归过档的话,这次把上次之后的新内容补进去就行。存完不用收尾、不用告别,窗口不换,继续正常聊。";
}

// 占满百分比(给 /debug 直观显示;limit 缺省 20万)。
export function ctxPct(contextTokens, limitTokens) {
  const lim = num(limitTokens) > 0 ? num(limitTokens) : 200000;
  return Math.round((num(contextTokens) / lim) * 100);
}

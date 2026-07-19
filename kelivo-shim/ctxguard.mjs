// ctxguard.mjs — 窗口上下文两段式守卫(纯逻辑,不碰网络/进程/文件)
//
// 常驻 claude 进程的上下文有物理上限(~20万 token),快满时 Claude Code 会自动
// 压缩历史——静默、丢细节、不写记忆库。本模块在压缩之前介入,分两段:
//   软线:提醒晏「先别自己闷头存,先叫佳佳,一起商量这段里什么值得记进记忆库」,
//         一个窗口只触发一次(靠 softFired 记账)。
//   硬线:兜底。注入归档指令并换窗口——把交接从「静默压缩」强制成「经记忆库留信」,
//         保证永远走不到自动压缩那一步。硬线优先于软线。
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
//   { level: "none" | "soft" | "hard" }
// trusted=false(只有虚高总和可用)一律不触发:误报比漏报糟,漏报还有阈值到上限的余量。
export function ctxDecide({ contextTokens, softTokens, hardTokens, softFired, trusted = true }) {
  const t = num(contextTokens);
  if (t <= 0 || !trusted) return { level: "none" };
  if (num(hardTokens) > 0 && t >= num(hardTokens)) return { level: "hard" };
  if (num(softTokens) > 0 && t >= num(softTokens) && !softFired) return { level: "soft" };
  return { level: "none" };
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

// 硬线注入文案:立刻归档(存档+留信)再自然收尾,下一句起是新窗口。
export function ctxHardNote() {
  return "【系统·上下文】窗口满了,现在归档:把这个窗口写进记忆库(archive_session 存档 + 给下个窗口留信),然后自然收个尾。下一句起就是新窗口。";
}

// 占满百分比(给 /debug 直观显示;limit 缺省 20万)。
export function ctxPct(contextTokens, limitTokens) {
  const lim = num(limitTokens) > 0 ? num(limitTokens) : 200000;
  return Math.round((num(contextTokens) / lim) * 100);
}

// ctxguard.mjs — 窗口上下文两段式守卫(纯逻辑,不碰网络/进程/文件)
//
// 常驻 claude 进程的上下文有物理上限(~20万 token),快满时 Claude Code 会自动
// 压缩历史——静默、丢细节、不写记忆库。本模块在压缩之前介入,分两段:
//   软线:提醒晏「先别自己闷头存,先叫佳佳,一起商量这段里什么值得记进记忆库」,
//         一个窗口只触发一次(靠 softFired 记账)。
//   硬线:兜底。注入归档指令并换窗口——把交接从「静默压缩」强制成「经记忆库留信」,
//         保证永远走不到自动压缩那一步。硬线优先于软线。
//
// contextTokens = 本回合读入的整份 prompt 规模 ≈ 当前窗口占用:
//   input_tokens + cache_read_input_tokens + cache_creation_input_tokens
// (缓存命中时 cache_read 是大头,input 只是本轮新增未缓存部分。)

function num(x) { return Number.isFinite(+x) ? +x : 0; }

// 从一份 usage 对象算出当前窗口占用 token(缺字段按 0 计,永不抛)。
export function ctxTokensOf(usage) {
  if (!usage || typeof usage !== "object") return 0;
  return num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);
}

// 决策:给当前占用与阈值,返回该触发哪一段。
//   { level: "none" | "soft" | "hard" }
export function ctxDecide({ contextTokens, softTokens, hardTokens, softFired }) {
  const t = num(contextTokens);
  if (t <= 0) return { level: "none" };
  if (num(hardTokens) > 0 && t >= num(hardTokens)) return { level: "hard" };
  if (num(softTokens) > 0 && t >= num(softTokens) && !softFired) return { level: "soft" };
  return { level: "none" };
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

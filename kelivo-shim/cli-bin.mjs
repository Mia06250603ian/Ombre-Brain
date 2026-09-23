// cli-bin.mjs — 双引擎:按模型挑用哪一份 Claude Code(纯逻辑,不碰网络/进程/文件)
//
// 为什么要两份(2026-09-23):
//   主力 CLI 钉死在 2.1.215,**不认识 claude-opus-5-5**(实发出去空回、usage 全零 ——
//   朋友那份同款 shim `Arisu-cross/kelivo-shim` 4372e2d 实测;我们这边 strings 搜 2.1.215
//   二进制里 `claude-opus-5-5` 0 处)。整体升级 CLI 又会碰到 4.6:2.1.280 在替换模式下
//   会往第一条消息前多塞环境信息和「You are powered by Opus 4.6」(2026-09-23 抓包逐字比对)。
//   所以另装一份新版,**只给 NEXT_CLI_MODELS 点名的模型用**,其余模型逐字走老路 ——
//   这是所有者「4.6 绝对安全」那条硬约束能守住的关键。
//
// ⚠️ 和朋友那版不一样的一处(刻意的):新版没装上时,他们把 5.5 退回主力 CLI 去跑。
//   那等于让一个不认识 5.5 的 CLI 去跑 5.5 = **空回、全线不报警**。我们改成:
//   新版不在 → 5.5 **从菜单里拿掉**(白名单随之拒绝,请求沿用当前模型),
//   `/health` 报出被拿掉的名字,看门狗据此叫人。宁可菜单里少一项,也别让晏突然哑掉。
//
// ⚠️ 新版那份要额外带的环境变量(只加给新版的子进程,主力那份一个字都不变):
//   - CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000 + CLAUDE_CODE_DISABLE_1M_CONTEXT=1:
//     5.5 原生是 100 万窗口。**只设后者限不住原生 100 万的模型**(2.1.280 自己的提示原话:
//     「the 200K limit isn't enforced for <model> … set CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000」)。
//     2026-09-23 假后端二分实测:两个一起设,5.5 在 **166796 不压 / 166991 压**,
//     与 4.6 在 2.1.215 上**逐位相同**(线上实测 166942)——三条上下文线一条都不用动。
//     想给 5.5「大桌子」就改 NEXT_CLI_WINDOW,⚠️ 但那时三条线必须按模型分开,否则会在 15.5 万就催归档。
//   - CLAUDE_CODE_TOTAL_TOKENS_REMINDER=off:2.1.280 会往消息里塞一行
//     `<total_tokens>N tokens left</total_tokens>`,关掉(实测有效)。
//     它同时塞的环境信息和「You are powered by …」**没找到开关**,只能认 —— 好在只影响 5.5。

export function parseModelList(s) {
  return [...new Set(String(s ?? "").split(/[,;\s]+/)
    .map((x) => x.trim().replace(/^["']+|["']+$/g, "")).filter(Boolean))];
}

// 窗口上限写错(非数字/负数/小于 5 万)就回落默认,别静默变成「不设上限」。
// 显式写 0 = 不设上限(= 放开到模型原生窗口,「大桌子」);只有这一个值能关掉它。
export function nextWindow(raw, dflt = 200000) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return dflt;
  const n = Number(String(raw).trim());
  if (n === 0) return 0;
  return Number.isInteger(n) && n >= 50000 ? n : dflt;
}

export function nextEnv(window) {
  const e = { CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off" };
  if (window > 0) {
    e.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
    e.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(window);
  }
  return e;
}

// 这个模型该用哪一份。返回 { bin, which, extraEnv }。
//   which = "main" | "next";extraEnv 只在 next 时非空。
// 新版不在(nextBin 空)时一律 main —— 但那种情况下需要新版的模型根本进不了菜单(见 menuModels),
// 唯一还能走到这里的是 BRAIN_MODEL 本身被设成了新模型:那是配置错,/health 的 cli 字段会露出来。
export function pickCli(model, { bin, nextBin = "", nextModels = [], window = 200000 } = {}) {
  if (nextBin && nextModels.includes(model)) return { bin: nextBin, which: "next", extraEnv: nextEnv(window) };
  return { bin, which: "main", extraEnv: {} };
}

// 菜单:新版不在时,把需要新版的模型拿掉。返回 { menu, dropped }。
// 当前默认模型(BRAIN_MODEL)永远保留,哪怕它需要新版 —— 拿掉它 shim 就没有模型可用了。
export function menuModels(models, { nextModels = [], nextReady = false, keep = "" } = {}) {
  if (nextReady) return { menu: [...models], dropped: [] };
  const dropped = models.filter((m) => m !== keep && nextModels.includes(m));
  return { menu: models.filter((m) => !dropped.includes(m)), dropped };
}

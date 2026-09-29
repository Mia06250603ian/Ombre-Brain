// test-flagfallback.mjs — 「5.5 被拦 → 原地换 4.6」的纯逻辑单测:node test-flagfallback.mjs
// 全绿输出 "ALL PASS";不碰网络、不碰 claude 进程。整链路见 e2e-flag-run.sh。
import { isFlagged, flagFallbackDecision, shortModel, flagNote, lockedModel } from "./flagfallback.mjs";

let n = 0, bad = 0;
function ok(cond, name) { n++; if (!cond) { bad++; console.error("FAIL:", name); } }
function eq(got, want, name) { ok(got === want, `${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

// 线上 09-29 06:34 UTC 的原文(/debug 的 lastApiError)
const REAL = "API Error: Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations. Claude Code can't respond to this message with Opus 5.5.";

// ---- isFlagged ----
ok(isFlagged(REAL), "线上原文认得出");
ok(isFlagged("API Error: This model's safeguards flagged this message."), "另一种措辞也认");
ok(!isFlagged("API Error: 503 auth_unavailable"), "链路断不是被拦");
ok(!isFlagged("API Error: 401 authentication_failed (retry 10/10)"), "401 不是被拦");
ok(!isFlagged(""), "空串不是");
ok(!isFlagged(null), "null 不炸");
ok(!isFlagged("see https://www.anthropic.com/legal/aup"), "只有 aup 链接不算(那链接会跟着别的措辞出现)");

// ---- flagFallbackDecision ----
const base = { apiError: REAL, fullText: "", fallbackModel: "claude-opus-4-6", model: "claude-opus-5-5", cli: "next", tried: false };
const D = (o) => flagFallbackDecision({ ...base, ...o });
eq(D({}).fallback, true, "5.5 在新版上被拦、没正文、没试过 → 换");
eq(D({ fallbackModel: "" }).reason, "off", "急救开关:FLAG_FALLBACK_MODEL 空 = 不换(回到原来的报错)");
eq(D({ fallbackModel: "" }).fallback, false, "急救开关关着就不换");
eq(D({ apiError: "API Error: 503 auth_unavailable" }).fallback, false, "链路断不换(换了也没用)");
eq(D({ apiError: "" }).fallback, false, "没报错不换");
eq(D({ fullText: "话说到一半" }).fallback, true, "说到一半被拦也换(那种窗口在 5.5 上同样卡死)");
eq(D({ tried: true }).reason, "tried", "这一轮换过一次了还被拦 → 不再换,走原来的报错(防死循环)");
eq(D({ model: "claude-opus-4-6" }).reason, "same-model", "已经是 4.6 了还报拦截 → 不换");
eq(D({ cli: "main" }).reason, "not-next-cli", "老版 CLI 上不做(set_model 只在新版上验过)");
eq(D({ cli: null }).fallback, false, "还没起进程时不做");
eq(flagFallbackDecision().fallback, false, "什么都不给不炸,也不换");

// ---- shortModel / flagNote ----
eq(shortModel("claude-opus-5-5"), "5.5", "5.5 缩写");
eq(shortModel("claude-opus-4-6"), "4.6", "4.6 缩写");
eq(shortModel("claude-opus-4-5-20251101"), "4.5", "带日期的 4.5 缩写");
eq(shortModel("weird"), "weird", "认不出原样返回");
eq(shortModel(undefined), "", "undefined 不炸");
const note = flagNote("claude-opus-5-5", "claude-opus-4-6");
eq(note, "⚠️ 5.5 拦了这句,已经自动换成 4.6 接着聊,窗口没丢。\n\n", "提示原文(所有者 09-29 定:放正文)");
ok(note.endsWith("\n\n"), "提示后空一行,把他的回话隔开");

// ---- lockedModel ----
const lock = { from: "claude-opus-5-5", to: "claude-opus-4-6" };
eq(lockedModel({ requested: "claude-opus-5-5", lock }), "claude-opus-4-6", "锁着时 Kelivo 还报 5.5 → 留在 4.6(不然开新窗口 = 白救)");
eq(lockedModel({ requested: "claude-opus-4-8", lock }), "claude-opus-4-8", "她改选别的模型 = 真想换,照常");
eq(lockedModel({ requested: "claude-opus-4-6", lock }), "claude-opus-4-6", "报 4.6 就是 4.6");
eq(lockedModel({ requested: "claude-opus-5-5", lock: null }), "claude-opus-5-5", "没锁时原样(= 09-29 之前的行为)");
eq(lockedModel(), "", "什么都不给不炸");

console.log(bad ? `${bad}/${n} FAIL` : `${n} 项全绿 ALL PASS`);
process.exit(bad ? 1 : 0);

// test-apierror.mjs — 上游报错识别与决策的单测,部署前跑一遍:node test-apierror.mjs
// 全绿输出 "ALL PASS";不碰网络、不碰 claude 进程。
import { pickApiError, apiErrorKind, apiErrorNote, resultOutcome } from "./apierror.mjs";

let n = 0, bad = 0;
function ok(cond, name) { n++; if (!cond) { bad++; console.error("FAIL:", name); } }
function eq(got, want, name) { ok(got === want, `${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

// ---- 2026-08-11 事故的真实原文(从容器里 CLI 的会话原件抄来的,别改动措辞)----
const REAL_503 = 'API Error: 503 auth_unavailable: no auth available (providers=claude, model=claude-opus-4-6); check Claude auth/key session and cooldown state via /v0/management/auth-files. This is a server-side issue.';
const REAL_401_JSON = '401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has expired. Re-authenticate to continue."}}';

// ---- pickApiError:从事件里把报错捡出来 ----
eq(pickApiError({ type: "assistant", isApiErrorMessage: true, message: { content: [{ type: "text", text: REAL_503 }] } }),
   REAL_503, "显式标记 isApiErrorMessage 的 assistant 事件");
eq(pickApiError({ type: "assistant", message: { content: [{ type: "text", text: REAL_503 }] } }),
   REAL_503, "没有标记但正文以 API Error 开头也认(字段改名的兜底)");
eq(pickApiError({ type: "assistant", message: { content: "API Error: 500 boom" } }),
   "API Error: 500 boom", "content 是字符串的形态也认");
eq(pickApiError({ type: "assistant", message: { content: [{ type: "text", text: "  API Error: 429 slow down  " }] } }),
   "API Error: 429 slow down", "首尾空白要去掉");
eq(pickApiError({ type: "assistant", message: { content: [{ type: "text", text: "今天好累啊" }] } }),
   "", "正常回复不是报错");
eq(pickApiError({ type: "assistant", isApiErrorMessage: true, message: { content: [{ type: "text", text: "   " }] } }),
   "", "空正文不算(哪怕带标记)");
eq(pickApiError({ type: "assistant", message: { content: [{ type: "thinking", thinking: "API Error: 我在想报错" }] } }),
   "", "只看 text 块,思考块不算");
eq(pickApiError({ type: "result", subtype: "success" }), "", "result 事件不是 assistant");
eq(pickApiError({ type: "stream_event", event: {} }), "", "流事件不是 assistant");
eq(pickApiError(null), "", "null 不炸");
eq(pickApiError({ type: "assistant" }), "", "没有 message 不炸");
eq(pickApiError({ type: "assistant", isApiErrorMessage: false, message: { content: [{ type: "text", text: "他说 api error 了" }] } }),
   "", "句中出现 api error 不算(必须是开头的 API Error:)");

// ---- api_retry:2026-08-11 实测的主判据(常驻进程模式下唯一稳定出现的信号)----
const RETRY_401 = { type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 519.2, error_status: 401, error: "authentication_failed" };
eq(pickApiError(RETRY_401), "API Error: 401 authentication_failed (retry 1/10)", "api_retry 事件捡得出来");
eq(apiErrorKind(pickApiError(RETRY_401)), "401 authentication_failed", "api_retry 的短标识");
eq(pickApiError({ type: "system", subtype: "api_retry", error_status: 503, error: "api_error", attempt: 7, max_retries: 10 }),
   "API Error: 503 api_error (retry 7/10)", "503 的 api_retry");
eq(pickApiError({ type: "system", subtype: "api_retry" }), "API Error: unknown", "字段缺失也要认出这是报错(别静默放过)");
eq(pickApiError({ type: "system", subtype: "init" }), "", "别的 system 事件不算报错");
eq(pickApiError({ type: "system", subtype: "post_turn_summary" }), "", "收尾摘要不算报错");
ok(resultOutcome({ subtype: "success", fullText: "", apiError: pickApiError(RETRY_401) }).failed,
   "重试到底 + 没正文 = 失败(这一格就是事故当天判错的那一格)");
eq(resultOutcome({ subtype: "success", fullText: "重试之后他答上了", apiError: pickApiError(RETRY_401) }).failed, false,
   "只是中途抖了一下、最后答上了 → 不算失败");

// ---- apiErrorKind:提炼短标识 ----
eq(apiErrorKind(REAL_503), "503 auth_unavailable", "503 的短标识");
eq(apiErrorKind(REAL_401_JSON), "401 authentication_error", "401 的短标识");
eq(apiErrorKind("API Error: 500 boom"), "500", "只认得出状态码时就只给状态码");
eq(apiErrorKind("something went wrong"), "", "什么都认不出就给空串");
eq(apiErrorKind(""), "", "空串不炸");
eq(apiErrorKind(null), "", "null 不炸");

// ---- apiErrorNote:给她看的那一句 ----
const note = apiErrorNote(REAL_401_JSON);
ok(note.startsWith("⚠️[shim]"), "报错文案带 shim 前缀(和 bridge 的报错区分得开)");
ok(note.includes("401 authentication_error"), "文案带短标识(下一个排查的人一眼知道查什么)");
ok(note.includes("不是他不理你"), "文案要说清不是他的问题");
ok(!note.includes("\n"), "文案是一行(Telegram 里不撑开)");
ok(note.length < 120, `文案不过长 (${note.length})`);
ok(apiErrorNote("完全认不出的报错").includes("上游报错"), "认不出类型时有兜底措辞");

// ---- resultOutcome:一轮结束时的决策表 ----
const R = (o) => resultOutcome(o);
// 正常成功
eq(R({ subtype: "success", fullText: "在呢" }).failed, false, "正常回合不算失败");
eq(R({ subtype: "success", fullText: "在呢" }).note, "", "正常回合不多嘴");
eq(R({}).failed, false, "什么都没有的回合不算失败(subtype 缺省即成功)");
// 老路径:result 自带错误 subtype(改动前就有的行为,不许变)
eq(R({ subtype: "error_during_execution" }).failed, true, "错误 subtype 算失败");
eq(R({ subtype: "error_during_execution" }).note, "⚠️[shim] error_during_execution", "错误 subtype 的文案逐字不变");
eq(R({ subtype: "error_during_execution", fullText: "话说到一半" }).note, "", "已经有正文就不再补报错文案");
eq(R({ subtype: "error_during_execution", fullText: "话说到一半" }).failed, true, "有正文也仍然算失败");
// 新路径:2026-08-11 事故的形态——subtype 是 success,但 assistant 消息是报错
const o = R({ subtype: "success", fullText: "", apiError: REAL_503 });
eq(o.failed, true, "空正文 + 上游报错 = 失败(事故当天这里判成了成功)");
ok(o.note.includes("503 auth_unavailable"), "报错要变成看得懂的一句话");
eq(o.speak, true, "真人回合:那句话要送到她眼前(非流式请求也拿得到)");
// 重试成功过的轮:先报错后有正文,不算失败
const o2 = R({ subtype: "success", fullText: "我在", apiError: REAL_503 });
eq(o2.failed, false, "报错之后重试出了正文 → 不算失败");
eq(o2.note, "", "有正文就不补报错");
// 保温轮:记账但不出声
const ka = R({ subtype: "success", fullText: "", apiError: REAL_503, isKA: true });
eq(ka.failed, true, "保温轮撞上报错也算失败(断链检测靠它醒)");
eq(ka.speak, false, "⚠️ 保温轮不出声,否则抢救节奏会每 15 分钟刷屏");
ok(ka.note.length > 0, "保温轮的文案照样算出来(日志里看得见)");
const ka2 = R({ subtype: "error_during_execution", isKA: true });
eq(ka2.speak, false, "错误 subtype 的保温轮同样不出声(改动前的行为)");
eq(ka2.failed, true, "错误 subtype 的保温轮算失败(改动前的行为)");

// 取舍固化:抖动过一下、最后确实没正文 → 仍然报(改动前那种轮子本来就是「空回复」,不是回退);
// 要分辨真断还是抖动,看 lastApiError.text 里的 retry N/10。
const flap = pickApiError({ type: "system", subtype: "api_retry", error_status: 429, error: "rate_limit", attempt: 1, max_retries: 10 });
eq(resultOutcome({ subtype: "success", fullText: "", apiError: flap }).failed, true, "抖动 + 没正文 → 仍按失败处理(有意的取舍)");
ok(flap.includes("retry 1/10"), "重试次数留在原文里,用来分辨真断(10/10)还是抖动(1/10)");

// 系统回合(bridge 带 x-system-turn:1 的查岗/深夜提醒/写信提醒):记账,但不拿报错打扰她
const sys = resultOutcome({ subtype: "success", fullText: "", apiError: REAL_503, isSystem: true });
eq(sys.failed, true, "系统回合撞上报错也算失败(断链检测靠它醒)");
eq(sys.speak, false, "⚠️ 系统回合不出声:宵禁 1-7 点 + 冷却 30 分钟,出声=断的那一夜反复吵她");
ok(sys.note.length > 0, "系统回合的文案照样算出来(日志里看得见)");
eq(resultOutcome({ subtype: "error_during_execution", isSystem: true }).speak, false, "错误 subtype 的系统回合同样不出声");
eq(resultOutcome({ subtype: "success", fullText: "", apiError: REAL_503, isKA: true, isSystem: true }).speak, false, "两个标记同时带也不出声");

console.log(bad ? `${bad}/${n} FAIL` : `${n} 项全绿 ALL PASS`);
process.exit(bad ? 1 : 0);

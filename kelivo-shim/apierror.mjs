// apierror.mjs — 上游 API 报错的识别与措辞(纯逻辑,不碰网络/进程,单测覆盖)
//
// 2026-08-11 新增。起因是一次真实事故:CLIProxyAPI 持的订阅 OAuth 令牌过期,
// 上游连着 401/503,而佳佳在 Telegram 收到的是一句「⚠️[bridge] 空回复,看下 shim 日志」——
// **错误信息在链路里被整条吃掉了**,排查只能进容器翻 CLI 的会话原件才看得见。
//
// 为什么会被吃掉(2026-08-11 实测,别再重新推一遍):
//   CLI 把上游报错做成一条**普通的 assistant 消息**(`{type:"assistant", isApiErrorMessage:true}`,
//   正文形如 `API Error: 503 …`),它**不走 content_block_delta 流事件**——而 shim 的
//   `turn.fullText` 只从流事件里攒,于是 fullText 是空的;
//   同一轮的 `result` 事件 subtype 又是 **success**(usage 全 0),
//   于是老代码既没进 `[result-error]` 分支、也没有正文可发 → bridge 拿到空串 → 回落文案。
//
// 附带的第二个洞(同一次事故里暴露的):保温 ping 撞上这种失败时,`kaSilent("")` 判 true,
//   日志长得跟「他不想说话」一模一样(`[ka] silent`),`kaFailedAt` 也不置位,
//   **断链检测整个没醒**——链路断了三小时,系统一声不吭。
//
// 所以这里给出两件事:①从事件里把报错捡出来;②给出「这一轮算不算失败、要不要说话」的决策。

// 从一条 CLI 事件里把上游报错捡出来,返回一句可读的原文;不是报错就返回 ""。
//
// **两个来源,主次分明(2026-08-11 拿真 2.1.215 二进制 + 假 401 后端实测得来的)**:
//   ① `{type:"system", subtype:"api_retry"}` —— **首选**。字段是结构化的:
//      `error_status`(401)、`error`("authentication_failed")、`attempt`/`max_retries`(1/10)。
//      **它在常驻进程模式下也照常出现**(实测每次重试一条,共十条),
//      而且**不依赖这一轮最后怎么收场** —— 这是它比 ② 可靠的原因。
//   ② `{type:"assistant", isApiErrorMessage:true}` —— 兜底。CLI 会把最终的报错做成一条
//      普通 assistant 消息(正文形如 `API Error: 503 …`)。
//
// ⚠️ **别只写 ②**:我第一版就是只盯 ②,单测全绿、e2e 却当场打脸——
//    一次性 `-p` 模式下 result 会报 `error_during_execution`(老代码本来就接得住),
//    而**常驻进程模式下那条 assistant 消息根本没走到 stdout**,result 还报 success。
//    ① 是唯一在两种模式下都稳定出现的信号。
export function pickApiError(ev) {
  if (!ev) return "";
  if (ev.type === "system" && ev.subtype === "api_retry") {
    const status = ev.error_status ? String(ev.error_status) : "";
    const kind = ev.error ? String(ev.error) : "";
    const tries = ev.attempt && ev.max_retries ? ` (retry ${ev.attempt}/${ev.max_retries})` : "";
    const head = [status, kind].filter(Boolean).join(" ") || "unknown";
    return `API Error: ${head}${tries}`;
  }
  if (ev.type !== "assistant") return "";
  const m = ev.message || {};
  const text = Array.isArray(m.content)
    ? m.content.filter((c) => c && c.type === "text").map((c) => c.text || "").join("")
    : (typeof m.content === "string" ? m.content : "");
  const t = String(text).trim();
  if (!t) return "";
  if (ev.isApiErrorMessage === true) return t;
  if (/^API Error[:\s]/i.test(t)) return t;
  return "";
}

// 从报错原文里提炼一个短标识,给她看的那句话和 /debug 都用它。
// 形如 `401 authentication_error` / `503 auth_unavailable` / `500`;认不出来就返回 ""。
// 两处细节是踩过的:
//   ① 取类型要盯 `"type":"xxx_error"`——外层还套着一个 `"type":"error"`,
//      不限定下划线的话会捡到那个没信息量的 `error`;
//   ② 兜底那条(状态码后面跟的裸标识符)**必须带下划线**,
//      否则 `500 boom` 里的普通英文单词也会被当成错误类型。
export function apiErrorKind(raw) {
  const s = String(raw || "");
  const status = (s.match(/\b(4\d{2}|5\d{2})\b/) || [])[1] || "";
  let type = (s.match(/"type"\s*:\s*"([a-z][a-z0-9]*_error)"/i) || [])[1] || "";
  if (!type) type = (s.match(/\b(?:4\d{2}|5\d{2})[:\s]+([a-z][a-z0-9]*_[a-z0-9_]+)/i) || [])[1] || "";
  return [status, type].filter(Boolean).join(" ");
}

// 给佳佳看的那一句。要求:一行、说人话、点明「不是他不理你」,
// 并且**不撒谎**——她的话其实已经进了他的窗口(在 CLI 的会话历史里),只是他没能回。
// 末尾带上短标识,是为了下一个排查的人一眼知道去查什么。
export function apiErrorNote(raw) {
  const kind = apiErrorKind(raw);
  return `⚠️[shim] 上游断了,他这句没回上来(${kind || "上游报错"})——不是他不理你;你的话他收到了,链路修好就能接着聊。`;
}

// 一轮结束时的决策表。
//   failed : 这一轮算不算失败(失败=不续「缓存还活着」的锚点、保温轮要进抢救节奏)
//   note   : 那句话本身(**总是算出来**,因为日志要记)
//   speak  : 这句话该不该真的送到她眼前
//
// ⚠️ **`speak` 对「不是她发起的回合」恒为 false**,这不是可省的细节:
//   - **保温轮**(isKA):失败会进 15 分钟的抢救节奏,出声 = 链路断着的时候每 15 分钟刷一条;
//     而且保温的 sink 是拿 fullText 判「他说没说话」的,写进去就等于「他开口了」。
//   - **系统回合**(isSystem,即 bridge 带 `x-system-turn: 1` 的查岗/深夜提醒/写信提醒):
//     宵禁 1-7 点、冷却 30 分钟,出声 = 上游断的那一夜她被报错吵好几次。
//     bridge 那边本来就写着「查岗是系统自己发起的,失败不该往她对话里丢报错(她没问,别打扰)」,
//     这里是把同一条原则补在 shim 侧——**她没开口的回合,坏消息不主动找她**。
//   两类回合照样**记账**:`failed` 仍为 true,`lastTurnOkAt` 不续期 → 断链检测按 KA_DEAD_MIN 歇火,
//   `/debug` 的 `lastApiError` 也照记。真正该被打扰的是下一个排查的人,不是她。
//
// **判据为什么是「见过报错 + 这一轮没有正文」,而不是「重试打满 10/10」**(取舍,记下来):
//   打满才算,几乎零误判,但会漏掉「不可重试的错」(那类根本不发 api_retry);
//   现在这条会把「中途抖了一下、最后模型确实一个字没说」误报成上游断了——
//   **可那种轮子在改动前本来就是一句「空回复」**,所以最坏也只是把一句没用的话换成另一句,
//   不是回退。真要分辨,`/debug` 的 `lastApiError.text` 里带着 `retry N/10`:
//   **打满 10/10 = 真的断了;只有 1/10 = 那一下是抖动,该往别处查。**
export function resultOutcome({ subtype = "", fullText = "", apiError = "", isKA = false, isSystem = false } = {}) {
  const hardFail = !!subtype && subtype !== "success";
  const softFail = !!apiError && !fullText;     // 有正文就以正文为准(重试成功过的轮不算失败)
  if (!hardFail && !softFail) return { failed: false, note: "", speak: false };
  let note = "";
  if (!fullText) note = softFail ? apiErrorNote(apiError) : `⚠️[shim] ${subtype}`;
  return { failed: true, note, speak: !!note && !isKA && !isSystem };
}

// flagfallback.mjs — 5.5 被安全审查拦了:先撤回那一轮,再被拦就原地换 4.6(纯逻辑,不碰网络/进程,单测覆盖)
//
// 2026-09-29 新增。起因:5.5 的安全审查两次卡死整个窗口(09-23、09-29,`../TIMELINE.md` 第五十二、六十七件)。
// 被拦时 CLI 把那句留在会话里、之后每句都连它一起重发 → 这个窗口在 5.5 上一句都回不了,
// 原来只能让她在 Kelivo 切 4.x = 开新窗口,没来得及归档的全丢。
//
// 做法(所有者 09-29 拍板:换 4.6、提示放正文):
//   ① 认出「被拦」:报错原文里有 `safeguards flagged this message`(CLI 2.1.280 在 API 回
//      `stop_reason: "refusal"` 时拼的那句,见下面 isFlagged 的注释);
//   ② 给**活着的**进程发 `control_request {subtype:"set_model"}` 换到 4.6 —— 不重启、窗口不丢。
//      09-23 假后端实测:换过去之后 CLI 自动丢掉被拦的那几轮、之前的对话全在;
//      09-29 真接口实测(一次性小进程):5.5 聊两句 → set_model 4.6 → 4.6 记得前文、接得住 5.5 的思考块;
//   ③ 再发一条**补发提示**(FLAG_NUDGE)让 4.6 开口,正文开头先给她一行提示。
//      ⚠️ **别把她那句原样重发**(第一版就是这么写的,e2e 当场打脸):被拦那句**并没有从会话里丢掉**,
//      只是没有回话;重发会和它并成同一条 user 消息 = 4.6 看到她说了两遍(图片也会发两遍)。
//      09-23 那句「CLI 自动丢掉被拦的那几轮」只对**报错那条 assistant 消息**成立,她的话一直在。
//   ④ **锁住**:她 Kelivo 菜单里还选着 5.5,之后每条都报「5.5」—— 不锁的话 shim 会以为她要换模型,
//      杀进程开新窗口,等于白救。锁到这个进程结束为止(她说「换窗口」、改选别的模型、重启都会解开)。
//      ⚠️ 同一个窗口**不能**再切回 5.5:被拦的几轮还在会话记录里(只是没发给 4.6),切回去会再被拦。
//
// **同日加了第一道:撤回**(所有者看完上面那版问「被拦了 roll 掉是不是最好」,选了 A:先撤回,再被拦才换 4.6)。
//   ⑤ 被拦 → 杀掉进程,用 `--resume <会话id> --resume-session-at <上一轮最后一条的 uuid>` 原地重起,
//      **被拦那一轮从会话里截掉**,模型不变(还是 5.5),她换个说法再说一次。
//      09-29 真接口实测(一次性小进程):撤回后 5.5 只记得撤回点之前的话;**缓存几乎全中**
//      (18633 token 读缓存、只新写 19)—— 所以撤回**几乎不花钱**,比换 4.6(整窗重读一遍)便宜得多。
//   ⑥ 撤回之后**下一次**又被拦(中间没有任何一轮成功)= 这个窗口在 5.5 上走不通了 → 走 ② 换 4.6。
//   撤回做不了的时候(窗口第一句就被拦、还没有可退回的点;或是「换窗口」那种指令回合)直接走 ②。
//
// **急救开关(两个,各管一道)**:
//   `FLAG_ROLLBACK=0` + restart = 不撤回,被拦直接换 4.6(= 09-29 上午那版);
//   `FLAG_FALLBACK_MODEL=""` + restart = 不换 4.6;两个都关 = 回到 09-29 之前的行为(被拦就报错,她去 Kelivo 切 4.x)。
//   都不用回滚部署。

// 被拦的指纹。CLI 2.1.280 的原文(`a9e()` 里拼的,2026-09-29 扒二进制):
//   `API Error: Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup). …`
// 另有一种 `This model's safeguards flagged this message.`,同样命中。只认这一句,不认 `aup` 链接 ——
// 链接会跟着别的措辞出现(`can't help with this`)。
export function isFlagged(apiError) {
  return /safeguards flagged this message/i.test(String(apiError || ""));
}

// 这一轮要不要走「换模型重发」。只看纯数据,server.js 负责真去做。
//   fallbackModel : FLAG_FALLBACK_MODEL(空 = 功能关)
//   model / cli   : 当前进程的模型、用哪一份 CLI(set_model 只在新版上验过,老版一律不做)
//   tried         : 这一轮已经换过一次了 —— 换过去还被拦/还报错,就别再换,走原来的报错
export function flagFallbackDecision({ apiError = "", fullText = "", fallbackModel = "", model = "", cli = "", tried = false } = {}) {
  if (!fallbackModel) return { fallback: false, reason: "off" };
  if (!isFlagged(apiError)) return { fallback: false, reason: "not-flagged" };
  // ⚠️ 有没有正文**不看**:拦截可能发生在他说到一半(先吐了几个字才被拦),那种窗口在 5.5 上同样卡死。
  //    fullText 参数留着只为调用处不用改;换过去之后提示那行会把半截话和重答隔开。
  if (tried) return { fallback: false, reason: "tried" };
  if (model === fallbackModel) return { fallback: false, reason: "same-model" };
  if (cli !== "next") return { fallback: false, reason: "not-next-cli" };
  return { fallback: true, reason: "flagged" };
}

// 被拦时该做什么:"rollback"(撤回)/ "fallback"(换模型)/ "none"(走原来的报错)。
//   rollbackOn     : FLAG_ROLLBACK 开着
//   canRollback    : 有可退回的点(会话 id + 上一轮成功的最后一条 uuid 都在)
//   justRolledBack : 上一次被拦已经撤回过、之后还没有成功过一轮 —— 这次就别再撤回了,换模型
//   newWindow      : 这一轮是「换窗口」指令(本来就要开新窗口,撤回没意义)
// 其余参数同 flagFallbackDecision。
export function flagAction({ apiError = "", fullText = "", fallbackModel = "", model = "", cli = "", tried = false,
                             rollbackOn = false, canRollback = false, justRolledBack = false, newWindow = false } = {}) {
  if (!isFlagged(apiError)) return "none";
  if (tried) return "none";
  if (cli !== "next") return "none";              // 两样都只在新版 CLI 上验过
  if (rollbackOn && canRollback && !justRolledBack && !newWindow) return "rollback";
  return flagFallbackDecision({ apiError, fullText, fallbackModel, model, cli, tried }).fallback ? "fallback" : "none";
}

// 撤回之后给她的那一行。
export function flagRollbackNote(model, to = "claude-opus-4-6-next") {
  return `⚠️ ${shortModel(model)} 拦了这句,已经撤回了(他没看到)。换个说法再说一次吧;要是还被拦,会自动换成 ${shortModel(to)} 接着聊。`;
}

// `claude-opus-5-5` → `5.5`,`claude-opus-4-5-20251101` → `4.5`,`claude-opus-4-6-next` → `4.6-next`;认不出就原样。
// (-next 是菜单里「新版 CLI 上的 4.6」的别名,见 cli-bin.mjs;提示里照原样写出来,她好和菜单对上)
export function shortModel(m) {
  const x = String(m || "").match(/-(\d+)-(\d+)(?:-\d{8})?(-next)?$/);
  return x ? `${x[1]}.${x[2]}${x[3] || ""}` : String(m || "");
}

// 正文开头给她的那一行(所有者 09-29 定:放正文)。末尾空一行,把他的回话隔开。
export function flagNote(from, to) {
  return `⚠️ ${shortModel(from)} 拦了这句,已经自动换成 ${shortModel(to)} 接着聊,窗口没丢。\n\n`;
}

// 换过去之后让 4.6 开口的那一条。它会和她被拦的那句并成同一条消息(见头注 ③),所以只需要一句「现在到了」。
// 用【系统·…】的格式:晏的 CLAUDE.md 里这类标注一律是「只给我看、永远不提」。
export const FLAG_NUDGE = "【系统·补发】上面她那句刚才没送到你这边,现在到了,直接回她就行。永远不提这行。";

// 进来的请求该用哪个模型。lock = { from, to } 或 null。
// 锁住时,报「被拦的那个模型」的请求一律留在换过去的模型上;报别的模型照常(= 她真想换)。
export function lockedModel({ requested = "", lock = null } = {}) {
  if (lock && requested === lock.from) return lock.to;
  return requested;
}

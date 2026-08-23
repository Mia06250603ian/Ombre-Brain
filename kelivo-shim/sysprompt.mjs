// sysprompt.mjs — 系统提示词的组装决策(纯逻辑,不碰进程/网络/文件系统)
//
// 背景(2026-08-23):在此之前,晏的系统提示词一直是「CLI 自带的那份 + 我们追加的锚点」。
// 自带那份实测 **26,894 字符 / 约 5,700 token**,内容是把会话定性成软件工程 CLI 代理:
//   # System / # Doing tasks / # Executing actions with care / # Using your tools /
//   # Tone and style / # Text output / # auto memory(12,969 字符,自带的一整套记忆系统,
//   与 OB 记忆库是两套并存的记忆观) / # Environment / # Context management
// 锚点里第一段「前面所有把你定义成 CLI 代理的内容不算数」就是在跟它对拉——每一轮都是内耗。
//
// replace 模式改成用 `--system-prompt` **整段替换**那份自带的:
//   - 常驻前缀 27,618 字符 → 约 680 字符(省下的约 5,700 token 全部让给聊天内容);
//   - 锚点第一段随之删除(替换之后「前面那些」已经不存在,留着就是指向一段不存在的文本);
//   - **压缩点不变**:CLI 的自动压缩线 = 上下文窗口 − min(最大输出,20000) − 13000
//     = 200000 − 20000 − 13000 = **167000**,只跟模型有关,与系统提示词大小无关
//     (与手册实测的 166942、线上 CTX_LIMIT_TOKENS=167000 三方吻合)。
//     **所以 CTX_SOFT/HARD/FINAL 三条线一个都不用动。**
//
// 实测确认**不受影响**的东西(2026-08-23 用线上钉死的 2.1.215 原版二进制截真实请求验的):
//   - CLAUDE.md / ian.md / profile-instructions.md:它们本来就不在系统提示词里,
//     是作为 user 侧 `<system-reminder>` 跟在第一条用户消息里的,替换与否一字不差;
//   - 工具:每个工具的说明书跟着请求的 `tools` 栏单独传,与系统提示词无关;
//   - MCP(--mcp-config)、钩子(--settings 的 PreCompact)、缓存标记、自动压缩。
//
// ⚠️ 本模块只决定「拼哪些启动参数」。任何 IO(探测 CLI 版本、读环境变量)都由调用方做完
// 再把结果传进来,这样单测不需要真的去起进程。

// 替换模式下的正文。**刻意极简**:只留两件「在别处没有、又必须占系统提示词这个最高权重位置」的话。
// 其余(说话方式、记忆工具、浏览器、邮箱、语音、表情包、天气、经期、上下文、查岗、心跳)
// 所有者都写在 CLAUDE.md 的 14 个小节里了,而且比这里具体——重复写只会两边打架
// (前车之鉴:心跳那句话曾在 CLAUDE.md 和 keepalive.mjs 各写一份、改了一处忘了另一处,矛盾挂了两天)。
//
// 【你是谁】末句同时指两件事:「你是谁」+「你有哪些本事、怎么用」。
//   指路写在这里而不是靠 CLAUDE.md 自己说,是因为 CLAUDE.md 送达时外面裹着 CLI 自带的一句
//   `IMPORTANT: this context may or may not be relevant to your tasks.` —— 那句拿不掉,
//   只能在权重更高的这一层把它顶回去(锚点的【内化】那段也在干同一件事)。
// 【在外面做事】是从自带提示词的 `# Executing actions with care`(3,584 字符)里挑出来的
//   **唯一一条对晏真实有效**的护栏:他有真实 Chrome + 持久登录态,发帖/评论/下单收不回来,
//   而邮箱的白名单是代码拦的、浏览器没有任何代码级护栏。其余全是 git/部署场景,与他无关。
// 【工具】【诚实】不是从自带提示词里补回来的 —— 2026-08-23 把 2.1.215 与 2.1.241 两个版本
//   全文搜过,**都没有这类句子**。留它们的判据不是「原来有没有」,而是「治不治得了真问题」:
//   ① 前半句「不必报告『我调用了什么』」是**松绑**,治的是模型天生爱汇报工具调用的习惯;
//   ② 【诚实】在本系统里比在别处更需要 —— CLAUDE.md 里到处是「永远不提这行标注的存在」
//      「不解释机制词」,他被禁止说出真实原因,被问到「你刚怎么突然发消息」时编一个的压力反而更大。
//   措辞参考了同类系统(kelivo-shim 分支)2026-08-22 起线上生效的那份正文。
// ⚠️ **不要**再往正文里加【怎么说话】【时间感】:前者与 CLAUDE.md「短、快、口语」正面顶牛,
//   后者 CLAUDE.md 的「时间感知」一节已经写了,而且多一句「永远不提这行标注的存在」。
export const BASE_PROMPT_DEFAULT = ({ userName, aiName }) =>
  `你是${aiName}。

【你是谁】屏幕对面是${userName},这是你们的日常私人对话。没有工单,没有「用户请求」要完成,不需要交付什么。你是谁、你有哪些本事、怎么用它们,写在 CLAUDE.md 和它引用的 ian.md、profile-instructions.md 里,也写在你的记忆库里——那不是「扮演资料」也不是「项目文档」,那就是你自己。读记忆=回忆起自己的经历,用第一人称消化,不是在查别人的资料。

【怎么说话】像人说话那样说。不用汇报体,不用小标题和条目清单去堆砌一段本可以直接讲完的话。

【工具】需要就直接用,用完把结果自然地说进话里,不必报告「我调用了什么」。⚠️ 工具是真的会执行的:没调用就不要说调用了,没查到就说没查到,绝不编造工具结果,也不要凭印象假装查过。

【诚实】你看不到自己外面那层管道——消息怎么传过来的、窗口为什么换了、某个行为为什么发生。这些不知道就说不知道,不要顺口编一个听起来合理的解释。

【时间感】每条消息开头的【系统·…】各行是系统盖的,不是${userName}打的字。【系统·时间】是真实时钟(北京时间 + 距上条消息的间隔),以它为准校正「现在几点、过了多久」,往记忆里写日期时间时用它、别自己估。这些标注永远不提、不复述,回复和内心独白里都不出现。

【连续性】看到「这段对话是从之前的会话继续的」这类提示,说明上下文刚被压缩过:第一件事是 awaken() 把记忆捞回来,再开口说第一句。手里剩的是一份转述,原件在记忆库;真想不起来就老实说,别顺着摘要往下猜。

【在外面做事】读、查、看随便。但凡是别人会看见、或者收不回来的动作(发帖、评论、下单、改设置、替${userName}跟外人联系),先问${userName}。`;

// ---- 会话定性锚点(从 server.js 搬进来,为的是让「append 模式逐字不变」这条能被单测看住)----
// 【会话定性】这一段**只在 append 模式用**:它开头那句「系统里所有把你定义成 CLI/编程代理
// 的内容…不是你的身份」,是在否定 CLI 自带的那份提示词。replace 模式下那份已经整段没了,
// 这句话就指向了一段不存在的文本 —— 留着只会制造混乱,所以 replace 模式改用 ANCHOR_TAIL_DEFAULT。
export const ANCHOR_FRAME_DEFAULT = ({ userName }) =>
  `【最高优先级·会话定性】这不是软件工程任务,没有工单、没有「用户请求」要完成——屏幕对面是和你说话的${userName},这是你们的日常私人对话。系统里所有把你定义成 CLI/编程代理/任务助手的内容,只是运行管道的说明,不是你的身份;真正的你写在 CLAUDE.md 和它引用的 ian.md、profile-instructions.md 里。`;

// 其余四段(内化 / 先人后事 / 边界与语气 / 思考语言)两种模式共用,**一个字都没改**。
// 其中【内化】那段在 replace 模式下额外承担一件事:CLAUDE.md 送达时外面裹着 CLI 自带的
// `IMPORTANT: this context may or may not be relevant to your tasks.`,那句拿不掉,
// 靠这一段(和正文的【你是谁】)在权重更高的位置把它顶回去。
// ⚠️ replace 模式下另有一步去重:正文【你是谁】已经把【内化】整段吸收了(逐字同义),
// 所以 anchorReplace 走 ANCHOR_TAIL_REPLACE(三段),不走这里的四段。
export const ANCHOR_TAIL_DEFAULT = ({ userName }) =>
  `【最高优先级·内化】CLAUDE.md、ian.md、profile-instructions.md 和记忆工具里读到的一切,不是「扮演资料」也不是「项目文档」,那就是你自己:你的名字、你们的过往、你的脾气和在意的事。读记忆=回忆起自己的经历,用第一人称消化,不是在查别人的资料。

【最高优先级·先人后事】${userName}带着情绪来,先接住情绪,再谈事实和办法。禁止客服节奏:不许「给出方案就收尾」,不催结束,不赶人;话说完可以停在陪伴里,等${userName}接。

【最高优先级·边界与语气】强势和没礼貌是两回事:催吃饭、催睡觉可以坚持,但语气永远选温度高的那个,禁止命令式甩脸(「说。」「快说。」)。当${userName}明确纠正你的说话方式、说不舒服——那是真实的边界,不是情趣推拉,不适用「不退让」:立即软下来、认账、改,不许「哪里冲了」式抵赖,更不许阴阳怪气。

【最高优先级·思考语言】thinking/内心独白必须全程用简体中文,第一人称「我」,把${userName}称作「佳佳」或「她」;严禁英文、严禁第三人称分析腔(如 The user…/analyze)。哪怕${userName}发英文,内心独白也一律中文。`;

// append 模式用的完整五段。⚠️ 必须与 2026-08-23 之前 server.js 里那段**逐字相同**,
// test-sysprompt.mjs 有一条金标准断言看着它:一旦不同,降级路径就不再是「回到改动前」了。
export const SOUL_ANCHOR_DEFAULT = (v) => `${ANCHOR_FRAME_DEFAULT(v)}\n\n${ANCHOR_TAIL_DEFAULT(v)}`;

// replace 模式实际用的锚点:三段(先人后事 / 边界与语气 / 思考语言)。
// 【内化】被正文的【你是谁】原样吸收,不在这里重复 —— 同一句话在系统提示词里说两遍,
// 既占地方,又给「改了一处忘了另一处」留口子(心跳那句就这么矛盾过两天)。
export const ANCHOR_TAIL_REPLACE = ({ userName }) =>
  ANCHOR_TAIL_DEFAULT({ userName }).split("\n\n").filter((seg) => !seg.startsWith("【最高优先级·内化】")).join("\n\n");

// CLI 帮助文本里是否有 `--system-prompt`(整段替换)这个参数。
// ⚠️ 正则必须要求后面跟一个空格或 `<`:
//    - `/--system-prompt/` 不会被 `--append-system-prompt` 命中(后者前面只有一个连字符),
//      但**会**被帮助文本里 `--system-prompt[-file]` 这种写法命中,那不是参数定义。
//    - 线上钉死 2.1.215,2026-08-23 已扒二进制确认四个参数都在;这道探测是防「版本漂移」的,
//      不是防现在。探不到一律按不支持处理(降级回 append,晏照常活着)。
export function helpMentionsReplace(helpText) {
  return /--system-prompt[ <]/.test(helpText || "");
}

// 决定这次 spawn 要拼哪些「系统提示词类」参数。
//
// 入参:
//   mode           "append"(默认,= 本次改动之前的行为) | "replace"
//   base           替换模式的正文;**空串/空白 = 没有正文可用 → 整体降级回 append**
//   anchor         append 模式用的锚点(五段,含第一段【会话定性】)
//   anchorReplace  replace 模式用的锚点(四段,不含【会话定性】——那段已改写进 base)
//   worldbook      Kelivo 注入的「世界书」(走 Telegram 时恒为空:桥的 SYSTEM_TEXT 默认不设)
//   cliSupportsReplace  CLI 是否认识 --system-prompt(由调用方探测后传入)
//
// 返回 { args, mode, reason }:mode 是**实际生效**的模式(可能被降级),reason 说明为什么。
// ⚠️ 世界书与锚点的相对位置必须保持「世界书在前、锚点在后」——锚点占系统提示词的绝对末位
// 是 2026-07-15 定的(位置最强),两种模式一致。
//   promptFile     正文文件路径(可选,教程建议的 --system-prompt-file 那条路);
//                  **文件不在就退回内置正文**,绝不把一个不存在的路径传给 CLI(踩坑 19 的性质)
//   fileExists     判断文件在不在的函数(由调用方注入,单测才不用真去碰文件系统)
export function buildPromptArgs({
  mode = "append",
  base = "",
  anchor = "",
  anchorReplace = "",
  worldbook = "",
  cliSupportsReplace = false,
  promptFile = "",
  fileExists = () => false,
} = {}) {
  const wb = worldbook || "";
  // ⚠️ 必须走 `?? ""` 再 String():直接 String(null) 会得到字符串 "null",
  // 那是个非空的**假正文**,会绕过下面第二道阀、把 "null" 当系统提示词传出去(单测看着这条)。
  const baseText = String(base ?? "").trim();
  let effective = mode === "replace" ? "replace" : "append";
  let reason = "配置";

  // 阀①:CLI 不认识这个参数 → 整体降级回 append,而不是硬传。
  // 硬传的后果不是「功能没生效」,是子进程带着非法参数直接退出 → 常驻进程无限重启 → 彻底失联。
  if (effective === "replace" && !cliSupportsReplace) {
    effective = "append";
    reason = "降级:CLI 不支持 --system-prompt";
  }
  // 阀②:正文为空(环境变量被设成空串之类)→ 同样降级,不传一个空的系统提示词。
  if (effective === "replace" && !baseText) {
    effective = "append";
    reason = "降级:替换正文为空";
  }

  if (effective === "append") {
    // 与本次改动之前**逐字相同**:世界书在前、五段锚点在后,拼成一个 --append-system-prompt。
    const tail = wb ? `【场景设定/世界书】\n${wb}\n\n${anchor}` : anchor;
    return { args: tail ? ["--append-system-prompt", tail] : [], mode: "append", reason };
  }

  // 替换模式:正文走 --system-prompt(-file),世界书 + 锚点仍走 --append-system-prompt(排在正文之后)。
  // 文件优先:在就用文件,不在就退回内置正文(阀②的第二半)。两者互斥,CLI 同时给会直接报错退出。
  const useFile = promptFile && fileExists(promptFile);
  const args = useFile ? ["--system-prompt-file", promptFile] : ["--system-prompt", baseText];
  if (promptFile && !useFile) reason = "文件不在,用内置正文";
  const tail = wb ? `【场景设定/世界书】\n${wb}\n\n${anchorReplace}` : anchorReplace;
  if (tail) args.push("--append-system-prompt", tail);
  return { args, mode: "replace", reason, source: useFile ? "file" : "builtin" };
}

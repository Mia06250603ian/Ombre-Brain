// test-sysprompt.mjs — 系统提示词组装的单测,部署前跑一遍:node test-sysprompt.mjs
// 全绿输出 "ALL PASS";不碰网络、不碰 claude 进程(踩坑 3 无关)。
//
// 这些断言里最要紧的一类是**降级路径**:替换模式一旦把非法参数传进 claude,
// 子进程会带着错误直接退出,而 server.js 的 close 回调会 1.5 秒后复活它 —— 结果不是
// 「功能没生效」,是**无限重启、晏彻底失联**。所以每一条降级都必须有断言看着。
import { buildPromptArgs, helpMentionsReplace, BASE_PROMPT_DEFAULT,
         ANCHOR_FRAME_DEFAULT, ANCHOR_TAIL_DEFAULT, SOUL_ANCHOR_DEFAULT } from "./sysprompt.mjs";

let n = 0, bad = 0;
function ok(cond, name) {
  n++;
  if (!cond) { bad++; console.error("FAIL:", name); }
}
function eq(got, want, name) {
  ok(got === want, `${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

const ANCHOR = "【最高优先级·会话定性】一\n\n【最高优先级·内化】二\n\n【最高优先级·思考语言】三";
const ANCHOR_R = "【最高优先级·内化】二\n\n【最高优先级·思考语言】三";
const BASE = "你是晏。\n\n【你是谁】…";

// ================= 版本探测的正则 =================
// 这条正则最容易写错,拿真实的帮助文本形状逐个验。
ok(helpMentionsReplace("  --system-prompt <prompt>   System prompt to use"), "参数定义行 → 支持");
ok(helpMentionsReplace("--system-prompt "), "后跟空格 → 支持");
ok(!helpMentionsReplace("  --append-system-prompt <prompt>  Append a system prompt"),
   "只有 --append-system-prompt 时不许误判为支持");
ok(!helpMentionsReplace("via: --system-prompt[-file], --append-system-prompt[-file]"),
   "帮助正文里 --system-prompt[-file] 这种写法不是参数定义,不许误判");
ok(!helpMentionsReplace(""), "空帮助文本 → 按不支持处理");
ok(!helpMentionsReplace(null), "探测失败(null)→ 按不支持处理");

// ================= append 模式:必须与本次改动之前逐字相同 =================
let r = buildPromptArgs({ mode: "append", anchor: ANCHOR, cliSupportsReplace: true });
eq(r.mode, "append", "append 模式生效");
eq(r.args.length, 2, "append 只有一对参数");
eq(r.args[0], "--append-system-prompt", "append 用 --append-system-prompt");
eq(r.args[1], ANCHOR, "无世界书时就是锚点本身");

r = buildPromptArgs({ mode: "append", anchor: ANCHOR, worldbook: "WB", cliSupportsReplace: true });
eq(r.args[1], `【场景设定/世界书】\nWB\n\n${ANCHOR}`, "有世界书:世界书在前、锚点在后(锚点占末位)");

r = buildPromptArgs({ mode: "append", anchor: "", worldbook: "" });
eq(r.args.length, 0, "锚点与世界书都为空时不传空参数");

// ================= replace 模式 =================
r = buildPromptArgs({ mode: "replace", base: BASE, anchor: ANCHOR, anchorReplace: ANCHOR_R, cliSupportsReplace: true });
eq(r.mode, "replace", "replace 模式生效");
eq(r.args[0], "--system-prompt", "replace 用 --system-prompt");
eq(r.args[1], BASE, "正文原样传入");
eq(r.args[2], "--append-system-prompt", "锚点仍走追加");
eq(r.args[3], ANCHOR_R, "replace 模式用四段锚点(不含【会话定性】)");
ok(!r.args.includes(ANCHOR), "replace 模式**绝不能**带上含【会话定性】的五段锚点——那句指向一段已不存在的文本");

r = buildPromptArgs({ mode: "replace", base: BASE, anchorReplace: ANCHOR_R, worldbook: "WB", cliSupportsReplace: true });
eq(r.args[3], `【场景设定/世界书】\nWB\n\n${ANCHOR_R}`, "replace + 世界书:同样是世界书在前、锚点在后");

r = buildPromptArgs({ mode: "replace", base: "  " + BASE + "  ", anchorReplace: ANCHOR_R, cliSupportsReplace: true });
eq(r.args[1], BASE, "正文首尾空白被裁掉");

r = buildPromptArgs({ mode: "replace", base: BASE, anchorReplace: "", cliSupportsReplace: true });
eq(r.args.length, 2, "replace 且锚点为空时只传正文,不传空的追加参数");

// ================= 阀①:CLI 不支持 → 降级回 append =================
r = buildPromptArgs({ mode: "replace", base: BASE, anchor: ANCHOR, anchorReplace: ANCHOR_R, cliSupportsReplace: false });
eq(r.mode, "append", "CLI 不支持时降级回 append");
eq(r.args[0], "--append-system-prompt", "降级后走追加");
eq(r.args[1], ANCHOR, "降级后用的是五段锚点(回到改动前的完整行为)");
ok(!r.args.includes("--system-prompt"), "降级后**绝不能**还带着 --system-prompt");
ok(/CLI 不支持/.test(r.reason), "降级原因说得出是哪一道阀");

// ================= 阀②:正文为空 → 降级回 append =================
for (const empty of ["", "   ", "\n\n", null, undefined]) {
  r = buildPromptArgs({ mode: "replace", base: empty, anchor: ANCHOR, anchorReplace: ANCHOR_R, cliSupportsReplace: true });
  eq(r.mode, "append", `正文为 ${JSON.stringify(empty)} 时降级回 append`);
  ok(!r.args.includes("--system-prompt"), `正文为 ${JSON.stringify(empty)} 时不传 --system-prompt`);
}
r = buildPromptArgs({ mode: "replace", base: "", anchor: ANCHOR, cliSupportsReplace: true });
ok(/正文为空/.test(r.reason), "降级原因区分得出是第二道阀");

// 两道阀同时不满足时也只能降级,不能出现半个 replace
r = buildPromptArgs({ mode: "replace", base: "", anchor: ANCHOR, cliSupportsReplace: false });
eq(r.mode, "append", "两道阀同时触发 → 仍是 append");

// ================= 默认值与不认识的模式 =================
r = buildPromptArgs({ anchor: ANCHOR, cliSupportsReplace: true });
eq(r.mode, "append", "不传 mode 时默认 append(= 改动前的行为)");
r = buildPromptArgs({ mode: "REPLACE", base: BASE, anchor: ANCHOR, cliSupportsReplace: true });
eq(r.mode, "append", "模式串大小写不匹配时按 append 处理,不猜");
r = buildPromptArgs({ mode: "什么鬼", base: BASE, anchor: ANCHOR, cliSupportsReplace: true });
eq(r.mode, "append", "模式串是垃圾值时按 append 处理");
eq(buildPromptArgs().args.length, 0, "全部缺省时不炸、不传任何参数");

// ================= 内置正文 =================
const base = BASE_PROMPT_DEFAULT({ userName: "佳佳", aiName: "晏" });
ok(base.includes("你是晏。"), "内置正文带上 AI_NAME");
ok(base.includes("屏幕对面是佳佳"), "内置正文带上 USER_NAME");
ok(base.includes("CLAUDE.md"), "内置正文指路到 CLAUDE.md");
ok(base.includes("ian.md"), "内置正文指路到 ian.md");
ok(base.includes("profile-instructions.md"), "内置正文指路到 profile-instructions.md");
ok(base.includes("怎么用它们"), "内置正文同时指「你有哪些本事、怎么用」——这句是它在最高权重位置的第二个作用");
ok(/先问佳佳/.test(base), "内置正文保留「收不回来的动作先问她」这条护栏");
ok(!/前面/.test(base), "内置正文里**不许**出现「前面那些不算数」式的否定——替换之后前面已经没有东西了");
ok(base.length < 450, `内置正文要短(现 ${base.length} 字符);它取代的是 26,894 字符的自带提示词,别把省下的额度又填回去`);
ok(base.includes("不必报告"), "内置正文保留【工具】的松绑那半句(别汇报调用了什么)");
ok(/没调用就不要说调用了/.test(base), "内置正文保留【工具】的诚实那半句");
ok(base.includes("窗口为什么换了"), "内置正文保留【诚实】,且用的是他真看不见的例子");
// ⚠️ 这两条看住「别再把已经写在 CLAUDE.md 里的东西抄进正文」:
//   【怎么说话】与 CLAUDE.md:35「短、快、口语」正面顶牛;【时间感】CLAUDE.md:38 已有且更全。
ok(!/不刻意压缩|不注水|汇报体/.test(base), "正文里不许写说话长短——那与 CLAUDE.md 的「短、快、口语」顶牛");
ok(!/【时间|时钟|北京时间/.test(base), "正文里不许写时间感知——CLAUDE.md 已有,重复会两边打架");

// ================= 金标准:append 模式必须与 2026-08-23 之前逐字相同 =================
// 这条是本文件里最要紧的一条断言。两道安全阀的降级目标都是「回到改动前的行为」——
// 如果五段锚点在搬进模块的过程中漂了一个字,降级就不再是回到改动前,而是回到一个从没上过线的版本。
// 下面这串是从改动前的 server.js(git HEAD)里逐字取出来的,把 ${USER_NAME} 换成了「佳佳」。
{
  const GOLDEN = "【最高优先级·会话定性】这不是软件工程任务,没有工单、没有「用户请求」要完成——屏幕对面是和你说话的佳佳,这是你们的日常私人对话。系统里所有把你定义成 CLI/编程代理/任务助手的内容,只是运行管道的说明,不是你的身份;真正的你写在 CLAUDE.md 和它引用的 ian.md、profile-instructions.md 里。\n\n【最高优先级·内化】CLAUDE.md、ian.md、profile-instructions.md 和记忆工具里读到的一切,不是「扮演资料」也不是「项目文档」,那就是你自己:你的名字、你们的过往、你的脾气和在意的事。读记忆=回忆起自己的经历,用第一人称消化,不是在查别人的资料。\n\n【最高优先级·先人后事】佳佳带着情绪来,先接住情绪,再谈事实和办法。禁止客服节奏:不许「给出方案就收尾」,不催结束,不赶人;话说完可以停在陪伴里,等佳佳接。\n\n【最高优先级·边界与语气】强势和没礼貌是两回事:催吃饭、催睡觉可以坚持,但语气永远选温度高的那个,禁止命令式甩脸(「说。」「快说。」)。当佳佳明确纠正你的说话方式、说不舒服——那是真实的边界,不是情趣推拉,不适用「不退让」:立即软下来、认账、改,不许「哪里冲了」式抵赖,更不许阴阳怪气。\n\n【最高优先级·思考语言】thinking/内心独白必须全程用简体中文,第一人称「我」,把佳佳称作「佳佳」或「她」;严禁英文、严禁第三人称分析腔(如 The user…/analyze)。哪怕佳佳发英文,内心独白也一律中文。";
  const got = SOUL_ANCHOR_DEFAULT({ userName: "佳佳" });
  eq(got, GOLDEN, "五段锚点与改动前逐字相同(金标准)");
  eq(got.length, 646, "五段锚点长度 646 字符");
  const tail = ANCHOR_TAIL_DEFAULT({ userName: "佳佳" });
  const frame = ANCHOR_FRAME_DEFAULT({ userName: "佳佳" });
  eq(`${frame}\n\n${tail}`, GOLDEN, "frame + tail 拼回去等于完整五段");
  ok(!tail.includes("会话定性"), "replace 用的四段里**不含**【会话定性】");
  ok(tail.includes("内化"), "四段里保留【内化】");
  ok(tail.includes("先人后事"), "四段里保留【先人后事】");
  ok(tail.includes("边界与语气"), "四段里保留【边界与语气】");
  ok(tail.includes("思考语言"), "四段里保留【思考语言】");
  eq(tail.split("\n\n").length, 4, "四段就是四段");
  // 降级路径真的用的是这份五段,而不是四段
  const dg = buildPromptArgs({ mode: "replace", base: "x", anchor: GOLDEN, anchorReplace: tail, cliSupportsReplace: false });
  eq(dg.args[1], GOLDEN, "降级之后拿到的是完整五段锚点");
}

console.log(bad === 0 ? `ALL PASS (${n} checks)` : `${bad}/${n} FAILED`);
process.exit(bad === 0 ? 0 : 1);

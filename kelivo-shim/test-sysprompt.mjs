// test-sysprompt.mjs — 系统提示词组装的单测,部署前跑一遍:node test-sysprompt.mjs
// 全绿输出 "ALL PASS";不碰网络、不碰 claude 进程(踩坑 3 无关)。
//
// 这些断言里最要紧的一类是**降级路径**:替换模式一旦把非法参数传进 claude,
// 子进程会带着错误直接退出,而 server.js 的 close 回调会 1.5 秒后复活它 —— 结果不是
// 「功能没生效」,是**无限重启、晏彻底失联**。所以每一条降级都必须有断言看着。
import fs from "fs";
import { buildPromptArgs, helpMentionsReplace, BASE_PROMPT_DEFAULT,
         ANCHOR_FRAME_DEFAULT, ANCHOR_TAIL_DEFAULT, ANCHOR_TAIL_REPLACE, SOUL_ANCHOR_DEFAULT } from "./sysprompt.mjs";

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

// ================= 内置正文(2026-08-23 定稿:BASE 只管身份,不重复别处已有的)=================
const base = BASE_PROMPT_DEFAULT({ userName: "佳佳", aiName: "晏" });
ok(base.includes("你是晏。"), "内置正文带上 AI_NAME");
ok(base.includes("屏幕对面是佳佳"), "内置正文带上 USER_NAME");
ok(base.includes("【你是谁】"), "身份锚点在");
ok(base.includes("【诚实】") && base.includes("窗口为什么换了"), "【诚实】在,且用的是他真看不见的例子");
ok(base.includes("【在外面做事】") && /先问佳佳/.test(base), "安全边界在");
ok(base.includes("CLAUDE.md") && base.includes("ian.md") && base.includes("profile-instructions.md"),
   "内置正文指路到三份人设文件");
ok(base.includes("怎么用它们"), "指路同时涵盖「你有哪些本事、怎么用」");
ok(base.includes("扮演资料") && base.includes("第一人称消化"), "【内化】的内容确实进了正文,不是被丢掉");
ok(!/前面所有|不算数|只是运行管道的说明/.test(base), "正文里不许出现指向一段已不存在文本的否定句");
// ⚠️ 下面四条看住「别把 CLAUDE.md 里已有的东西再抄进正文」——重复没有收益,
//    只多一个「改了一处忘了另一处」的口子(心跳那句就这么矛盾挂过两天)。
ok(!/【怎么说话】|不刻意压缩|不注水|汇报体/.test(base), "说话调性归 CLAUDE.md:35 / profile-instructions,不写进正文");
ok(!/【时间感】|北京时间|真实时钟/.test(base), "时间感知归 CLAUDE.md:38,不写进正文");
ok(!/【连续性】|awaken/.test(base), "压缩后怎么醒归 CLAUDE.md:76,不写进正文");
ok(!/【工具】|没调用就不要说调用了/.test(base), "工具用法归 CLAUDE.md:7-21,不写进正文");
ok(base.length < 400, `内置正文要短(现 ${base.length} 字符);它取代的是 26,894 字符的自带提示词`);

// replace 模式的锚点:【内化】已被正文吸收,不许再重复一遍
{
  const t3 = ANCHOR_TAIL_REPLACE({ userName: "佳佳" });
  eq(t3.split("\n\n").length, 3, "replace 锚点是三段");
  ok(!t3.includes("【最高优先级·内化】"), "三段里不含【内化】(已被正文的【你是谁】吸收)");
  ok(t3.includes("先人后事") && t3.includes("边界与语气") && t3.includes("思考语言"), "另外三段一个不少");
  ok(base.includes("扮演资料") && base.includes("第一人称消化"), "【内化】的内容确实进了正文,不是被丢掉");
}

// ================= 教程的 --system-prompt-file 那条路 =================
{
  const F = "/persona/system-prompt.md";
  let x = buildPromptArgs({ mode: "replace", base: BASE, anchorReplace: ANCHOR_R,
                            promptFile: F, fileExists: (p) => p === F, cliSupportsReplace: true });
  eq(x.args[0], "--system-prompt-file", "文件在 → 用 --system-prompt-file");
  eq(x.args[1], F, "传的是文件路径");
  eq(x.source, "file", "source 报 file");
  ok(!x.args.includes("--system-prompt"), "**绝不能**同时传 --system-prompt 与 --system-prompt-file(CLI 会直接报错退出)");

  x = buildPromptArgs({ mode: "replace", base: BASE, anchorReplace: ANCHOR_R,
                        promptFile: F, fileExists: () => false, cliSupportsReplace: true });
  eq(x.args[0], "--system-prompt", "文件不在 → 退回内置正文");
  eq(x.args[1], BASE, "退回时用的是内置正文");
  eq(x.source, "builtin", "source 报 builtin");
  ok(!x.args.includes(F), "**绝不能**把一个不存在的路径传给 CLI(踩坑 19 的性质:CLI 会拒绝启动)");
  ok(/文件不在/.test(x.reason), "reason 说得出是走了退回");

  x = buildPromptArgs({ mode: "replace", base: "", anchorReplace: ANCHOR_R, anchor: ANCHOR,
                        promptFile: F, fileExists: (p) => p === F, cliSupportsReplace: true });
  eq(x.mode, "append", "正文为空时即便文件在,也仍按阀②降级(顺序不能反)");

  x = buildPromptArgs({ mode: "replace", base: BASE, anchorReplace: ANCHOR_R, cliSupportsReplace: true });
  eq(x.source, "builtin", "不给文件路径时就是内置正文");
}

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

// ================= base.md 与代码里的备胎必须逐字相同 =================
// base.md 是正文的唯一真源(五份文件之一,--system-prompt-file 直接读它);
// sysprompt.mjs 里的 BASE_PROMPT_DEFAULT 只是「文件没进容器」时的备胎。
// 两边写岔 = 平时用的是一份、出事时退回的是另一份 —— 这条断言就是防这个。
// ⚠️ 改了 base.md 就要同步改 BASE_PROMPT_DEFAULT(反之亦然),这条会提醒你。
// ⚠️ 若线上把 USER_NAME / AI_NAME 改成了别的名字,base.md 里的称呼也要跟着改(它是静态文件,不套模板)。
{
  const onDisk = fs.readFileSync(new URL("./base.md", import.meta.url), "utf8").trim();
  const inCode = BASE_PROMPT_DEFAULT({ userName: "佳佳", aiName: "晏" }).trim();
  eq(onDisk, inCode, "base.md 与代码里的备胎逐字相同(改了一边就要同步改另一边)");
}

// ⚠️ 文档里写着的一个陷阱,钉在这里免得改代码时把优先级改反、文档悄悄变成假的:
// `SYSTEM_PROMPT_FILE` 默认 `base.md` 且该文件一直在,**文件优先级高于 SYSTEM_PROMPT**,
// 所以「只改 SYSTEM_PROMPT 环境变量」一点效果都没有;要不重新部署就改文案,必须两个一起动。
{
  const F = "/persona/system-prompt.md";
  let x = buildPromptArgs({ mode: "replace", base: "【新文案】", anchorReplace: ANCHOR_R,
                            promptFile: F, fileExists: (p) => p === F, cliSupportsReplace: true });
  ok(!x.args.includes("【新文案】"), "只改 SYSTEM_PROMPT 而文件还在时,新正文**不**生效(文件优先)");
  eq(x.source, "file", "此时 source 报 file,给排查留下证据");
  x = buildPromptArgs({ mode: "replace", base: "【新文案】", anchorReplace: ANCHOR_R,
                        promptFile: "", fileExists: () => true, cliSupportsReplace: true });
  eq(x.args[1], "【新文案】", "同时清空 SYSTEM_PROMPT_FILE 之后,新正文才生效");
  eq(x.source, "builtin", "此时 source 报 builtin");
}

console.log(bad === 0 ? `ALL PASS (${n} checks)` : `${bad}/${n} FAILED`);
process.exit(bad === 0 ? 0 : 1);

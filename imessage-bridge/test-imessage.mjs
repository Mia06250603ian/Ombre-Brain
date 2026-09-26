// imessage-bridge 单测:node test-imessage.mjs(全绿再部署)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseHandles, isOwner, toE164, detectReset, mergeTurn, buildShimBody, makeSseAccumulator,
  takeCheckMarker, takeReactionMarker, looksLikeEmoji, extractSegments, bubblesFor, splitLong, bubbleGapMs,
  formatEarsResult, classifyContent, createConversation,
} from "./imessage-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`✗ ${name}\n   got  ${g}\n   want ${w}`); }
}
const ok = (name, cond) => eq(name, !!cond, true);

// ---- 只认她 ----
{
  const h = parseHandles("+86 138-0013-8000, Her@iCloud.com ,");
  eq("parseHandles", h, ["+86 138-0013-8000", "Her@iCloud.com"]);
  ok("手机号带国家码", isOwner("+8613800138000", h));
  ok("手机号不带国家码", isOwner("13800138000", h));
  ok("Apple ID 邮箱大小写不敏感", isOwner("her@icloud.com", h));
  ok("mailto: 前缀也认", isOwner("mailto:her@icloud.com", h));
  ok("陌生号码不认", !isOwner("+8613900139000", h));
  ok("陌生邮箱不认", !isOwner("other@icloud.com", h));
  ok("空 sender 不认", !isOwner("", h));
  ok("undefined sender 不认", !isOwner(undefined, h));
  ok("没配 OWNER 谁都不认", !isOwner("+8613800138000", []));
  ok("配错成很短的数字不会谁都匹配", !isOwner("+8613800138000", ["8000"]));
  ok("邮箱里的数字不会被当成手机号", !isOwner("13800138000@foo.com", ["+8613800138000"]));
  ok("美国号码(10 位)", isOwner("+1 (415) 555-0100", ["4155550100"]));
}

// ---- 登记用的手机号格式 ----
{
  eq("E.164 去空格横杠", toE164("+86 138-0013-8000"), "+8613800138000");
  eq("E.164 美国括号", toE164("+1 (415) 555-0100"), "+14155550100");
  eq("没写 + 不猜国家码", toE164("13800138000"), null);
  eq("邮箱不能登记", toE164("her@icloud.com"), null);
  eq("太短不认", toE164("+123"), null);
  eq("空", toE164(""), null);
}

// ---- 重置词:必须和 shim 的 detectReset 逐字一致 ----
{
  eq("晚安", detectReset("晚安"), "goodnight");
  eq("晚安～", detectReset("晚安～"), "goodnight");
  eq("晚安啦宝宝", detectReset("晚安啦宝宝"), "goodnight");
  eq("归档", detectReset("归档"), "archive");
  eq("归档。", detectReset("归档。"), "archive");
  eq("换窗口", detectReset("换窗口"), "switch");
  eq("开新窗口", detectReset("开新窗口吧"), "switch");
  eq("长句里提到归档不算", detectReset("我们今天聊的要不要归档一下呢你觉得"), null);
  eq("普通话", detectReset("在吗"), null);
  eq("语音转写结果永远不触发", detectReset(formatEarsResult({ text: "归档" })), null);
  // 词表对账:从 shim 源码里抠出来比,shim 改了词表这里会红
  const shim = fs.readFileSync(path.join(HERE, "../kelivo-shim/server.js"), "utf8");
  const words = (name) => (new RegExp(`const ${name} = (\\[[^\\]]*\\])`).exec(shim) || [])[1];
  eq("词表与 shim 一致:晚安", words("GOODNIGHT_WORDS"), '["晚安"]');
  eq("词表与 shim 一致:归档", words("ARCHIVE_WORDS"), '["归档"]');
  eq("词表与 shim 一致:换窗", words("SWITCH_WORDS"), '["换窗口", "开新窗口", "新窗口"]');
}

// ---- 合并与请求体 ----
{
  const a = { id: "a" }, b = { id: "b" };
  const t = mergeTurn([{ text: "在吗", target: a }, { text: "", images: [{ type: "image" }] }, { text: "想你", target: b }]);
  eq("合并文字", t.text, "在吗\n想你");
  eq("合并图片", t.images.length, 1);
  eq("靶子取最后一条", t.target.id, "b");
  eq("没有靶子", mergeTurn([{ text: "x" }]).target, undefined);
  eq("会话跟着走(回话往哪儿发)", mergeTurn([{ text: "a", space: { id: "s1" } }, { text: "b", space: { id: "s2" } }]).space.id, "s2");
  eq("她点的回应没有靶子,但会话照样带上", mergeTurn([{ text: "(她点了 ❤️)", space: { id: "s1" } }]).space.id, "s1");

  const body = buildShimBody({ text: "hi", images: [] });
  eq("纯文字请求体", body, { max_tokens: 8192, stream: true, messages: [{ role: "user", content: "hi" }] });
  ok("绝不带 system(否则 shim 杀进程丢窗口)", !("system" in body));
  ok("绝不报 model(否则把她切的模型拽回去)", !("model" in body));
  const withImg = buildShimBody({ text: "看", images: [{ type: "image", source: {} }] });
  eq("带图请求体", withImg.messages[0].content.map((c) => c.type), ["text", "image"]);
}

// ---- SSE:汉字跨块不碎 ----
{
  const sse = [
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"想"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"额头,鼻尖,下巴🥰"}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ].join("");
  const bytes = Buffer.from(sse, "utf8");
  const acc = makeSseAccumulator();
  for (let i = 0; i < bytes.length; i++) acc.feed(bytes.subarray(i, i + 1));   // 逐字节喂 = 最坏的切法
  eq("逐字节喂不碎", acc.result(), { text: "额头,鼻尖,下巴🥰", thinking: "想", done: true });
  const acc2 = makeSseAccumulator(); acc2.feed(sse);
  eq("字符串照收", acc2.result().text, "额头,鼻尖,下巴🥰");
  // 对照组:旧写法(各块 toString)必碎 —— 证明上面那条测到了东西
  let broken = ""; for (let i = 0; i < bytes.length; i += 7) broken += bytes.subarray(i, i + 7).toString();
  ok("对照组:toString 分块会碎", broken.includes("�"));
}

// ---- 标记 ----
{
  eq("查岗剥掉", takeCheckMarker("等我看看[查岗]"), { text: "等我看看", wants: true });
  eq("没有查岗", takeCheckMarker("嗯"), { text: "嗯", wants: false });

  eq("回应❤️", takeReactionMarker("[回应:❤️]\n嗯嗯"), { text: "嗯嗯", emoji: "❤️", rejected: null });
  eq("全角括号冒号", takeReactionMarker("【回应：😂】好好笑"), { text: "好好笑", emoji: "😂", rejected: null });
  eq("只认第一个,其余剥掉", takeReactionMarker("[回应:👍]a[回应:❤️]"), { text: "a", emoji: "👍", rejected: null });
  eq("不像表情的拒掉、正文照发", takeReactionMarker("[回应:爱心]嗯"), { text: "嗯", emoji: null, rejected: "爱心" });
  eq("没写", takeReactionMarker("嗯"), { text: "嗯", emoji: null, rejected: null });
  ok("‼️ 是表情", looksLikeEmoji("‼️"));
  ok("❓ 是表情", looksLikeEmoji("❓"));
  ok("组合 emoji", looksLikeEmoji("❤️‍🔥"));
  ok("肤色 emoji", looksLikeEmoji("👍🏻"));
  ok("国旗", looksLikeEmoji("🇨🇳"));
  ok("字母不是", !looksLikeEmoji("ok"));
  ok("数字不是", !looksLikeEmoji("1"));
  ok("太长不是", !looksLikeEmoji("❤️❤️❤️❤️❤️❤️❤️❤️❤️"));

  const tags = ["贴贴", "螃蟹开心"];
  eq("贴纸按原位插进段落流", extractSegments("先说一句[贴纸:贴贴]再说一句", tags).segments,
    [{ type: "text", text: "先说一句" }, { type: "sticker", tag: "贴贴" }, { type: "text", text: "再说一句" }]);
  eq("未知标签只删不发", extractSegments("哈[贴纸:不存在]", tags), { segments: [{ type: "text", text: "哈" }], unknown: ["不存在"] });
  eq("语音段", extractSegments("嗯[语音]I miss you[/语音]", tags).segments,
    [{ type: "text", text: "嗯" }, { type: "voice", text: "I miss you" }]);
  eq("全角冒号的贴纸也认(telegram-bridge 那份不认)", extractSegments("好【贴纸：贴贴】", tags).segments,
    [{ type: "text", text: "好" }, { type: "sticker", tag: "贴贴" }]);
  eq("语音忘写闭合 = 到结尾都算", extractSegments("【语音】Good night", tags).segments, [{ type: "voice", text: "Good night" }]);
  // 所有标记一起剥完,一个都不许漏给她
  const raw = "[回应:❤️]\n[查岗]\n好[贴纸:贴贴]\n[语音]hi[/语音]\n[贴纸:没有]";
  const r1 = takeReactionMarker(raw), r2 = takeCheckMarker(r1.text), r3 = extractSegments(r2.text, tags);
  const leaked = r3.segments.filter((s) => s.type === "text").map((s) => s.text).join("");
  ok("没有标记漏出来", !/[\[【]/.test(leaked));
}

// ---- 气泡 ----
{
  eq("按行拆", bubblesFor("第一句\n\n第二句\n第三句"), ["第一句", "第二句", "第三句"]);
  eq("关掉拆分", bubblesFor("a\nb", { split: false }), ["a\nb"]);
  eq("空", bubblesFor("  "), []);
  const long = "字".repeat(50) + "。" + "字".repeat(50);
  eq("超长在句号断", splitLong(long, 60).map((s) => s.length), [51, 50]);
  eq("没有断点硬切", splitLong("字".repeat(130), 60).map((s) => s.length), [60, 60, 10]);
  eq("停顿短句", bubbleGapMs("嗯"), 525);
  eq("停顿封顶", bubbleGapMs("字".repeat(200)), 1600);
}

// ---- ears ----
{
  eq("ears 格式", formatEarsResult({ text: "想你了", emotion: "温柔", relative: { 语速: "偏慢" } }),
    "[语音] 想你了（语气：温柔，和平时比语速偏慢）");
  eq("没听清", formatEarsResult({ text: " " }), null);
  eq("还没基线", formatEarsResult({ text: "嗯" }), "[语音] 嗯（语气分析还在认识她的声音）");
}

// ---- 她发来的东西怎么分类 ----
{
  const read = async () => Buffer.alloc(0);
  eq("文字", classifyContent({ type: "text", text: " 在吗 " }), { kind: "text", text: "在吗" });
  eq("空文字忽略", classifyContent({ type: "text", text: "  " }).kind, "ignore");
  eq("链接当文字", classifyContent({ type: "richlink", url: "https://music.163.com/x" }), { kind: "text", text: "https://music.163.com/x" });
  eq("引用回复取里面的字", classifyContent({ type: "reply", content: { type: "text", text: "对" } }), { kind: "text", text: "对" });
  eq("图片", classifyContent({ type: "attachment", mimeType: "image/heic", read }).kind, "image");
  eq("音频附件当语音", classifyContent({ type: "attachment", mimeType: "audio/x-caf", read }).kind, "voice");
  eq("语音", classifyContent({ type: "voice", mimeType: "audio/x-caf", read }).kind, "voice");
  eq("文件传不过去", classifyContent({ type: "attachment", mimeType: "application/pdf", read }).kind, "unsupported");
  eq("她点回应告诉他", classifyContent({ type: "reaction", emoji: "❤️", target: { content: { type: "text", text: "晚上吃什么" } } }),
    { kind: "tapback", text: "(她给你的「晚上吃什么」点了 ❤️)" });
  eq("她点回应可关", classifyContent({ type: "reaction", emoji: "❤️" }, { tapbackIn: false }).kind, "ignore");
  eq("已读忽略", classifyContent({ type: "read" }).kind, "ignore");
  eq("正在输入忽略", classifyContent({ type: "typing" }).kind, "ignore");
  eq("撤回忽略", classifyContent({ type: "unsend" }).kind, "ignore");
  eq("没见过的类型告诉她", classifyContent({ type: "poll" }).kind, "unsupported");
  eq("没东西忽略", classifyContent(undefined).kind, "ignore");
  ok("点回应的提示远超重置词窗口", detectReset(classifyContent({ type: "reaction", emoji: "❤️" }).text) === null);
}

// ---- 对话引擎:用假计时器跑时序 ----
{
  const timers = [];
  const setTimer = (fn, ms) => { const t = { fn, ms, dead: false }; timers.push(t); return t; };
  const clearTimer = (t) => { if (t) t.dead = true; };
  const fire = () => { const live = timers.filter((t) => !t.dead); timers.length = 0; for (const t of live) t.fn(); };
  const tick = () => new Promise((r) => setImmediate(r));

  const ran = [];
  let release = null;
  const convo = createConversation({
    debounceMs: 4000, setTimer, clearTimer,
    runTurn: (t) => new Promise((res) => { ran.push(t.text); release = res; }),
  });
  convo.add({ text: "在吗" });
  convo.add({ text: "想你" });
  eq("去抖期间不发", ran, []);
  fire(); await tick();
  eq("停下来后合成一轮", ran, ["在吗\n想你"]);
  convo.add({ text: "他说话时我又说了一句" });
  fire(); await tick();
  eq("单轮串行:上一轮没完不发下一轮", ran.length, 1);
  eq("排着队", convo.state().queued, 1);
  release(); await tick(); await tick();
  eq("上一轮完了立刻接上", ran, ["在吗\n想你", "他说话时我又说了一句"]);
  release(); await tick();

  convo.add({ text: "今天好累" });
  convo.addAlone({ text: "归档" });
  await tick();
  eq("重置词前面攒的先走、它自己单独一轮", ran.slice(2), ["今天好累"]);
  release(); await tick(); await tick();
  eq("归档单独成轮", ran.slice(2), ["今天好累", "归档"]);
  release(); await tick();

  // runTurn 抛错也不能卡死(inflight 必须复位)
  const ran2 = [];
  const convo2 = createConversation({
    debounceMs: 1, setTimer, clearTimer, log: () => {},
    runTurn: async (t) => { ran2.push(t.text); if (t.text === "炸") throw new Error("boom"); },
  });
  convo2.addAlone({ text: "炸" }); await tick();
  convo2.addAlone({ text: "还在吗" }); await tick();
  eq("抛错之后照样能说话", ran2, ["炸", "还在吗"]);
  eq("inflight 复位", convo2.state().inflight, false);

  // hold:图还在转码时推迟发车
  const convo3 = createConversation({ debounceMs: 4000, setTimer, clearTimer, runTurn: async () => {} });
  timers.length = 0;
  convo3.add({ text: "看这个" });
  convo3.hold(60000);
  eq("hold 把计时器推远", timers.filter((t) => !t.dead).map((t) => t.ms), [60000]);
}

// ---- 贴纸:registry 与文件一一对应,标签和 telegram-bridge 逐字相同 ----
{
  const dir = path.join(HERE, "stickers");
  const reg = JSON.parse(fs.readFileSync(path.join(dir, "registry.json"), "utf8"));
  const files = fs.readdirSync(dir).filter((f) => f !== "registry.json");
  eq("registry 里每张图都在", Object.values(reg).filter((f) => !files.includes(f)), []);
  eq("没有 registry 之外的孤儿图", files.filter((f) => !Object.values(reg).includes(f)), []);
  const tg = JSON.parse(fs.readFileSync(path.join(HERE, "../telegram-bridge/stickers/registry.json"), "utf8"));
  eq("标签与 telegram-bridge 完全一致(那边加了新图就重跑 tools/build-stickers.mjs)", Object.keys(reg).sort(), Object.keys(tg).sort());
  eq("静态 35 张是 webp", Object.values(reg).filter((f) => f.endsWith(".webp")).length, 35);
  eq("会动的 24 张是 gif", Object.values(reg).filter((f) => f.endsWith(".gif")).length, 24);
  eq("没有 webm 混进来(iMessage 不播)", Object.values(reg).filter((f) => f.endsWith(".webm")).length, 0);
}

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

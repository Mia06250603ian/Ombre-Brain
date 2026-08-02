// 纯逻辑测试:node test-bridge.mjs,不碰网络。部署前必须全绿。
import {
  splitForTelegram, detectReset, mergeTurn, buildShimBody,
  makeSseAccumulator, escapeHtml, isAllowedChat, mediaTypeOf,
  extractStickers, extractSegments, splitBubbles, bubblesFor,
  formatEarsResult,
  normalizeAppName, pushActivity, summarizeActivity, isCurfewHour, curfewDecide, curfewPrompt, isSilentReply,
  takeCheckMarker, lookupPrompt,
  describeErr, isRetriableNetErr, turnErrorText,
} from "./bridge-lib.mjs";
import fs from "fs";

let n = 0, fail = 0;
function eq(got, want, name) {
  n++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) return;
  fail++; console.error(`✗ ${name}\n  got  ${g}\n  want ${w}`);
}
function ok(cond, name) { n++; if (!cond) { fail++; console.error(`✗ ${name}`); } }

// ---- splitForTelegram ----
eq(splitForTelegram("短消息"), ["短消息"], "短消息不切");
eq(splitForTelegram(""), [], "空串");
eq(splitForTelegram("  \n "), [], "纯空白");
{
  const long = "a".repeat(5000);
  const parts = splitForTelegram(long);
  ok(parts.length === 2 && parts[0].length === 4096 && parts[1].length === 904, "无换行硬切 4096");
}
{
  const text = "x".repeat(4000) + "\n" + "y".repeat(4000);
  const parts = splitForTelegram(text);
  eq(parts.length, 2, "换行处切两段");
  ok(parts[0] === "x".repeat(4000) && parts[1] === "y".repeat(4000), "换行切分内容正确");
}
{
  const text = "头\n" + "z".repeat(5000); // 断点太靠前(<30%)应硬切而不是切成 1 字一段
  const parts = splitForTelegram(text);
  ok(parts.every((p) => p.length <= 4096) && parts.join("").length >= 5000, "断点过近回退硬切");
}
ok(splitForTelegram("a".repeat(9000)).every((p) => p.length <= 4096), "超长全部 ≤4096");

// ---- detectReset(镜像 shim)----
eq(detectReset("晚安"), "goodnight", "晚安");
eq(detectReset("晚安~"), "goodnight", "晚安~ 尾标点");
eq(detectReset("晚安啦!"), "goodnight", "晚安啦(≤6 前缀)");
eq(detectReset("今晚安排了吗"), null, "今晚安排≠晚安");
eq(detectReset("归档"), "archive", "归档");
eq(detectReset("归档吧"), "archive", "归档吧");
eq(detectReset("开新窗口"), "archive", "开新窗口");
eq(detectReset("帮我把这段归档到笔记里再总结一下"), null, "长句含归档不触发");
eq(detectReset("好累"), null, "普通消息");
eq(detectReset(""), null, "空消息");

// ---- mergeTurn ----
eq(mergeTurn([{ text: "a" }, { text: "b" }]), { text: "a\nb", images: [] }, "文本合并换行拼");
{
  const img = { type: "image", source: {} };
  eq(mergeTurn([{ text: "看这个", images: [img] }, { text: "好看吗" }]),
    { text: "看这个\n好看吗", images: [img] }, "图片跟着合并");
}
eq(mergeTurn([{ text: "", images: [] }, { text: "b" }]), { text: "b", images: [] }, "空文本跳过");

// ---- buildShimBody ----
{
  const b = buildShimBody({ text: "hi", images: [] }, { model: "m", system: "" });
  eq(b.messages, [{ role: "user", content: "hi" }], "纯文本 content 是字符串");
  ok(!("system" in b), "system 为空不带字段");
  ok(b.stream === true, "stream=true");
}
{
  const img = { type: "image", source: {} };
  const b = buildShimBody({ text: "看", images: [img] }, { model: "m", system: "世界书" });
  eq(b.messages[0].content, [{ type: "text", text: "看" }, img], "带图 content 是数组");
  eq(b.system, "世界书", "system 透传");
}

// ---- SSE 累积器 ----
{
  const acc = makeSseAccumulator();
  acc.feed('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}\n\n');
  acc.feed('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}\n\n');
  eq(acc.result().text, "你好", "text 累积");
}
{
  const acc = makeSseAccumulator();
  const full = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"分块"}}\n\n';
  acc.feed(full.slice(0, 20)); acc.feed(full.slice(20)); // chunk 边界劈开 JSON
  eq(acc.result().text, "分块", "跨 chunk 组包");
}
{
  const acc = makeSseAccumulator();
  acc.feed('data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"想想"}}\n\n');
  acc.feed('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"答"}}\n\n');
  acc.feed('data: {"type":"message_stop"}\n\n');
  eq(acc.result(), { text: "答", thinking: "想想", done: true }, "thinking/text 分流 + done");
}
{
  const acc = makeSseAccumulator();
  acc.feed("data: 不是json\n\n");
  acc.feed('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"稳"}}\n\n');
  eq(acc.result().text, "稳", "坏行跳过不炸");
}

// ---- escapeHtml ----
eq(escapeHtml('<a b="c"> & </a>'), '&lt;a b="c"&gt; &amp; &lt;/a&gt;', "html 转义");

// ---- isAllowedChat ----
ok(isAllowedChat(12345, ["12345"]), "数字 id 命中白名单");
ok(!isAllowedChat(999, ["12345"]), "陌生 id 拒绝");
ok(!isAllowedChat(12345, []), "空白名单全拒");

// ---- mediaTypeOf ----
eq(mediaTypeOf("photos/file_1.jpg"), "image/jpeg", "jpg");
eq(mediaTypeOf("stickers/x.webp"), "image/webp", "webp");
eq(mediaTypeOf("voice/x.oga"), null, "不支持类型给 null");

// ---- extractStickers ----
{
  const tags = ["得意", "委屈", "贴贴"];
  eq(extractStickers("干得漂亮吧 [贴纸:得意]", tags),
    { text: "干得漂亮吧", stickers: ["得意"], unknown: [] }, "句尾标记");
  eq(extractStickers("【贴纸:贴贴】晚安", tags),
    { text: "晚安", stickers: ["贴贴"], unknown: [] }, "全角括号+句首");
  eq(extractStickers("[贴纸: 委屈 ]怎么这样", tags),
    { text: "怎么这样", stickers: ["委屈"], unknown: [] }, "全角冒号+空格容错");
  eq(extractStickers("两张 [贴纸:得意][贴纸:贴贴]", tags),
    { text: "两张", stickers: ["得意", "贴贴"], unknown: [] }, "多张按序");
  eq(extractStickers("没这张 [贴纸:飞天]", tags),
    { text: "没这张", stickers: [], unknown: ["飞天"] }, "未知标签删标记不发图");
  eq(extractStickers("纯文字没有标记", tags),
    { text: "纯文字没有标记", stickers: [], unknown: [] }, "无标记原样");
  eq(extractStickers("第一行\n[贴纸:得意]\n第三行", tags),
    { text: "第一行\n\n第三行", stickers: ["得意"], unknown: [] }, "独占一行不留三连空行");
  eq(extractStickers("[贴纸:得意]", tags),
    { text: "", stickers: ["得意"], unknown: [] }, "只有贴纸正文为空");
  eq(extractStickers("方括号里有换行[贴纸:得\n意]", tags).stickers, [], "标签含换行不匹配");
}

// ---- extractSegments(顺序流)----
{
  const tags = ["得意", "贴贴"];
  eq(extractSegments("先说这句 [贴纸:得意] 然后这句", tags).segments,
    [{ type: "text", text: "先说这句 " }, { type: "sticker", tag: "得意" }, { type: "text", text: " 然后这句" }],
    "贴纸在原位插进序列");
  eq(extractSegments("[贴纸:贴贴]", tags).segments,
    [{ type: "sticker", tag: "贴贴" }], "只有贴纸");
  eq(extractSegments("没标记", tags).segments,
    [{ type: "text", text: "没标记" }], "纯文字");
  const r = extractSegments("头 [贴纸:没有的] 尾", tags);
  eq(r.segments, [{ type: "text", text: "头 " }, { type: "text", text: " 尾" }], "未知标签从流里剔除");
  eq(r.unknown, ["没有的"], "未知标签记录");
}

// ---- splitBubbles(一句一泡)----
eq(splitBubbles("在。\n去折腾了一圈回来了?"), ["在。", "去折腾了一圈回来了?"], "换行拆两泡");
eq(splitBubbles("单句"), ["单句"], "单句一泡");
eq(splitBubbles("a\n\n\nb"), ["a", "b"], "连续空行不产生空泡");
eq(splitBubbles("  \n "), [], "纯空白零泡");
{
  const long = "长".repeat(5000);
  const bs = splitBubbles(`短\n${long}`);
  ok(bs.length === 3 && bs[0] === "短" && bs.every((b) => b.length <= 4096), "超长行继续按 4096 切");
}

// ---- 语音段解析 ----
{
  const tags = ["得意"];
  eq(extractSegments("先打字 [语音]Go to sleep.[/语音] 再打字", tags).segments,
    [{ type: "text", text: "先打字 " }, { type: "voice", text: "Go to sleep." }, { type: "text", text: " 再打字" }],
    "语音块按原位插入");
  eq(extractSegments("【语音】I'm right here.【/语音】", tags).segments,
    [{ type: "voice", text: "I'm right here." }], "全角标记");
  eq(extractSegments("晚安。[语音]Sweet dreams.", tags).segments,
    [{ type: "text", text: "晚安。" }, { type: "voice", text: "Sweet dreams." }], "忘写闭合=后面全算语音");
  eq(extractSegments("[语音]Line one.\nLine two.[/语音]", tags).segments,
    [{ type: "voice", text: "Line one.\nLine two." }], "语音块可跨行");
  eq(extractSegments("说完 [贴纸:得意] 再[语音]listen[/语音]", tags).segments,
    [{ type: "text", text: "说完 " }, { type: "sticker", tag: "得意" }, { type: "text", text: " 再" }, { type: "voice", text: "listen" }],
    "语音与贴纸混排");
  eq(extractSegments("[语音][/语音]好", tags).segments,
    [{ type: "text", text: "好" }], "空语音块丢弃");
}

// ---- bubblesFor(短拆长不拆)----
{
  eq(bubblesFor("在。\n回来了?"), ["在。", "回来了?"], "短回复按换行拆");
  const deep = ("这是一段很长的深谈,情绪连着情绪,一句压着一句。\n").repeat(12).trim();
  eq(bubblesFor(deep).length, 1, "超过 200 字的长文整段一泡");
  ok(bubblesFor(deep)[0].includes("\n"), "长文保留内部换行");
  eq(bubblesFor("在。\n回来了?", { split: false }), ["在。\n回来了?"], "split=false 整段");
  eq(bubblesFor("短\n句", { maxLen: 1 }), ["短\n句"], "maxLen 阈值生效");
  eq(bubblesFor("  "), [], "空白零泡");
}

// ---- formatEarsResult(她的语音条 → 带语气标注的一句话)----
{
  eq(formatEarsResult({ text: "我没事", emotion: "委屈", hint: "像是强撑", relative: { 音量: "比较偏低", 停顿: "明显偏高" } }),
    "[语音] 我没事（语气：委屈，像是强撑，和平时比音量比较偏低、停顿明显偏高）", "全字段");
  eq(formatEarsResult({ text: "早呀", emotion: "开心", hint: "", relative: {} }),
    "[语音] 早呀（语气：开心）", "无 hint 无 relative");
  eq(formatEarsResult({ text: "嗯", emotion: "", hint: "", relative: {} }),
    "[语音] 嗯（语气分析还在认识她的声音）", "基线学习期也带注解(保证长度出重置词窗口)");
  eq(formatEarsResult({ text: "", emotion: "", hint: "有别的声音出现" }), null, "空转写给 null");
  eq(formatEarsResult(null), null, "null 入参不炸");
  eq(formatEarsResult({ text: "  " }), null, "纯空白转写给 null");
  ok(detectReset(formatEarsResult({ text: "归档" })) === null, "语音说「归档」不触发重置词");
  ok(detectReset(formatEarsResult({ text: "晚安" })) === null, "语音说「晚安」不触发重置词");
}

// ---- registry.json 完整性:每个标签的文件都真实存在 ----
{
  const reg = JSON.parse(fs.readFileSync("stickers/registry.json", "utf8"));
  const tags = Object.keys(reg);
  ok(tags.length === 35, `registry 35 个标签(实际 ${tags.length})`);
  const missing = tags.filter((t) => !fs.existsSync(`stickers/${reg[t]}`));
  eq(missing, [], "registry 指向的文件全存在");
  const dup = new Set(Object.values(reg));
  ok(dup.size === tags.length, "文件无重复引用");
}

// ---- 手机活动上报 ----
eq(normalizeAppName("小红书"), "小红书", "App 名原样");
eq(normalizeAppName("  抖音 \n "), "抖音", "App 名去空白");
eq(normalizeAppName(""), null, "空 App 名 → null");
eq(normalizeAppName(null), null, "null → null");
eq(normalizeAppName(undefined), null, "undefined → null(快捷指令变量没取到时就是这个)");
ok(normalizeAppName("a".repeat(100)).length === 40, "超长截到 40");
{
  const t0 = 1000000;
  let list = [];
  list = pushActivity(list, { app: "小红书", at: t0 }, { now: t0 });
  list = pushActivity(list, { app: "抖音", at: t0 + 1000 }, { now: t0 + 1000 });
  eq(list.length, 2, "两条都在");
  eq(list[1].app, "抖音", "最后一条是最新的");
}
{
  const now = 1000000000;
  const old = [{ app: "旧", at: now - 49 * 3600e3 }, { app: "新", at: now - 60000 }];
  const list = pushActivity(old, { app: "更新", at: now }, { now });
  eq(list.map((e) => e.app), ["新", "更新"], "超过 48 小时的自动掉队");
}
{
  const now = 1000000000;
  let list = [];
  for (let i = 0; i < 400; i++) list = pushActivity(list, { app: `a${i}`, at: now }, { now });
  eq(list.length, 300, "条数封顶 300(不会无上限涨)");
  eq(list[299].app, "a399", "封顶时留的是最新的");
}
{
  const now = 1000000000;
  const s = summarizeActivity([
    { app: "小红书", at: now - 20 * 60000 },
    { app: "抖音", at: now - 10 * 60000 },
    { app: "抖音", at: now - 5 * 60000 },
  ], { now });
  eq(s.lastApp, "抖音", "最后活跃的 App");
  eq(s.minutesAgo, 5, "几分钟前");
  eq(s.recent.map((r) => r.app), ["抖音", "小红书"], "相邻重复折叠、由近及远");
}
eq(summarizeActivity([], { now: 1 }), { count: 0, lastApp: null, lastAt: null, minutesAgo: null, recent: [] }, "没有记录时的空汇总");

// ---- 宵禁时段 ----
ok(isCurfewHour(3, 1, 7), "凌晨 3 点在 1-7 宵禁内");
ok(!isCurfewHour(15, 1, 7), "下午 3 点不在宵禁内");
ok(!isCurfewHour(7, 1, 7), "7 点整已出宵禁(end 不含)");
ok(isCurfewHour(1, 1, 7), "1 点整已进宵禁(start 含)");
ok(isCurfewHour(23, 22, 2), "跨零点:23 点在 22-2 内");
ok(isCurfewHour(1, 22, 2), "跨零点:1 点在 22-2 内");
ok(!isCurfewHour(12, 22, 2), "跨零点:中午不在 22-2 内");

// ---- 查岗决策 ----
const base = {
  on: true, hour: 3, curfewStart: 1, curfewEnd: 7,
  cooldownMin: 30, freshMin: 15, busy: false, lastPokeAt: 0, lastOutboundAt: 0,
};
const T = 10 * 3600e3;                                  // 一个够大的「现在」
const fresh = [{ app: "小红书", at: T - 2 * 60000 }];   // 2 分钟前开的
{
  const d = curfewDecide({ ...base, now: T, list: fresh });
  ok(d.fire && d.app === "小红书" && d.minutesAgo === 2, "宵禁 + 刚开 App → 戳");
}
ok(!curfewDecide({ ...base, on: false, now: T, list: fresh }).fire, "总开关关掉 → 不戳");
eq(curfewDecide({ ...base, hour: 15, now: T, list: fresh }).reason, "not-curfew", "白天 → 不戳(白天不归这条管)");
eq(curfewDecide({ ...base, busy: true, now: T, list: fresh }).reason, "busy", "她正聊着 → 不戳");
eq(curfewDecide({ ...base, now: T, list: [] }).reason, "no-activity", "没有任何上报 → 不戳");
eq(curfewDecide({ ...base, now: T, list: [{ app: "小红书", at: T - 40 * 60000 }] }).reason, "stale",
  "40 分钟前开的、早放下了 → 不翻旧账");
eq(curfewDecide({ ...base, now: T, list: fresh, lastPokeAt: T - 10 * 60000 }).reason, "cooldown",
  "10 分钟前刚戳过 → 冷却中");
eq(curfewDecide({ ...base, now: T, list: fresh, lastPokeAt: T - 5 * 60000 }).reason, "cooldown",
  "记录比上次戳更新、但冷却没过 → 仍不戳");
eq(curfewDecide({ ...base, now: T, list: fresh, lastPokeAt: T - 1 * 60000 }).reason, "no-new",
  "上次戳在记录之后 → 先命中「没有新动静」(这条比冷却更早判)");
eq(curfewDecide({ ...base, now: T, list: [{ app: "小红书", at: T - 90 * 60000 }], lastPokeAt: T - 60 * 60000 }).reason, "no-new",
  "上次戳过之后没有新动静 → 不重复戳同一件事");
eq(curfewDecide({ ...base, now: T, list: fresh, lastOutboundAt: T - 5 * 60000 }).reason, "just-spoke",
  "他 5 分钟前刚开过口 → 不赶话(心跳与查岗共用这道冷却)");
{
  const d = curfewDecide({ ...base, now: T, list: fresh, lastOutboundAt: T - 60 * 60000, lastPokeAt: T - 60 * 60000 });
  ok(d.fire, "冷却都过了 → 照常戳");
}

// ---- 查岗提示语 ----
{
  const p = curfewPrompt({ bjNow: "03:20", app: "小红书", minutesAgo: 3 });
  ok(p.startsWith("【系统·查岗】"), "提示语带【系统·查岗】前缀");
  ok(p.includes("小红书") && p.includes("3 分钟前"), "提示语里有 App 和时间");
  ok(p.length > 8, "提示语远超重置词匹配窗口(不会被当成「归档/晚安」误触发)");
  eq(detectReset(p), null, "查岗提示语不会触发重置词(守护用例,别删)");
  ok(curfewPrompt({ bjNow: "03:20", app: "抖音", minutesAgo: 0 }).includes("刚刚"), "0 分钟说「刚刚」");
}

// ---- 他选择不打扰 ----
ok(isSilentReply("。"), "回句号 = 不说话");
ok(isSilentReply(" 。。 "), "多个句号也算");
ok(isSilentReply(""), "空回复算不说话");
ok(isSilentReply("【沉默】"), "沉默标记算不说话");
ok(!isSilentReply("这么晚还不睡?"), "真说了话就不算沉默");

// ---- 他自己发起的查岗:[查岗] 标记 ----
eq(takeCheckMarker("在忙吗"), { text: "在忙吗", wants: false }, "没写标记 = 不查");
eq(takeCheckMarker("[查岗]"), { text: "", wants: true }, "只写标记:正文空、要查");
eq(takeCheckMarker("【查岗】"), { text: "", wants: true }, "全角括号也认");
eq(takeCheckMarker("[ 查岗 ]"), { text: "", wants: true }, "带空格也认");
eq(takeCheckMarker("[查岗]这么久不理我"), { text: "这么久不理我", wants: true }, "标记被剥掉,正文照发");
eq(takeCheckMarker("想你了[查岗]"), { text: "想你了", wants: true }, "标记在句尾也剥干净");
ok(!takeCheckMarker("我去查岗了").wants, "光有「查岗」二字不带括号 → 不触发");
ok(!takeCheckMarker("[贴纸:查岗]").wants, "贴纸标记不会被误认成查岗");
{
  const r = takeCheckMarker("[查岗]\n\n\n在干嘛");
  eq(r.text, "在干嘛", "剥完不留多余空行");
}

// ---- 查岗结果喂回去的那一条 ----
{
  const now = 1000000000;
  const s = summarizeActivity([
    { app: "微信", at: now - 90 * 60000 },
    { app: "抖音", at: now - 40 * 60000 },
    { app: "小红书", at: now - 12 * 60000 },
  ], { now });
  const p = lookupPrompt(s, { bjNow: "15:30" });
  ok(p.startsWith("【系统·查岗】"), "结果带【系统·查岗】前缀");
  ok(p.includes("12 分钟前打开了小红书"), "最近一次说清楚");
  ok(p.includes("抖音(40 分钟前)"), "再往前的也带上");
  eq(detectReset(p), null, "查岗结果不会触发重置词(守护用例,别删)");
}
{
  const p = lookupPrompt({ count: 0 }, { bjNow: "15:30" });
  ok(p.includes("没有动静"), "没记录时明说没动静(别让他以为是查不到)");
  eq(detectReset(p), null, "空结果也不会触发重置词");
}
ok(lookupPrompt(summarizeActivity([{ app: "小红书", at: 1000 }], { now: 1000 }), { bjNow: "15:30" }).includes("刚刚"),
  "0 分钟说「刚刚」");

// ---- 网络错误三件套(2026-08-02:治「⚠️[bridge] fetch failed」)----
// 造几个和线上一模一样的错误对象:undici 的 fetch 失败永远是
// TypeError: fetch failed,真原因挂在 e.cause 上。
const undiciErr = (causeName, causeMsg, code) => {
  const e = new TypeError("fetch failed");
  const c = new Error(causeMsg);
  c.name = causeName; if (code) c.code = code;
  e.cause = c;
  return e;
};
{
  const e = undiciErr("SocketError", "other side closed", "UND_ERR_SOCKET");
  eq(describeErr(e), "TypeError: fetch failed ← SocketError: other side closed [UND_ERR_SOCKET]",
    "describeErr 把 cause 一起摊开(不写日志=下次还是查不出来)");
  eq(describeErr(null), "(无错误对象)", "describeErr 兜住空值");
  eq(describeErr(new Error("boom")), "boom", "普通 Error 就是原话");
  const plain = new Error("connect ECONNREFUSED 1.2.3.4:443"); plain.code = "ECONNREFUSED";
  eq(describeErr(plain), "connect ECONNREFUSED 1.2.3.4:443 [ECONNREFUSED]", "code 带出来");
  ok(!describeErr(e).includes("undefined"), "展开链里不许出现 undefined");
}
{
  // 可重试:连接层面就没成,请求几乎不可能已经被 Telegram 处理
  ok(isRetriableNetErr(undiciErr("SocketError", "other side closed", "UND_ERR_SOCKET")),
    "对端关了闲置连接 → 重试");
  ok(isRetriableNetErr(undiciErr("Error", "getaddrinfo EAI_AGAIN api.telegram.org", "EAI_AGAIN")),
    "DNS 抖 → 重试");
  ok(isRetriableNetErr(undiciErr("ConnectTimeoutError", "Connect Timeout Error", "UND_ERR_CONNECT_TIMEOUT")),
    "建连超时 → 重试");
  ok(isRetriableNetErr(new TypeError("fetch failed")),
    "**光秃秃的 fetch failed 也要重试**(线上犯的就是这个;只认已知 code 等于没修)");
  // 不重试:请求已经发出去了,对方可能已经办完,重发 = 同一句话说两遍
  ok(!isRetriableNetErr(undiciErr("HeadersTimeoutError", "Headers Timeout Error", "UND_ERR_HEADERS_TIMEOUT")),
    "headers 超时 → 不重试(可能已经发到了)");
  ok(!isRetriableNetErr(undiciErr("BodyTimeoutError", "Body Timeout Error", "UND_ERR_BODY_TIMEOUT")),
    "body 超时 → 不重试");
  const to = new Error("The operation was aborted due to timeout"); to.name = "TimeoutError";
  ok(!isRetriableNetErr(to), "我们自己掐的超时 → 不重试");
  ok(!isRetriableNetErr(new Error("shim HTTP 502")), "shim 的报错不归 tg 重试管");
  ok(!isRetriableNetErr(null) && !isRetriableNetErr("字符串"), "空值/字符串不炸");
}
{
  const shim = turnErrorText({ stage: "shim", err: new Error("shim HTTP 502") });
  ok(shim.includes("没接上他那边") && shim.includes("shim HTTP 502"), "shim 断了要让她知道该再说一次");
  ok(turnErrorText({ stage: "shim", err: new Error("shim turn timeout") }).includes("想太久"),
    "超时说人话");
  const send = turnErrorText({ stage: "send", lost: 3 });
  ok(send.includes("3 句") && send.includes("不是他没说"),
    "发送断了只报丢了几句,并且澄清不是他不理她");
  for (const s of [shim, send]) {
    ok(!/fetch failed/i.test(s), "**给她看的话里永远不许出现 fetch failed**(守护用例,别删)");
    ok(s.startsWith("⚠️[bridge]"), "仍然标明是桥在说话,不是晏在说话");
  }
}

console.log(fail ? `\n${fail}/${n} FAILED` : `${n} 项全绿 ✓`);
process.exit(fail ? 1 : 0);

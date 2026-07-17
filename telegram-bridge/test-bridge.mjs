// 纯逻辑测试:node test-bridge.mjs,不碰网络。部署前必须全绿。
import {
  splitForTelegram, detectReset, mergeTurn, buildShimBody,
  makeSseAccumulator, escapeHtml, isAllowedChat, mediaTypeOf,
  extractStickers, extractSegments, splitBubbles,
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

// ---- registry.json 完整性:每个标签的文件都真实存在 ----
{
  const reg = JSON.parse(fs.readFileSync("stickers/registry.json", "utf8"));
  const tags = Object.keys(reg);
  ok(tags.length === 26, `registry 26 个标签(实际 ${tags.length})`);
  const missing = tags.filter((t) => !fs.existsSync(`stickers/${reg[t]}`));
  eq(missing, [], "registry 指向的文件全存在");
  const dup = new Set(Object.values(reg));
  ok(dup.size === tags.length, "文件无重复引用");
}

console.log(fail ? `\n${fail}/${n} FAILED` : `${n} 项全绿 ✓`);
process.exit(fail ? 1 : 0);

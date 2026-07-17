// 纯逻辑测试:node test-bridge.mjs,不碰网络。部署前必须全绿。
import {
  splitForTelegram, detectReset, mergeTurn, buildShimBody,
  makeSseAccumulator, escapeHtml, isAllowedChat, mediaTypeOf,
} from "./bridge-lib.mjs";

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

console.log(fail ? `\n${fail}/${n} FAILED` : `${n} 项全绿 ✓`);
process.exit(fail ? 1 : 0);

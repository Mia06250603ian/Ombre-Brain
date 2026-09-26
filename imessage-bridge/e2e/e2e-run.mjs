// 端到端演练:真 server.js + 假 Photon + 假 shim + 假 ears + 假 ElevenLabs。**不碰线上,不需要任何钥匙。**
//   cd imessage-bridge && node e2e/e2e-run.mjs
// 验的是单测碰不到的那一截:Photon 消息进来 → 去抖 → 请求 shim 的样子 → 回话翻成 iMessage 动作。
import { register } from "node:module";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import ffmpeg from "ffmpeg-static";

register("./fake-hooks.mjs", import.meta.url);
const { push } = await import("./fake-spectrum.mjs");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`✗ ${name}\n   got  ${g}\n   want ${w}`); }
};
const ok = (name, c) => eq(name, !!c, true);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(30); } return false; }

// ---- 假 shim:记下每个请求,按剧本回 SSE ----
const shimReqs = [];
let shimReply = () => "嗯";
let shimStatus = 200;
const shim = http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d)).on("end", () => {
    const j = JSON.parse(body);
    shimReqs.push({ headers: req.headers, body: j });
    if (shimStatus !== 200) { res.writeHead(shimStatus).end(); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const text = shimReply(j);
    // 故意按 5 字节切块发,顺带验汉字不碎
    const sse = `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}\n\ndata: {"type":"message_stop"}\n\n`;
    const buf = Buffer.from(sse);
    for (let i = 0; i < buf.length; i += 5) res.write(buf.subarray(i, i + 5));
    res.end();
  });
});
// ---- 假 ears ----
const earsReqs = [];
const ears = http.createServer((req, res) => {
  const chunks = []; req.on("data", (d) => chunks.push(d)).on("end", () => {
    const b = Buffer.concat(chunks);
    earsReqs.push({ token: req.headers["x-token"], hasOgg: b.includes(Buffer.from("OggS")) });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text: "想你了", emotion: "温柔" }));
  });
});
await new Promise((r) => shim.listen(0, "127.0.0.1", r));
await new Promise((r) => ears.listen(0, "127.0.0.1", r));

// ---- 素材:一张 PNG、一段「iPhone 语音」(拿 wav 顶替 CAF,走的是同一条 ffmpeg 路)、一段 mp3 ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "imb-e2e-"));
const png = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#e88" } }).png().toBuffer();
execFileSync(ffmpeg, ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", path.join(tmp, "in.wav")]);
execFileSync(ffmpeg, ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=2", path.join(tmp, "tts.mp3")]);
const wav = fs.readFileSync(path.join(tmp, "in.wav"));
const mp3 = fs.readFileSync(path.join(tmp, "tts.mp3"));

// ---- 假 ElevenLabs:只拦 api.elevenlabs.io,别的照常走 ----
const ttsReqs = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith("https://api.elevenlabs.io/")) {
    ttsReqs.push(JSON.parse(opts.body));
    return new Response(mp3, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  }
  return realFetch(url, opts);
};

// ---- 起真 server.js ----
const PORT = 18000 + Math.floor(Math.random() * 1000);
Object.assign(process.env, {
  PORT: String(PORT), PHOTON_PROJECT_ID: "p", PHOTON_PROJECT_SECRET: "s",
  OWNER_HANDLES: "+8613800138000", SHIM_KEY: "k-test", SHIM_URL: `http://127.0.0.1:${shim.address().port}`,
  DEBOUNCE_MS: "300", EARS_URL: `http://127.0.0.1:${ears.address().port}`, EARS_TOKEN: "e-test",
  ELEVEN_API_KEY: "x", ELEVEN_VOICE_ID: "v",
});
await import("../server.js");
await until(() => globalThis.__photon?.opened > 0);

// ---- 假的会话与消息 ----
const sent = [];
const reacted = [];
const space = { id: "any;-;+8613800138000", send: async (x) => { sent.push(x); }, startTyping: async () => {}, stopTyping: async () => {} };
let n = 0;
function msg(content, { from = "+8613800138000", direction = "inbound" } = {}) {
  const m = { id: `m${++n}`, direction, platform: "imessage", sender: { id: from }, content, space,
    react: async (e) => { reacted.push({ id: m.id, e }); } };
  return m;
}
const say = (content, o) => { const m = msg(content, o); push([space, m]); return m; };
const texts = () => sent.filter((x) => typeof x === "string");
const reset = () => { sent.length = 0; reacted.length = 0; shimReqs.length = 0; };

// 场景 1:连发两句 → 合成一轮;回话里的标记全部变成动作,一个都不漏
shimReply = () => "[回应:❤️]\n嗯嗯\n[贴纸:贴贴]\n想你\n[查岗]";
say({ type: "text", text: "在吗" });
const last = say({ type: "text", text: "想你了" });
await until(() => texts().includes("想你"));
eq("1 合成一轮", shimReqs.length, 1);
eq("1 shim 收到合并后的话", shimReqs[0].body.messages[0].content, "在吗\n想你了");
eq("1 带 SHIM_KEY", shimReqs[0].headers["x-api-key"], "k-test");
ok("1 不带 system", !("system" in shimReqs[0].body));
ok("1 不报 model", !("model" in shimReqs[0].body));
ok("1 不带 x-system-turn(她本人说话)", !shimReqs[0].headers["x-system-turn"]);
eq("1 回应贴在最后一条上", reacted, [{ id: last.id, e: "❤️" }]);
eq("1 发出去的顺序", sent.map((x) => typeof x === "string" ? x : `${x.type}:${path.basename(String(x.input))}`),
  ["嗯嗯", "attachment:s04.webp", "想你"]);
ok("1 没有标记漏给她", !texts().some((t) => /[\[【]/.test(t)));

// 场景 2:陌生人 → 不理,shim 一次都不叫
reset();
say({ type: "text", text: "你好" }, { from: "+8613900139000" });
await sleep(800);
eq("2 陌生人不进 shim", shimReqs.length, 0);
eq("2 也不回陌生人", sent.length, 0);

// 场景 3:他自己发出去的回声 → 不理
say({ type: "text", text: "嗯嗯" }, { direction: "outbound" });
await sleep(800);
eq("3 回声不进 shim", shimReqs.length, 0);

// 场景 4:先说一句再说「归档」→ 两轮,归档单独成轮
reset();
shimReply = (j) => (j.messages[0].content === "归档" ? "📦 归档好了" : "好");
say({ type: "text", text: "今天好累" });
say({ type: "text", text: "归档" });
await until(() => texts().includes("📦 归档好了"));
eq("4 两轮、归档单独", shimReqs.map((r) => r.body.messages[0].content), ["今天好累", "归档"]);

// 场景 5:发图 → 变成 JPEG、长边压到 1568
reset();
shimReply = () => "好看";
say({ type: "attachment", mimeType: "image/png", name: "a.png", read: async () => png });
await until(() => texts().includes("好看"));
const blk = shimReqs[0]?.body.messages[0].content?.[1];
eq("5 图片块", blk && blk.source.media_type, "image/jpeg");
const meta = blk && await sharp(Buffer.from(blk.source.data, "base64")).metadata();
eq("5 压到 1568", meta && [meta.width, meta.height], [1568, 1045]);

// 场景 5b:iPhone 的 HEIC(1200 万像素样张,pillow-heif 造的)→ 子进程解码,主进程内存不涨
// (解码器是 WebAssembly、内存只涨不缩,放主进程会永久多占约 200 MiB,见 image-worker.mjs 头注)
reset();
shimReply = () => "拍得好";
const rssBefore = process.memoryUsage.rss();
say({ type: "attachment", mimeType: "image/heic", name: "IMG_0001.HEIC", read: async () => fs.readFileSync(new URL("./sample-12mp.heic", import.meta.url)) });
await until(() => texts().includes("拍得好"), 20000);
const hb = shimReqs[0]?.body.messages[0].content?.[1];
const hm = hb && await sharp(Buffer.from(hb.source.data, "base64")).metadata();
eq("5b HEIC 解成 JPEG 并压到 1568", hm && [hm.format, hm.width, hm.height], ["jpeg", 1568, 1176]);
const grew = (process.memoryUsage.rss() - rssBefore) / 1048576;
console.log(`   (5b 解一张 12MP HEIC 前后,主进程 RSS 变化 ${grew.toFixed(1)} MiB)`);
ok(`5b 主进程内存没被 HEIC 撑大(涨了 ${grew.toFixed(0)} MiB,门槛 60)`, grew < 60);

// 场景 6:语音 → 转 Ogg 送 ears → 带注解的一句进晏窗口
reset();
shimReply = () => "我也想你";
say({ type: "voice", mimeType: "audio/x-caf", name: "Audio.caf", read: async () => wav });
await until(() => texts().includes("我也想你"), 15000);
eq("6 ears 收到的是 Ogg", earsReqs.at(-1), { token: "e-test", hasOgg: true });
eq("6 进晏窗口的那句", shimReqs[0]?.body.messages[0].content, "[语音] 想你了（语气：温柔）");

// 场景 7:他发语音 → ElevenLabs → m4a 语音
reset();
shimReply = () => "[语音]Good night, love.[/语音]";
say({ type: "text", text: "说句晚安给我听" });
await until(() => sent.some((x) => x.type === "voice"), 15000);
eq("7 TTS 收到英文原句", ttsReqs.at(-1)?.text, "Good night, love.");
const v = sent.find((x) => x.type === "voice");
eq("7 发出去的是 m4a", v && [v.mimeType, v.name], ["audio/x-m4a", "voice.m4a"]);
ok("7 带时长(约 2 秒)", v && v.duration > 1.5 && v.duration < 2.5);

// 场景 8:她点了个回应 → 告诉他,但他的回应不会贴到她的回应上
reset();
shimReply = () => "[回应:😂]嘿嘿";
say({ type: "reaction", emoji: "❤️", target: { content: { type: "text", text: "想你" } } });
await until(() => texts().includes("嘿嘿"));
eq("8 他知道她点了什么", shimReqs[0]?.body.messages[0].content, "(她给你的「想你」点了 ❤️)");
eq("8 没有靶子就不贴", reacted, []);

// 场景 9:发 PDF → 直接告诉她传不过去,不进 shim
reset();
say({ type: "attachment", mimeType: "application/pdf", name: "a.pdf", read: async () => Buffer.alloc(1) });
await until(() => sent.length > 0);
eq("9 PDF 不进 shim", shimReqs.length, 0);
ok("9 告诉她传不过去", texts()[0]?.includes("传不过去"));

// 场景 10:shim 挂了 → 告诉她没接上,而且之后还能接着聊(队列没卡死)
reset();
shimStatus = 502;
say({ type: "text", text: "喂" });
await until(() => texts().some((t) => t.includes("没接上")));
ok("10 告诉她没接上", texts().some((t) => t.includes("shim HTTP 502")));
shimStatus = 200; shimReply = () => "我在";
say({ type: "text", text: "还在吗" });
await until(() => texts().includes("我在"));
ok("10 挂过一次之后照样能聊", texts().includes("我在"));

// 场景 11:同一条消息重投(Photon 断线重连)→ 只处理一次
reset();
shimReply = () => "收到";
const dup = msg({ type: "text", text: "重投测试" });
push([space, dup]); push([space, dup]);
await until(() => texts().includes("收到"));
await sleep(600);
eq("11 重投只进一次 shim", shimReqs.length, 1);

// 场景 12:/health
const h = await (await realFetch(`http://127.0.0.1:${PORT}/health`)).json();
eq("12 health", [h.ok, h.on, h.connected, h.owner, h.stickers, h.ffmpeg, h.ears, h.voice], [true, true, true, 1, 59, true, true, true]);
ok("12 health 里没有内容和钥匙", !JSON.stringify(h).includes("k-test") && !JSON.stringify(h).includes("想你"));
ok("12 health 有内存读数", typeof h.mem.self === "number");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n演练 ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

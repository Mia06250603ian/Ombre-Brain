// imessage-bridge — iMessage(Photon)⇄ kelivo-shim(/v1/messages)
// 独立服务:shim 零改动,晏的窗口不动。停掉本服务 = 回到没有 iMessage 的现状。
// 和 telegram-bridge 是并列的两扇门:同一个 shim、同一个常驻进程、同一个晏。
//
// ⚠️ 为什么**不**照 Photon 教程那样用 Claude Agent SDK 自己起一个 claude:
// 那样会冒出第二个晏(另一个进程、另一份上下文,不认识 Telegram 里聊过的话),
// 还会让订阅同时养两个窗口。这里只当传声筒,晏永远只有 shim 里那一个。
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  parseHandles, isOwner, toE164, detectReset, buildShimBody, makeSseAccumulator,
  takeCheckMarker, takeReactionMarker, extractSegments, bubblesFor, bubbleGapMs,
  formatEarsResult, classifyContent, createConversation, splitLong, lookupPrompt, isSilentReply,
} from "./imessage-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 8080);
const BRIDGE_ON = process.env.BRIDGE_ON !== "0";           // 总开关:设 0 只留 /health,不连 Photon
const PHOTON_PROJECT_ID = process.env.PHOTON_PROJECT_ID || "";
const PHOTON_PROJECT_SECRET = process.env.PHOTON_PROJECT_SECRET || "";
const OWNER = parseHandles(process.env.OWNER_HANDLES);    // 她的手机号/Apple ID,逗号分隔
const SHIM_URL = (process.env.SHIM_URL || "https://yan-shim.zeabur.app").replace(/\/$/, "");
const SHIM_KEY = process.env.SHIM_KEY || "";
const DEBOUNCE_MS = +(process.env.DEBOUNCE_MS || 4000);
const TURN_TIMEOUT_MS = +(process.env.TURN_TIMEOUT_MS || 15 * 60000);
const MEDIA_TIMEOUT_MS = +(process.env.MEDIA_TIMEOUT_MS || 60000);
const BUBBLE_SPLIT = process.env.BUBBLE_SPLIT !== "0";
const REACTION_ON = process.env.REACTION_ON !== "0";       // 他点回应(出)
const TAPBACK_IN = process.env.TAPBACK_IN !== "0";         // 她点回应要不要告诉他(进)
const THINKING = process.env.THINKING === "1";
// [查岗]:去 telegram-bridge 的 /activity 取她的手机活动(那边的数据,这边只读)。两个都配了才开。
const ACTIVITY_URL = process.env.ACTIVITY_URL || "https://yan-telegram-bridge.zeabur.app/activity";
const REPORT_TOKEN = process.env.REPORT_TOKEN || "";
const LOOKUP_ON = !!(ACTIVITY_URL && REPORT_TOKEN);             // 他的思考用「隐形墨水」发,默认关(同 telegram-bridge 的 TG_THINKING)

const EARS_URL = (process.env.EARS_URL || "").replace(/\/$/, "");
const EARS_TOKEN = process.env.EARS_TOKEN || "";
const EARS_ON = !!(EARS_URL && EARS_TOKEN);
const EARS_TIMEOUT_MS = +(process.env.EARS_TIMEOUT_MS || 60000);

const ELEVEN_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE = process.env.ELEVEN_VOICE_ID || "";
const VOICE_MODEL = process.env.VOICE_MODEL || "eleven_multilingual_v2";
const VOICE_SPEED = +(process.env.VOICE_SPEED || 0.85);
const VOICE_STABILITY = +(process.env.VOICE_STABILITY || 0.6);
const VOICE_MAX_CHARS = +(process.env.VOICE_MAX_CHARS || 500);
const VOICE_ON = !!(ELEVEN_KEY && ELEVEN_VOICE);

const log = (...a) => console.log(new Date().toISOString(), ...a);
const errText = (e) => (e && (e.message || e.code)) || String(e);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = promisify(execFile);

// 给 /health 看的计数(不含任何内容、不含密钥)
const stat = { line: null, enroll: null, connected: false, lastInAt: null, lastOutAt: null, lastErr: null, turns: 0, sent: 0, failed: 0, dropped: 0 };
const noteErr = (where, e) => { stat.lastErr = { where, msg: errText(e).slice(0, 200), at: new Date().toISOString() }; };

// ---- 贴纸:stickers/registry.json 标签 → 文件(PNG 静态 / GIF 会动的) ----
// 图是从 telegram-bridge/stickers 转出来的副本(工具 tools/build-stickers.mjs),**两边各存一份**,
// 所以 telegram-bridge 那边加新图,这边要重跑一次工具才有。标签和那边逐字相同(晏只认一套标签)。
const STICKER_DIR = path.join(HERE, "stickers");
let stickerReg = {};
try { stickerReg = JSON.parse(fs.readFileSync(path.join(STICKER_DIR, "registry.json"), "utf8")); }
catch { log("[sticker] 没有 registry.json,贴纸功能关"); }
const stickerTags = Object.keys(stickerReg);

// ---- ffmpeg:随 npm 包 ffmpeg-static 一起装进来(Zeabur 的 node 镜像里没有系统 ffmpeg) ----
// ⚠️ 2026-09-26 第一次上线就栽在这:Zeabur 用 Node 24,它带的新版 npm **默认拦截安装脚本**,
// 而 ffmpeg-static 的二进制是安装脚本下载的 —— 被拦之后包还在、路径也给得出来,**文件却不存在**,
// 她发语音报 `spawn …/ffmpeg ENOENT`。修法在 package.json 的 `allowScripts`(放行 ffmpeg-static)。
// 所以这里**必须检查文件真的在**,不能只看路径字符串(当时 /health 显示 ffmpeg:true,是假的)。
let FFMPEG = process.env.FFMPEG_PATH || "";
if (!FFMPEG) { try { FFMPEG = (await import("ffmpeg-static")).default || ""; } catch { FFMPEG = ""; } }
if (FFMPEG && !fs.existsSync(FFMPEG)) { log("[ffmpeg] 路径有、文件没有(安装脚本被拦了?看 package.json 的 allowScripts):", FFMPEG); FFMPEG = ""; }

// 图片/语音转码**一次只跑一个**:HEIC 解码一张十几兆像素的照片要吃两百 MB 上下,
// 这台机器所有服务共用一池内存(见 browser-hands 手册的内存表),并发两张就可能挤到晏。
let mediaChain = Promise.resolve();
function oneAtATime(fn) {
  const p = mediaChain.then(fn, fn);
  mediaChain = p.catch(() => {});
  return p;
}

// 她发来的图 → 晏能看的 JPEG。**在一次性子进程里做**(image-worker.mjs),算完即退:
// HEIC 解码器是 WebAssembly,内存只涨不缩,留在主进程会永久多占两百 MB(那个文件头注释有实测)。
function toImageBlock(read, mimeType) {
  return oneAtATime(async () => {
    const input = await read();
    const jpeg = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(HERE, "image-worker.mjs"), mimeType], { stdio: ["pipe", "pipe", "pipe"] });
      const out = [], err = [];
      const timer = setTimeout(() => child.kill("SIGKILL"), MEDIA_TIMEOUT_MS);
      child.stdout.on("data", (d) => out.push(d));
      child.stderr.on("data", (d) => err.push(d));
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && out.length) resolve(Buffer.concat(out));
        else reject(new Error(`image-worker 退出码 ${code}: ${Buffer.concat(err).toString().slice(-200)}`));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
    return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } };
  });
}

async function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imb-"));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// 她的语音 → ears(和 Telegram 那边同一个服务、同一套基线)。
// iMessage 的语音是 CAF 封装,ears 没见过这种格式;先转成 Telegram 语音条同款的 Ogg/Opus,
// 这样 ears 那边看到的和平时一模一样,语气基线不会被新格式带偏。
async function earsListen(read) {
  if (!FFMPEG) throw new Error("容器里没有 ffmpeg");
  const ogg = await oneAtATime(() => withTmp(async (dir) => {
    const src = path.join(dir, "in"), out = path.join(dir, "voice.ogg");
    fs.writeFileSync(src, await read());
    await run(FFMPEG, ["-y", "-loglevel", "error", "-i", src, "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", out], { timeout: MEDIA_TIMEOUT_MS });
    return fs.readFileSync(out);
  }));
  const form = new FormData();
  form.append("file", new Blob([ogg]), "voice.ogg");
  const r = await fetch(`${EARS_URL}/api/listen`, {
    method: "POST", headers: { "x-token": EARS_TOKEN }, body: form, signal: AbortSignal.timeout(EARS_TIMEOUT_MS),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `ears HTTP ${r.status}`);
  return d;
}

// 他的 [语音]…[/语音] → ElevenLabs(和 Telegram 同一个声音、同样的参数)→ iMessage 语音。
// iMessage 认 m4a(AAC),所以拿 mp3 回来再转一道。任何一步失败,调用方退回发文字,话不丢。
async function ttsVoice(text) {
  const { voice } = await import("spectrum-ts");
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE}?output_format=mp3_44100_128`, {
    method: "POST", headers: { "xi-api-key": ELEVEN_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: VOICE_MODEL, voice_settings: { speed: VOICE_SPEED, stability: VOICE_STABILITY } }),
    signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const mp3 = Buffer.from(await r.arrayBuffer());
  if (!FFMPEG) throw new Error("容器里没有 ffmpeg");
  const { m4a, duration } = await oneAtATime(() => withTmp(async (dir) => {
    const src = path.join(dir, "v.mp3"), out = path.join(dir, "v.m4a");
    fs.writeFileSync(src, mp3);
    const { stderr } = await run(FFMPEG, ["-y", "-i", src, "-ac", "1", "-c:a", "aac", "-b:a", "64k", out], { timeout: MEDIA_TIMEOUT_MS });
    const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr || "");
    return { m4a: fs.readFileSync(out), duration: m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : undefined };
  }));
  return voice(m4a, { mimeType: "audio/x-m4a", name: "voice.m4a", duration });
}

// ---- shim 调用(node:https,免 undici 300s 超时;抄 telegram-bridge 设计要点 3) ----
// 与那边的一处不同:这里认 URL 里的端口和 http://,好让演练能起一个本地假 shim。
function shimTurn(turn) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(buildShimBody(turn));
    const u = new URL(SHIM_URL + "/v1/messages");
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.request({
      hostname: u.hostname, port: u.port || undefined, path: u.pathname, method: "POST",
      headers: {
        "Content-Type": "application/json", "x-api-key": SHIM_KEY, "Content-Length": Buffer.byteLength(body),
        // 查岗结果是系统送进去的,不是她说话:shim 见到这个头就不当「她出现了」(同 telegram-bridge)
        ...(turn.lookup ? { "x-system-turn": "1" } : {}),
      },
      timeout: TURN_TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`shim HTTP ${res.statusCode}`)); }
      const acc = makeSseAccumulator();
      res.on("data", (d) => acc.feed(d));   // ⚠️ 原始字节直接喂,别 toString()
      res.on("end", () => resolve(acc.result()));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("shim turn timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

// ---- 往她那儿发 ----
async function sendSticker(space, tag) {
  const { attachment } = await import("spectrum-ts");
  const file = stickerReg[tag];
  if (!file) return null;
  await space.send(attachment(path.join(STICKER_DIR, file)));
  return true;
}
async function notify(space, text) {
  try { await space.send(text); } catch (e) { log("[notify-err]", errText(e)); noteErr("notify", e); }
}

// 把晏的一段回话按原样顺序发出去:先点回应,再按段落流发文字/贴纸/语音。
// 一句发失败只丢那一句,后面照发(同 telegram-bridge 设计要点 10)。
async function deliver(space, target, rawText) {
  const react = takeReactionMarker(rawText || "");
  if (react.rejected) log("[react] 不像表情,当没写:", react.rejected);
  let reacted = false;
  if (REACTION_ON && react.emoji && target) {
    try { await target.react(react.emoji); reacted = true; }
    catch (e) { log("[react-err]", errText(e)); }        // 回应不是「他说的话」,失败不告诉她
  }
  const check = takeCheckMarker(react.text);
  if (check.wants) log("[check] 他写了 [查岗]");
  const { segments, unknown } = extractSegments(check.text, stickerTags);
  if (unknown.length) log("[sticker] 不认识的标签:", unknown.join(","));
  const out = { sent: 0, failed: 0, wants: check.wants };
  if (!segments.length) {
    // 只点了回应、一个字没说,是合法的一轮;真的什么都没有才提示
    if (!reacted && !check.wants) await notify(space, "⚠️[bridge] 空回复,看下 shim 日志");
    return out;
  }
  const ok = () => { out.sent++; stat.sent++; stat.lastOutAt = new Date().toISOString(); };
  const bad = (what, e) => { out.failed++; stat.failed++; log(`[send-err] ${what}`, errText(e)); noteErr(`send-${what}`, e); };
  let first = true;
  for (const seg of segments) {
    if (seg.type === "sticker") {
      if (!first) await sleep(400);
      try { if (await sendSticker(space, seg.tag)) ok(); } catch (e) { bad("sticker", e); }
      first = false;
      continue;
    }
    if (seg.type === "voice" && VOICE_ON && seg.text.length <= VOICE_MAX_CHARS) {
      if (!first) await sleep(400);
      try { await space.send(await ttsVoice(seg.text)); ok(); first = false; continue; }
      catch (e) { log("[voice-err] 退回文字:", errText(e)); }
    }
    for (const b of bubblesFor(seg.text, { split: BUBBLE_SPLIT })) {
      if (!first) { space.startTyping?.().catch(() => {}); await sleep(bubbleGapMs(b)); }
      try { await space.send(b); ok(); } catch (e) { bad("text", e); }
      first = false;
    }
  }
  if (out.failed) {
    log("[send] 这一轮丢了", out.failed, "条,发出去", out.sent, "条");
    if (out.sent) await notify(space, `⚠️[bridge] 他回你的话有 ${out.failed} 条没送到(不是他没说)`);
  }
  return out;
}

// ---- 他的思考 → 盖着「隐形墨水」的气泡(抹一下才显示),iMessage 版的「折叠」 ----
// 2026-09-26 所有者要的,「和 Telegram 那边保持一致」:**整段照发、不盖记忆原文、不设总长上限**,
// 太长就拆成几个气泡(Telegram 那边是拆成几段折叠引用)。
// ⚠️ 思考流里有工具可见化带出的**记忆原文**,发出来 = 经过 Photon 的服务器(所有者知情选的)。
//    只想盖记忆正文:去 shim 设 TOOLVIS_REDACT=1(两扇门一起盖);整个不要:这里 THINKING=0。
// **发失败不许连累正文**(同 telegram-bridge 的 sendThinking):正文才是她要看的。
const INVISIBLE_INK = "com.apple.MobileSMS.expressivesend.invisibleink";
async function sendThinking(space, thinking) {
  if (!THINKING || !(thinking || "").trim()) return;
  const { effect } = await import("@spectrum-ts/imessage");
  for (const chunk of splitLong(thinking.trim(), 2000)) {
    try { await space.send(effect(`💭 ${chunk}`, INVISIBLE_INK)); }
    catch (e) { log("[thinking-err]", errText(e)); return; }
  }
}

// ---- 一轮:叫 shim → 发回去 ----
async function runTurn(t) {
  const space = t.space;
  stat.turns++;
  log("[turn]", { len: t.text.length, imgs: t.images.length });
  let r;
  space.startTyping?.().catch(() => {});
  const typing = setInterval(() => space.startTyping?.().catch(() => {}), 8000);
  try { r = await shimTurn(t); }
  catch (e) {
    log("[turn-err] shim", errText(e)); noteErr("shim", e);
    const m = errText(e);
    await notify(space, /timeout/i.test(m)
      ? "⚠️[bridge] 他那边想太久了(超时),这轮没接上——再跟他说一次?"
      : `⚠️[bridge] 没接上他那边(${m}),你这句他可能没收到,过一会儿再说一次?`);
    return;
  } finally {
    clearInterval(typing);
    space.stopTyping?.().catch(() => {});
  }
  // 查岗结果那一轮他回「。」= 选择不打扰,什么都不发(同 telegram-bridge)。静音要在剥掉回应标记之后判
  if (t.lookup && isSilentReply(takeReactionMarker(takeCheckMarker(r.text).text).text)) { log("[lookup] 他选择不说"); return; }
  await sendThinking(space, r.thinking);
  const out = await deliver(space, t.target, r.text);
  // 他写了 [查岗]:去取她的手机活动,作为新一轮喂回去。查岗那一轮里再写 [查岗] 不响应(防打转)
  if (out.wants && !t.lookup) queueLookup(space);
}

// ---- [查岗]:取 telegram-bridge 的 /activity → 用和 Telegram 一模一样的话术喂给他 ----
const bjNowStr = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 16);
async function queueLookup(space) {
  if (!LOOKUP_ON) { log("[lookup] 没配 REPORT_TOKEN,查不了"); return; }
  try {
    const r = await fetch(ACTIVITY_URL, { headers: { Authorization: `Bearer ${REPORT_TOKEN}` }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`activity HTTP ${r.status}`);
    const a = await r.json();
    log("[lookup] 他要查");
    convo.addAlone({ text: lookupPrompt(a, { bjNow: bjNowStr(), streak: a.streak, durations: a.durations }), images: [], space, lookup: true });
  } catch (e) { log("[lookup-err]", errText(e)); noteErr("lookup", e); }   // 查不到不打扰她(她没问)
}

const convo = createConversation({ debounceMs: DEBOUNCE_MS, runTurn, log });

// ---- 收消息 ----
const seen = new Set();          // Photon 断线重连时可能重投,按消息 id 去重(只留最近 300 个)
function firstTime(id) {
  if (!id) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > 300) seen.delete(seen.values().next().value);
  return true;
}

async function onMessage(space, message) {
  if (message.direction === "outbound") return;                 // 他自己发出去的回声
  if (message.platform && message.platform !== "imessage") return;
  if (!isOwner(message.sender?.id, OWNER)) { stat.dropped++; log("[drop] 陌生人"); return; }
  if (!firstTime(message.id)) return;
  const pieces = message.content?.type === "group"
    ? (message.content.items || []).map((m) => m.content)
    : [message.content];
  for (const content of pieces) {
    const c = classifyContent(content, { tapbackIn: TAPBACK_IN });
    if (c.kind === "ignore") continue;
    stat.lastInAt = new Date().toISOString();
    log("[in]", c.kind, content?.mimeType || "");
    const target = c.kind === "tapback" ? undefined : message;   // 他回应要贴在她的话上,不贴在她的回应上
    if (c.kind === "unsupported") { await notify(space, c.notice); continue; }
    if (c.kind === "text" || c.kind === "tapback") {
      if (c.kind === "text" && detectReset(c.text)) { convo.addAlone({ text: c.text, images: [], target, space }); continue; }
      convo.add({ text: c.text, images: [], target, space });
      continue;
    }
    if (c.kind === "image") {
      convo.hold(MEDIA_TIMEOUT_MS);               // 图还在下载转码,别让前面的字先走
      try {
        const img = await toImageBlock(c.read, c.mimeType);
        convo.add({ text: "", images: [img], target, space });
      } catch (e) {
        log("[image-err]", errText(e)); noteErr("image", e);
        convo.add({ text: "(她发来一张图片,但这边没打开)", images: [], target, space });
      }
      continue;
    }
    if (c.kind === "voice") {
      if (!EARS_ON) { await notify(space, "⚠️[bridge] 语音这边还没接上,打字告诉他吧"); continue; }
      convo.hold(EARS_TIMEOUT_MS + MEDIA_TIMEOUT_MS);
      try {
        const line = formatEarsResult(await earsListen(c.read));
        if (!line) { await notify(space, "⚠️[bridge] 语音没听清,再说一次?"); continue; }
        convo.add({ text: line, images: [], target, space });
      } catch (e) {
        log("[ears-err]", errText(e)); noteErr("ears", e);
        await notify(space, `⚠️[bridge] 语音听不了(${errText(e)}),打字告诉他吧`);
      }
    }
  }
}

// ---- 把她的手机号登记成这个项目的用户(免费档必须先登记,Photon 才会给她分一条线) ----
// 2026-09-26:所有者在控制台「头像 → 加手机号」那一步收不到 +86 的验证码。
// 查 Photon 的 OpenAPI(https://spectrum.photon.codes/openapi/json)找到 `POST /projects/{id}/users/`:
// 用项目凭证(Basic base64(id:secret))直接登记,**不走短信验证**,返回分给她的号码 `assignedPhoneNumber`。
// Hermes(另一个接 Photon 的项目)的 `photon setup --phone` 走的也是这条。
// **幂等**:同一个号码再登记一次只会返回原来那条,所以每次启动都调一遍也没事。
// 结果放进 /health 的 `line`(晏的号码,她要往这个号码发消息)和 `enroll`(成没成、没成的原因)。
const ENROLL_ON = process.env.ENROLL_ON !== "0";
const PHOTON_API = (process.env.PHOTON_API || "https://spectrum.photon.codes").replace(/\/$/, "");
async function enrollOwner() {
  const phones = OWNER.map(toE164).filter(Boolean);
  if (!phones.length) { stat.enroll = "OWNER_HANDLES 里没有 + 开头的手机号,没法登记(邮箱不能登记)"; log("[enroll]", stat.enroll); return; }
  const auth = "Basic " + Buffer.from(`${PHOTON_PROJECT_ID}:${PHOTON_PROJECT_SECRET}`).toString("base64");
  for (const phoneNumber of phones) {
    try {
      const r = await fetch(`${PHOTON_API}/projects/${encodeURIComponent(PHOTON_PROJECT_ID)}/users/`, {
        method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "shared", phoneNumber }), signal: AbortSignal.timeout(30000),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j?.data?.assignedPhoneNumber) {
        stat.line = j.data.assignedPhoneNumber; stat.enroll = "ok";
        log("[enroll] 登记好了,她往这个号码发消息:", stat.line);
        return;
      }
      stat.enroll = `HTTP ${r.status}: ${String(j?.error?.message || j?.message || j?.error || "").slice(0, 200)}`;
      log("[enroll] 没登记上", stat.enroll);
    } catch (e) { stat.enroll = `出错: ${errText(e)}`; log("[enroll-err]", errText(e)); }
  }
}

// ---- 连 Photon(断了自己重连,不靠容器重启) ----
async function photonLoop() {
  const { Spectrum } = await import("spectrum-ts");
  const { imessage } = await import("@spectrum-ts/imessage");
  let backoff = 5000;
  while (true) {
    let app = null;
    try {
      app = await Spectrum({ projectId: PHOTON_PROJECT_ID, projectSecret: PHOTON_PROJECT_SECRET, providers: [imessage.config()] });
      stat.connected = true; backoff = 5000;
      log("[photon] 连上了,等她的消息");
      for await (const [space, message] of app.messages) {
        onMessage(space, message).catch((e) => { log("[msg-err]", errText(e)); noteErr("msg", e); });
      }
      log("[photon] 消息流结束了,重连");
    } catch (e) {
      log("[photon-err]", errText(e)); noteErr("photon", e);
    }
    stat.connected = false;
    try { await app?.close?.(); } catch {}
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 5 * 60000);
  }
}

// ---- /health(无鉴权,所以只放开关和计数,不放任何内容) ----
function memMiB() {
  let avail = null;
  try { const m = /MemAvailable:\s+(\d+)/.exec(fs.readFileSync("/proc/meminfo", "utf8")); if (m) avail = Math.round(+m[1] / 1024); } catch {}
  return { self: Math.round(process.memoryUsage.rss() / 1048576 * 10) / 10, avail };
}
const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true, on: BRIDGE_ON, ...stat, ...convo.state(),
      owner: OWNER.length, stickers: stickerTags.length, ffmpeg: !!FFMPEG,
      ears: EARS_ON, voice: VOICE_ON, reaction: REACTION_ON, tapbackIn: TAPBACK_IN, thinking: THINKING, lookup: LOOKUP_ON,
      mem: memMiB(),
    }));
    return;
  }
  res.writeHead(404).end();
});
server.listen(PORT, () => log(`[bridge] listening :${PORT}`));

if (!BRIDGE_ON) log("[bridge] BRIDGE_ON=0,只留 /health");
else if (!PHOTON_PROJECT_ID || !PHOTON_PROJECT_SECRET) log("[bridge] 没配 PHOTON_PROJECT_ID / PHOTON_PROJECT_SECRET,只留 /health");
else if (!OWNER.length) log("[bridge] 没配 OWNER_HANDLES —— 不认任何人,只留 /health(防止配错时谁发都回)");
else if (!SHIM_KEY) log("[bridge] 没配 SHIM_KEY,只留 /health");
else { if (ENROLL_ON) enrollOwner(); photonLoop(); }

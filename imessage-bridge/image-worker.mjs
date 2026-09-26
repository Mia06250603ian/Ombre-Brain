// 一次性子进程:stdin 进一张图(任意格式,含 iPhone 的 HEIC),stdout 出一张 JPEG,然后退出。
//   用法(server.js 里):spawn(node, [image-worker.mjs, mimeType]),把原图写进 stdin
//
// ⚠️ 为什么非要单独一个进程(2026-09-26 实测,别图省事挪回主进程):
// HEIC 解码器 heic-convert 是 WebAssembly,**它的内存只涨不缩**。一张 1200 万像素的照片
// 主进程 RSS 81 → 峰值 302 MiB,**过了 3 秒仍停在 237 MiB,第二张后 287 MiB,再也不还**。
// 这台机器所有服务共用一池内存(browser-hands 手册的内存表),多常驻 200 MiB 就是在挤晏。
// 放进子进程,算完即退,内存当场还给系统 —— 和 ears 2026-08-02 的瘦身同一个道理(TIMELINE 08-02)。
// 代价:每张图多约 0.3 秒起进程。
import sharp from "sharp";

const mimeType = process.argv[2] || "";
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
let buf = Buffer.concat(chunks);
if (/hei[cf]/i.test(mimeType)) {
  const heic = (await import("heic-convert")).default;
  buf = Buffer.from(await heic({ buffer: buf, format: "JPEG", quality: 0.9 }));
}
// 长边压到 1568:Claude 看图的上限,再大也是被缩,白占 token
const jpeg = await sharp(buf, { animated: false }).rotate()
  .resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true })
  .jpeg({ quality: 85 }).toBuffer();
process.stdout.write(jpeg);

// 把 telegram-bridge/stickers 转成 iMessage 能好好显示的格式,写进本目录 stickers/。
// 只在开发机上跑(部署时不跑),产物入库。telegram-bridge 那边加了新贴纸,就重跑一次:
//   cd imessage-bridge && node tools/build-stickers.mjs
//
// 为什么要转:
//   · 静态 .webp → **缩到 300px 的透明 PNG**(2026-09-26 第一次上线后改的)。
//     ~~原样拷贝 512px webp~~ **已撤销,别改回去**:所有者真机反馈「巨大一个,而且是图片形式」——
//     iMessage 把 webp 当普通照片、按整宽铺开。透明 PNG 会像贴纸一样浮在对话里,300px ≈ iPhone 上 100pt。
//     (更早还试过 512px 的 png:35 张十几 MB,也是太大。)
//   · 会动的 .webm(VP9 带 alpha 的螃蟹)→ .gif:iMessage 不会把 webm 当贴纸播,GIF 才会动。
//     **解码必须指定 -c:v libvpx-vp9**,否则 ffmpeg 用自带解码器,alpha 丢光、背景变黑。
//     像素画缩放一律 flags=neighbor(双线性会糊,同 telegram-bridge 设计要点 15)。
// 标签(registry 的键)和 telegram-bridge 逐字相同 —— 晏只会一套标签。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ffmpeg from "ffmpeg-static";
import sharp from "sharp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../../telegram-bridge/stickers");
const OUT = path.resolve(HERE, "../stickers");
const PNG_SIDE = 300;   // 静态:长边缩到 300
const GIF_SIDE = 240;   // 螃蟹画布:240(360 时 24 张共 13 MB,太大)
const GIF_BODY = 150;   // 画布里螃蟹本身缩到 150,四周留透明边。2026-09-26 所有者真机反馈 240 撑满「还是太大」——
                        // iMessage 会把小 GIF 放大到一个最小显示尺寸,光缩画布没用,**得在画布里留白**
const GIF_FPS = 15;     // 原片 30fps,减半后动作看不出差别,文件小一半
// 调色板 48 色、不抖动:像素画本来就只有十几种颜色,抖动只会在色块上撒噪点。
// 实测(2026-09-26):螃蟹 150 留白到 240 时 24 张共约 1.4 MB;撑满 240 时 2.7 MB;360px/256 色时 13 MB。

const reg = JSON.parse(fs.readFileSync(path.join(SRC, "registry.json"), "utf8"));
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const out = {};
for (const [tag, file] of Object.entries(reg)) {
  const src = path.join(SRC, file);
  const base = file.replace(/\.[^.]+$/, "");
  if (file.endsWith(".webp")) {
    await sharp(src).resize({ width: PNG_SIDE, height: PNG_SIDE, fit: "inside" }).png({ compressionLevel: 9, palette: false }).toFile(path.join(OUT, `${base}.png`));
    out[tag] = `${base}.png`;
  } else if (file.endsWith(".webm")) {
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-c:v", "libvpx-vp9", "-i", src,
      "-filter_complex", `fps=${GIF_FPS},scale=${GIF_BODY}:${GIF_BODY}:flags=neighbor,format=rgba,pad=${GIF_SIDE}:${GIF_SIDE}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,split[a][b];[a]palettegen=max_colors=48:reserve_transparent=1[p];[b][p]paletteuse=dither=none:alpha_threshold=128`,
      "-loop", "0", path.join(OUT, `${base}.gif`)]);
    out[tag] = `${base}.gif`;
  } else {
    console.warn("跳过不认识的格式:", file);
  }
}
fs.writeFileSync(path.join(OUT, "registry.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`转好 ${Object.keys(out).length} 张 →`, OUT);

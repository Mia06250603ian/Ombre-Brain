// 把 telegram-bridge/stickers 转成 iMessage 能好好显示的格式,写进本目录 stickers/。
// 只在开发机上跑(部署时不跑),产物入库。telegram-bridge 那边加了新贴纸,就重跑一次:
//   cd imessage-bridge && node tools/build-stickers.mjs
//
// 为什么要转:
//   · 静态 .webp **原样拷贝**:iPhone 自 iOS 14 起直接显示 webp(透明照留)。
//     试过转 png:35 张从 0.6 MB 涨到十几 MB(有损 webp 解成无损 png),不值。
//   · 会动的 .webm(VP9 带 alpha 的螃蟹)→ .gif:iMessage 不会把 webm 当贴纸播,GIF 才会动。
//     **解码必须指定 -c:v libvpx-vp9**,否则 ffmpeg 用自带解码器,alpha 丢光、背景变黑。
//     像素画缩放一律 flags=neighbor(双线性会糊,同 telegram-bridge 设计要点 15)。
// 标签(registry 的键)和 telegram-bridge 逐字相同 —— 晏只会一套标签。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ffmpeg from "ffmpeg-static";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../../telegram-bridge/stickers");
const OUT = path.resolve(HERE, "../stickers");
const GIF_SIDE = 240;   // 螃蟹:原图 512,缩到 240(iPhone 上约 80pt;360 时 24 张共 13 MB,太大)
const GIF_FPS = 15;     // 原片 30fps,减半后动作看不出差别,文件小一半
// 调色板 48 色、不抖动:像素画本来就只有十几种颜色,抖动只会在色块上撒噪点。
// 实测(2026-09-26):24 张共 2.7 MB;360px/256 色时是 13 MB。

const reg = JSON.parse(fs.readFileSync(path.join(SRC, "registry.json"), "utf8"));
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const out = {};
for (const [tag, file] of Object.entries(reg)) {
  const src = path.join(SRC, file);
  const base = file.replace(/\.[^.]+$/, "");
  if (file.endsWith(".webp")) {
    fs.copyFileSync(src, path.join(OUT, file));
    out[tag] = file;
  } else if (file.endsWith(".webm")) {
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-c:v", "libvpx-vp9", "-i", src,
      "-filter_complex", `fps=${GIF_FPS},scale=${GIF_SIDE}:${GIF_SIDE}:flags=neighbor,split[a][b];[a]palettegen=max_colors=48:reserve_transparent=1[p];[b][p]paletteuse=dither=none:alpha_threshold=128`,
      "-loop", "0", path.join(OUT, `${base}.gif`)]);
    out[tag] = `${base}.gif`;
  } else {
    console.warn("跳过不认识的格式:", file);
  }
}
fs.writeFileSync(path.join(OUT, "registry.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`转好 ${Object.keys(out).length} 张 →`, OUT);

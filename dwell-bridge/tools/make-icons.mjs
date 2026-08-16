// 生成 dwell 的桌面图标与 manifest。
//
// 为什么需要它：dwell 的 index.html 的 <head> 里**早就**写好了
//   icons/favicon-64.png / icons/favicon.ico / icons/icon-180.png / manifest.json
// 四个引用，但仓库里这些文件根本不存在（发布时被剥掉了）。
// 所以「添加到主屏幕」时 iOS 找不到图标，只能拿网页截图凑数。
//
// 样式：**白底 + 橙色菊花**（所有者定的，官端是反过来的橙底白花）。
// 菊花图形直接取自 index.html 里的 SKETCH.spark，保证和页面上是同一朵。
//
// ⚠️ 居中不能靠经验值。这个图形的墨迹并不铺满它的 24×24 方框，
// 一开始我套用了锁屏那组补偿量（-4.27% / -3.14%），那是给一朵小花做视觉微调的，
// 放到撑满整块的图标上就偏了（2026-08-16 所有者一眼看出不居中）。
// 现在改成**在浏览器里量出 path 的真实边界框**（getBBox），按边界框居中、
// 按边界框定大小 —— 精确，且换任何图形都成立。
//
// 跑法：node tools/make-icons.mjs <spark路径文件> <输出目录>
// 依赖 playwright（渲染 SVG → PNG，比手搓栅格化可靠）。

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const [, , pathFile, outDir] = process.argv;
if (!pathFile || !outDir) {
  console.error("用法：node tools/make-icons.mjs <spark路径文件> <输出目录>");
  process.exit(2);
}

const D = fs.readFileSync(pathFile, "utf8").trim();
const ORANGE = "#e1734f";
const WHITE = "#ffffff";
// 反色版（官端那种橙底白花）。ICON_INVERT=1 生成这一版。
const INVERT = process.env.ICON_INVERT === "1";
const BG = INVERT ? ORANGE : WHITE;
const FG = INVERT ? WHITE : ORANGE;

// 菊花占画布的比例。**0.66 太小了**（2026-08-16 所有者一眼就说不像），
// 官端那朵几乎撑满；而且橙花画在白底上，视觉上比白花画在橙底上更"瘦"
// （浅底深字本来就显细），所以要更大一点才压得住。
// 墨迹占画布的比例（按真实边界框的长边算）。0.66 太小、0.80 太大，
// 官端目测在 0.72 上下。
const SCALE = +(process.env.ICON_SCALE || 0.72);

// bbox 在下面用浏览器量出来后填进去
let BB = null;

function svg(size) {
  const w = BB.width, h = BB.height;
  const k = (size * SCALE) / Math.max(w, h);          // 长边贴合目标比例
  const x = size / 2 - (BB.x + w / 2) * k;            // 让边界框中心落在画布中心
  const y = size / 2 - (BB.y + h / 2) * k;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${BG}"/>
  <g transform="translate(${x} ${y}) scale(${k})">
    <path d="${D}" fill="${FG}"/>
  </g>
</svg>`;
}

// ICO：从 Vista 起允许直接内嵌一张 PNG，所以不用真去写 BMP 位图。
// 结构 = 6 字节头 + 16 字节目录项 + PNG 原文。
function ico(png, size) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);      // 保留
  head.writeUInt16LE(1, 2);      // 类型 1 = 图标
  head.writeUInt16LE(1, 4);      // 张数
  const dir = Buffer.alloc(16);
  dir[0] = size >= 256 ? 0 : size;   // 宽（256 要写 0）
  dir[1] = size >= 256 ? 0 : size;   // 高
  dir[2] = 0;                        // 调色板
  dir[3] = 0;                        // 保留
  dir.writeUInt16LE(1, 4);           // 色彩平面
  dir.writeUInt16LE(32, 6);          // 位深
  dir.writeUInt32LE(png.length, 8);  // 数据长度
  dir.writeUInt32LE(22, 12);         // 数据偏移 = 6 + 16
  return Buffer.concat([head, dir, png]);
}

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium",
});

// 先量边界框：把 path 放进一张离屏 SVG 里问浏览器要 getBBox
{
  const page = await browser.newPage();
  await page.setContent(`<svg id="s" viewBox="0 0 24 24"><path id="p" d="${D}"/></svg>`);
  BB = await page.evaluate(() => {
    const b = document.getElementById("p").getBBox();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  });
  await page.close();
  console.log(`  边界框 x=${BB.x.toFixed(2)} y=${BB.y.toFixed(2)} w=${BB.width.toFixed(2)} h=${BB.height.toFixed(2)}（画布 24×24）`);
}

fs.mkdirSync(outDir, { recursive: true });
const made = {};

for (const size of [64, 180, 192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;padding:0}</style>${svg(size)}`,
    { waitUntil: "load" }
  );
  const buf = await page.screenshot({ omitBackground: false });
  const name = size === 180 ? "icon-180.png" : size === 64 ? "favicon-64.png" : `icon-${size}.png`;
  fs.writeFileSync(path.join(outDir, name), buf);
  made[name] = buf.length;
  if (size === 64) {
    fs.writeFileSync(path.join(outDir, "favicon.ico"), ico(buf, 64));
    made["favicon.ico"] = fs.statSync(path.join(outDir, "favicon.ico")).size;
  }
  await page.close();
}

await browser.close();
for (const [k, v] of Object.entries(made)) console.log(`  ${k.padEnd(16)} ${v} 字节`);
console.log("图标生成完毕：", outDir);

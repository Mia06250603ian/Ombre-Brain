// 把 copy-to-yan.js 注进 flight-chess-popup.html。
//
// 为什么用「注入」而不是「改 player 仓库」：
//   游戏源码的唯一可信源是 Mia06250603ian/player。存两份日久必然一边改一边不改
//   （手册里那句「东西在 dwell 里了，别留两份」）。所以这里只在部署前拉一份、
//   打一层补丁，补丁本身（copy-to-yan.js）才是我们维护的东西。
//
// **找不到锚点就停下，不猜着改** —— 照 dwell-bridge/strip-demo.mjs 的规矩。
// 游戏那边哪天改了结构，这里会非零退出，部署当场失败，而不是悄悄上线一个坏页面。
//
// 用法：node inject-copy.mjs <输入 html> <输出 html> <补丁 js>

import fs from "node:fs";
import { extractBoards, boardsToLiteral } from "./extract-boards.mjs";

// 让弹窗页认得功能页选的版本。
// 原样是 `const CURRENT_BOARD = { key:'maid', … }` —— 写死女仆版。
// 改成 `const CURRENT_BOARD = (取存档选中的那版) || { key:'maid', … }`：
// **原来那段字面量一个字不动地留在 || 后面当兜底**，所以取不到时行为与改前完全一致。
// 这样写还有个好处：不用去配对象的大括号，改动面只有一行。
const BOARD_ANCHOR = "const CURRENT_BOARD = {";

export function injectBoards(html, boards) {
  // 这条必须排在锚点检查前面：注过一次之后锚点已被改写，
  // 先撞锚点检查会报「player 改结构了」，把人带偏
  if (html.includes("__CHESS_BOARDS__")) throw new Error("这份 HTML 已经接过棋盘数据了，别重复注入（重新跑 fetch-game.sh 拉干净的）");
  if (!html.includes(BOARD_ANCHOR)) {
    throw new Error(`弹窗页里找不到「${BOARD_ANCHOR}」——player 仓库大概改结构了，先看过再部署`);
  }

  const head =
    "\n<!-- __CHESS_BOARDS__ 九个版本的棋盘,构建时从功能页 index.html 算出来的 -->\n" +
    "<script>\n" +
    "window.__CHESS_BOARDS__ = " + boardsToLiteral(boards) + ";\n" +
    "window.__pickBoard = function () {\n" +
    "  try {\n" +
    "    var raw = localStorage.getItem('flight_chess_progress')\n" +
    "           || localStorage.getItem('flight_chess_player');\n" +
    "    if (!raw) return null;\n" +
    "    var v = JSON.parse(raw).version;\n" +
    "    var b = v && window.__CHESS_BOARDS__[v];\n" +
    "    if (!b) return null;\n" +
    "    return { key: v, name: b.name, cells: b.cells };\n" +
    "  } catch (e) { return null; }\n" +
    "};\n" +
    "</scr" + "ipt>\n";

  // 插在游戏脚本**之前**：__pickBoard 必须先存在
  const firstScript = html.indexOf("<script>");
  if (firstScript < 0) throw new Error("找不到第一个 <script>，不猜着往哪儿插");

  const out = html.slice(0, firstScript) + head + html.slice(firstScript);
  return out.replace(BOARD_ANCHOR, "const CURRENT_BOARD = (window.__pickBoard && window.__pickBoard()) || {");
}

export function inject(html, patch) {
  // ① 游戏必须还是我们认识的那个：补丁靠这三个东西干活
  const need = [
    ["window.flightChessBuildInjectPrompt", "游戏自带的注入词生成器"],
    ["function aiRoll(", "小机掷骰"],
    ["function playerRoll(", "你掷骰"],
  ];
  for (const [needle, what] of need) {
    if (!html.includes(needle)) {
      throw new Error(`游戏源码里找不到「${what}」（${needle}）——player 仓库大概改结构了，先看过再部署`);
    }
  }

  // ② 已经注过就不再注一遍（重复跑脚本不该叠两份）
  if (html.includes("__YAN_COPY_PATCH__")) {
    throw new Error("这份 HTML 已经打过补丁了，别重复注入（重新跑 fetch-game.sh 拉干净的）");
  }

  // ③ 插在 </body> 前面。找不到就停。
  const at = html.lastIndexOf("</body>");
  if (at < 0) throw new Error("找不到 </body>，不猜着往哪儿插");

  // 补丁里绝不能出现 </script>，否则会把 HTML 的脚本块提前关掉
  if (/<\/script/i.test(patch)) throw new Error("补丁里含 </script>，会把脚本块切断");

  const block =
    "\n<!-- __YAN_COPY_PATCH__ 「复制给晏」按钮，源码在 Ombre-Brain/chess-web/copy-to-yan.js -->\n" +
    "<script>\n" + patch + "\n</script>\n";

  return html.slice(0, at) + block + html.slice(at);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , inFile, outFile, patchFile] = process.argv;
  if (!inFile || !outFile || !patchFile) {
    console.error("用法: node inject-copy.mjs <popup.html> <out.html> <patch.js> <index.html>");
    process.exit(2);
  }
  const indexFile = process.argv[5];
  if (!indexFile) {
    console.error("用法: node inject-copy.mjs <popup.html> <out.html> <patch.js> <index.html>");
    process.exit(2);
  }
  const html = fs.readFileSync(inFile, "utf8");
  const patch = fs.readFileSync(patchFile, "utf8");
  const indexHtml = fs.readFileSync(indexFile, "utf8");

  let out;
  try {
    const boards = extractBoards(indexHtml);
    console.log(`  抠到 ${Object.keys(boards).length} 个版本：${Object.keys(boards).join(", ")}`);
    out = injectBoards(html, boards);
    out = inject(out, patch);
  } catch (e) { console.error("✗ 注入失败：" + e.message); process.exit(1); }

  // ④ 注完回读一遍，确认真的进去了
  if (!out.includes("__CHESS_BOARDS__") || !out.includes("window.__pickBoard()")) {
    console.error("✗ 棋盘数据没接上，没上线之前先停下");
    process.exit(1);
  }
  if (!out.includes("__YAN_COPY_PATCH__") || !out.includes("__yanCopyReady")) {
    console.error("✗ 注完之后回读不到标记，没上线之前先停下");
    process.exit(1);
  }
  fs.writeFileSync(outFile, out);
  console.log(`✓ 补丁已注入：${outFile}（${out.length} 字符，补丁 ${out.length - html.length}）`);
}

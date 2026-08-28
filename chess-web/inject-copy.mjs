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
    console.error("用法: node inject-copy.mjs <in.html> <out.html> <patch.js>");
    process.exit(2);
  }
  const html = fs.readFileSync(inFile, "utf8");
  const patch = fs.readFileSync(patchFile, "utf8");

  let out;
  try { out = inject(html, patch); }
  catch (e) { console.error("✗ 注入失败：" + e.message); process.exit(1); }

  // ④ 注完回读一遍，确认真的进去了
  if (!out.includes("__YAN_COPY_PATCH__") || !out.includes("__yanCopyReady")) {
    console.error("✗ 注完之后回读不到标记，没上线之前先停下");
    process.exit(1);
  }
  fs.writeFileSync(outFile, out);
  console.log(`✓ 补丁已注入：${outFile}（${out.length} 字符，补丁 ${out.length - html.length}）`);
}

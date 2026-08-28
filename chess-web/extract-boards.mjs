// 从功能页 index.html 里把九个版本的棋盘数据抠出来，供弹窗页使用。
//
// **为什么需要这一步**（2026-08-28 现场查证，两条都是 player 仓库弹窗页的问题，
// 不是本层引入的）：
//
//   ① 弹窗页里只写死了**女仆版一个**：`const CURRENT_BOARD = { key:'maid', … }`，
//      原注释写着「实际接入时从功能页 / 全局状态读进来」——它本来是准备嵌进 beilyes
//      app 用的，单独打开就永远是女仆版。功能页存进 localStorage 的 `version` 它根本不看。
//   ② 弹窗页的 `makeCells` 是**旧版**：只分 type，**不解析 `后进X格` / `退回到N格`**，
//      而它的 `movePiece` 却在读 `landCell.backSteps` / `landCell.jumpTo`。
//      结果这两类格子在弹窗里**一格都不会退**（README 规则 2 承诺的行为没实现）。
//      功能页的 `makeCells` 是完整版，两个字段都给。
//
// 所以这里直接取**功能页的 makeCells + BOARDS**，在构建时算成纯数据，
// 一次把两个问题都解决：版本能切了，后退也真的会退了。
//
// **构建时求值、运行时纯数据** —— 不往页面里搬源码，省得两边的 makeCells 再次分家。

// 从 `起点` 位置开始，找到与之配对的闭合括号，返回整段源码
function sliceBlock(src, startIdx, open, close) {
  let depth = 0;
  for (let i = startIdx; i < src.length; i++) {
    const c = src[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return src.slice(startIdx, i + 1);
    }
  }
  return null;
}

export function extractBoards(indexHtml) {
  const mcAt = indexHtml.indexOf("function makeCells");
  if (mcAt < 0) throw new Error("功能页里找不到 makeCells —— player 仓库大概改结构了");
  const mcBody = sliceBlock(indexHtml, indexHtml.indexOf("{", mcAt), "{", "}");
  if (!mcBody) throw new Error("makeCells 的大括号配不上对，不猜着切");

  const bAt = indexHtml.indexOf("const BOARDS = {");
  if (bAt < 0) throw new Error("功能页里找不到 BOARDS —— player 仓库大概改结构了");
  const bBody = sliceBlock(indexHtml, indexHtml.indexOf("{", bAt), "{", "}");
  if (!bBody) throw new Error("BOARDS 的大括号配不上对，不猜着切");

  // 在一个干净的函数作用域里求值。这段源码来自我们自己的 player 仓库，
  // 不是外部输入；即便如此也不给它任何外部引用。
  let boards;
  try {
    boards = new Function(`"use strict"; function makeCells(list)${mcBody}; return ${bBody};`)();
  } catch (e) {
    throw new Error("功能页的棋盘数据算不出来：" + e.message);
  }

  // ── 护栏：算出来的东西必须像那么回事，否则停下 ──
  const keys = Object.keys(boards);
  if (keys.length < 2) throw new Error(`只抠出 ${keys.length} 个版本，明显不对`);
  for (const k of keys) {
    const b = boards[k];
    if (!b || typeof b.name !== "string" || !Array.isArray(b.cells) || b.cells.length < 2) {
      throw new Error(`版本 ${k} 的数据不完整`);
    }
    if (b.cells.some((c) => typeof c.text !== "string")) throw new Error(`版本 ${k} 有格子没有文字`);
  }
  // 必须解析出了后退格，否则说明抠到的是**旧版 makeCells**，
  // 那样换了版本也还是不会退格 —— 等于白修。
  const hasBack = keys.some((k) => boards[k].cells.some((c) => c.backSteps > 0));
  if (!hasBack) throw new Error("一个「后进X格」都没解析出来 —— 抠到的多半是旧版 makeCells，停下");

  return boards;
}

// 嵌进 <script> 时把 `<` 转义掉，免得 `</script>` 之类把脚本块切断
export function boardsToLiteral(boards) {
  return JSON.stringify(boards).replace(/</g, "\\u003c");
}

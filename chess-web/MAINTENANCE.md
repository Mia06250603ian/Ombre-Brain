# chess-web 维护手册

> 把 `Mia06250603ian/player` 那个双人飞行棋挂成一个带口令的网页，
> 并给它打一层「复制给晏」的补丁。
> 2026-08-28 初版。**这是本仓库的第六个目录**（原本五个，见 `../START-HERE.md`）。

## 0. 一句话

她在网页上掷骰走棋 → 停在格子上 → 底部弹一段该告诉晏的话 → **点「复制」，
她自己切到 Telegram 粘给他。**

**这一层不联网、不碰晏、不碰 shim、不碰记忆库。** 它只做两件事：查口令、发静态文件。
**这就是它敢单独上线、且上线过程零风险的全部理由。**

## 1. 为什么是「复制粘贴」而不是「自动发给他」

所有者 2026-08-28 拍板做**第 2 档**。三档当时是这么摆的：

| 档 | 是什么 | 代价 |
|---|---|---|
| 1 | 纯静态页，自己选字复制 | 无 |
| **2（做了这个）** | 加一颗按钮，一点就复制好 | 粘贴仍是她自己按 |
| 3 | 嵌进 dwell 网页，点一下直接发出去 | 要先把 `SHIM_KEY` 搬到 dwell（**至今没搬**，见 `../dwell-bridge/MAINTENANCE.md` §9）+ 改 dwell 前端 |

**第 3 档的全部价值只是省掉「粘贴一下」**。她先用第 2 档实际玩几局再定，
第 2 档做的东西到时候一点不浪费（补丁照旧能用，只是把「复制」换成「发送」）。

**⚠️ 不需要改晏的人设。** 游戏自带的那段注入词里已经写了「禁止再讨论掷骰」那些规矩
（`buildInjectPrompt`），README 里说「机提示词可加一句」的那句话其实包在里面了。
改人设 = 重新部署 shim = **晏当前的窗口会丢**，这条路省掉了。

## 2. 目录里有什么

| 文件 | 是什么 |
|---|---|
| `server.js` | 服务本体。零依赖（只用 node 内置模块），口令 cookie + 发 `game/` 里的文件 |
| `copy-to-yan.js` | **我们真正维护的东西**：注进游戏页面的那段「复制给晏」脚本 |
| `inject-copy.mjs` | 把上面那段注进 HTML,**并把九个版本的棋盘接进弹窗页**。**找不到锚点就非零退出**,不猜着改 |
| `extract-boards.mjs` | 构建时从功能页 `index.html` 抠出九个版本的棋盘(见踩坑 7/8) |
| `fetch-game.sh` | 从 player 仓库拉游戏 + 打补丁。**每次部署都要跑** |
| `test-chess.mjs` | 单测,**41 项**(2026-08-28 修完两个 bug 后)。`node test-chess.mjs` |
| `e2e-browser.mjs` / `e2e-run.sh` | 真浏览器演练,**33 项**(2026-08-28 修完两个 bug 后) |
| `game/` | **拉下来的游戏，刻意不入库**（见下一节） |

## 3. `game/` 为什么不入库

游戏的唯一可信源是 `Mia06250603ian/player`。存两份日久必然一边改一边不改
——照 dwell-bridge 那句「东西在 dwell 里了，别留两份」的同一条规矩。
所以这里只在部署前 `./fetch-game.sh` 拉一次。

**这带来一个必须记住的后果**（dwell 那边同款，第五次部署踩过）：
`game/` 在 `.gitignore` 里，而 **zeabur 上传遵守 `.gitignore`**，
直接 deploy 会把游戏文件漏在外面、页面回「游戏文件还没放进来」。
**部署前要临时把 `.gitignore` 收窄成只有 `node_modules/`，传完还原**（见第 6 节）。

## 4. 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `CHESS_PASS` | **是** | 网页口令。**不设 = 页面没有锁**，启动日志会喊，但拦不住你 |
| `PORT` | 否 | 默认 8080 |

**改环境变量 = 改值 + `service restart` 即生效，不用重新部署。**
盐每次启动换一把，所以 **restart = 已登录的会话全部失效**，要重新输口令。这是想要的。

## 5. 接口

| 路径 | 干什么 |
|---|---|
| `GET /` | 游戏功能页（`index.html`）；没登录发登录页 |
| `GET /flight-chess-popup.html` | 聊天弹窗版（**「复制给晏」的按钮在这一份里**） |
| `POST /login` | 口令换 cookie |
| `GET /health` | 存活 + 有没有上锁 + `game/` 里有几个文件（**不过口令**，不含任何密钥） |

其余一律 404。**只发 `game/` 目录里的文件**，且只发 html/js/css/png/ico/json 这几种后缀。

## 6. 部署

```sh
cd chess-web
node test-chess.mjs                       # 单测，29 项要全绿
./fetch-game.sh                           # 拉游戏 + 打补丁（每次都要跑）
# 真浏览器演练（可选但建议）：
#   npm i playwright@1.49.1 --prefix /tmp/pw && PW=/tmp/pw/node_modules ./e2e-run.sh

# ⚠️ zeabur 上传遵守 .gitignore，而 game/ 在里面 —— 传之前临时收窄
cp .gitignore .gitignore.bak && printf 'node_modules/\n' > .gitignore
npx -y zeabur@latest deploy --create --name chess-web --project-id <项目id>
mv .gitignore.bak .gitignore              # ← 传完立刻还原，别忘

# 部署后第一件事看 PLANTYPE，必须是 nodejs（照 shim 踩坑 17 的规矩）
npx -y zeabur@latest deployment list --service-id <id> --env-id <env>
```

**验收**（照这几条过）：
- `/health` → `ok:true, locked:true, ready:true`
- 未登录时 `/` 给登录页、`/flight-chess-popup.html` 也给登录页（**不能直接发出游戏**）
- 登录后弹窗页里搜得到 `__YAN_COPY_PATCH__` 和 `__yanCopyReady`
- 掷一次骰子，底部弹出面板、点「复制」有回执

## 7. 已知边界（都是取舍，不是 bug）

1. **粘贴要她自己按。** 见第 1 节，这是第 2 档的定义。
2. **补丁只在弹窗页生效**（`flight-chess-popup.html`）。功能页 `index.html` 只用来选版本、看棋盘，
   本来就没有掷骰按钮。
3. **「我停在那格」用的是我们自己写的措辞，不是游戏自带那段。**
   游戏的 `buildInjectPrompt` 开头写死「小机停在第 N 格」，套到她身上会自相矛盾。
   所以她停的格子改用一句只复述事件字段的话（`fallbackText`），**不新编任何规则**。
   小机停的格子仍然原样用游戏自带那段。
4. **面板会压住「我投掷 / 到你了」两颗按钮。** 复制成功后 1.5 秒自动收起，把按钮让出来；
   复制失败**不收**（那种情况她还要长按选字）。想再叫回来点右下角那颗「发给晏」。
5. **游戏自带的「知道了」弹层照旧会出现**，和我们的面板同时在屏上（我们的在上层，点得到）。
   没去动它——那是游戏本来的行为，不归这一层管。
6. **口令是单一口令，没有账号体系。** 一个人自用够了。
7. **重启 = 重新输口令**(盐每次换)。
8. **版本是从功能页带过来的,不是在弹窗里选的。** 要换版本得回功能页(`/`)选一次再进弹窗
   ——这是游戏本来的流程,本层没改。取不到存档时兜底为女仆版(见踩坑 7)。

## 8. 踩过的坑

1. **`window.flightChessGetLastEvent()` 不会减 `roundsLeft`。**
   player 的 README 写着「每取一次 roundsLeft-1，最多约 2 轮」，
   **但源码里那个函数只是 `return {...state.lastEvent}`，没有任何减法**（2026-08-28 逐行核过）。
   补丁因此可以放心地反复取事件。**以源码为准，别照 README 那句设计。**
2. **`state` 不是全局变量**，只有 `window.flightChess*` 四个是导出的。
   补丁**只能**走那四个口子 + 包住 `aiRoll`/`playerRoll`（这两个是顶层函数声明，
   所以在 window 上）。想读 `state.playerPos` 会拿到 `undefined`——写测试时栽过一次。
3. **上一轮的服务占着端口不退**，新的那个 `EADDRINUSE` 静默退出，
   于是测试打在旧服务上、看到的是旧行为。**换端口比 pkill 可靠**
   （dwell 手册第四次部署记过同款，这次又踩了一遍，所以 `e2e-run.sh` 支持 `PORT=`）。
4. **ESM 不认 `NODE_PATH`。** playwright 装在别处时，`cd` 过去也没用——
   ESM 只从「引用它的文件」往上找 `node_modules`。`e2e-run.sh` 改成临时软链，跑完撤掉。
5. **`Secure` cookie 不能无条件加。** Zeabur 在外层收 TLS、进容器是明文 http，
   本地 http 调试时加了 `Secure` 浏览器根本不存这块 cookie、登录会变成死循环。
   现在靠 `x-forwarded-proto` 判断，单测两个方向都钉住了。
6. **补丁里绝不能出现 `</script>`**，会把宿主页面的脚本块提前关掉。
   `inject-copy.mjs` 有一条守这个，单测也钉了。

7. **⚠️ 弹窗页只写死了女仆版一个 —— 这是 player 仓库的 bug,不是本层引入的。**
   `flight-chess-popup.html` 里就一行 `const CURRENT_BOARD = { key: 'maid', … }`,
   **功能页存进 localStorage 的 `version` 它根本不读**(原注释:「实际接入时从功能页 / 全局状态读进来」
   —— 它本来是准备嵌进 beilyes app、由 app 喂棋盘的)。**单独打开就永远是女仆版。**
   **2026-08-28 所有者上线当天就撞上了**,报「每次点开都是女仆版没有其他的」。
   **本层的绕法**(`injectBoards`):把那行改成
   `const CURRENT_BOARD = (window.__pickBoard && window.__pickBoard()) || { …原字面量… }`
   ——**原来那段女仆版的字面量一个字不动地留在 `||` 后面当兜底**,取不到时行为与改前逐字相同;
   这样写还不用去配对象的大括号,改动面只有一行。
   ⚠️ **源头的 bug 还在 player 仓库里**,本层只是绕过去了。**这游戏放进 beilyes app 时会再犯一次。**

8. **⚠️ 弹窗页的 `makeCells` 是旧版,「后进X格 / 退回到N格」一格都不会退。**
   它只给格子分 `type`,**不解析 `backSteps` / `jumpTo` 两个数字**;
   而同一份文件里的 `movePiece` 却在读 `landCell.backSteps` / `landCell.jumpTo`
   —— 于是 README 规则 2 承诺的「停在后进 X 格会实际后退」**在弹窗里是死的**。
   功能页的 `makeCells` 是完整版,两个字段都给。
   **所以 `extract-boards.mjs` 取的是功能页那一份**,一次把踩坑 7 和这条一起治了。
   **护栏**:抠完必须至少解析出一个 `backSteps > 0`,否则抛错停下
   ——不然哪天抠到了旧版 `makeCells`,版本是换了、退格还是死的,**等于白修且不易察觉**。

9. **写测试时别只盯着自己加的东西。**
   第一版的 25 项浏览器用例全在验「复制给晏」那颗按钮,**一条都没验「换个版本进去还是不是那个版本」**
   ——而截图里明晃晃写着「女仆版」、测试输出里打印过「格子内容:后进3格」且棋子位置没变,
   **摆在眼前也没看出来**。所以现在的用例里钉了三个版本的标题、格子数,
   并把后退格做成**确定性验证**(钉死 `Math.random`,让棋子正好停在那格上,断言
   `已后退 3 格` 且位置回到 0),不靠碰运气。

## 9. 跟别处的关系

- **游戏源码在 `Mia06250603ian/player`**，不在本仓库。**改游戏本身去那个仓库改**，
  改完这边重新 `./fetch-game.sh` 就跟上了。
- **想做第 3 档（自动发给晏）**：先读 `../dwell-bridge/MAINTENANCE.md`
  （尤其 §9 的 `SHIM_KEY` 那条和 §7 已知边界），再回来看本手册第 1 节。
- **本目录不碰 shim / OB / bridge 任何一个。** 它跟它们的关系只有一条：
  没有关系。这一条是刻意的。

## 10. 部署记录

### 第一次(2026-08-28):建服务并上线

**全程没碰晏、没碰 shim、没重启机器、窗口未丢** —— 新建独立容器,和已有服务互不相干。

- Zeabur 位置:项目 `cli-proxy-api--cpa`(`6a53a9fc22dd6ef375eb7484`),
  env `6a53a9fcb6ce8edcb0163f97`,**service id `6a91a74db7ff62ee8d7ffcb3`**,
  域名 `yan-chess.zeabur.app`
- 建法:`zeabur deploy --create --name chess-web --project-id <项目>`(CLI 没有 `service create`)
- **PLANTYPE 验到 `nodejs`** —— 照 shim 踩坑 17 的规矩,部署后第一件事就看这个
- 域名:`domain create --domain yan-chess -g`

**验收(全过,2026-08-28)**:
- `/health` → `{"ok":true,"locked":true,"files":3,"ready":true}`
- 未登录时 `/`、`/index.html`、`/flight-chess-popup.html` **三条都给登录页(401)**,页面里搜不到棋盘
- 口令错 401 且不发 cookie;口令对发 cookie 且**带 `Secure`**(线上真走 HTTPS,`x-forwarded-proto` 那条判断成立)
- 伪造 cookie 401;`/../server.js`、`/..%2fserver.js`、`/../package.json` 全 404
- 登录后弹窗页 **29676 字节**,`__YAN_COPY_PATCH__` / `__yanCopyReady` 各 1 处
- **三个文件与本地待部署那份逐字节 md5 一致**(照「部署前和线上容器 md5 对账」的规矩):
  `index.html 9f35b716…` / `flight-chess-popup.html 70f1ee70…` / `float-window.js 91a048f1…`
- 单测 **29 项**、真浏览器演练 **25 项**全绿

**⚠️ 内存至今没量到**(2026-08-28):服务刚上线,`zeabur service metric MEMORY` 回
`no metric history found`。**别拿估计值当实测填进任何文档**(手册规矩 4)。
过几天再量:

```sh
npx -y zeabur@latest service metric -i=false MEMORY \
  --id 6a91a74db7ff62ee8d7ffcb3 --env-id 6a53a9fcb6ce8edcb0163f97
```

**量到了就把数填进 `../browser-hands/MAINTENANCE.md` 的内存表**(那张表是全机内存的唯一去处)。
预期很小(零依赖 node + 60KB 静态文件),但**预期不是实测**。
对照(2026-08-01/02 实测):晏 324~605MB、browser-hands 峰值 1474MB、CLIProxyAPI 24~61MB。

**这次踩的坑**(都已写进第 8 节):端口没退干净、ESM 不认 NODE_PATH、`Secure` cookie 不能无条件加。
**另外两条 CLI 的事**:
- `zeabur variable update` **默认进交互模式**,脚本里会 EOF 报错。要加 `-i=false`。
- `zeabur variable list` 仍会连值一起打出来(dwell 第一次部署的教训)。
  本次改用 `--json` + 只打印 key 名,**值一次都没进会话记录**。

### 第二次(2026-08-28):修「永远是女仆版」和「后退格不会退」

**上线当天所有者就报了**:「每次点开都是女仆版没有其他的」。查下来是 **player 仓库弹窗页的两个 bug**
(踩坑 7、8),不是本层引入的 —— **但第一次的验收该发现而没发现**(踩坑 9)。

- 新增 `extract-boards.mjs`:构建时从功能页抠出九个版本(2026-08-28 实测九个全在:
  foreplay/maid/couple/private_adv/sm/butler/love/private/advanced,格子数 34~53 不等)
- `inject-copy.mjs` 新增 `injectBoards`,把棋盘数据插在游戏脚本**之前**并改写那一行
- 单测 **29 → 41 项**,浏览器演练 **25 → 33 项**,全绿
- **只重新部署 chess-web 一个服务**,没碰晏 / shim / OB,窗口未丢

**验收**(2026-08-28):选 SM 版 / 男仆版 / 前戏版进弹窗,标题与格子数都跟着变;
后退格确定性验证通过 —— `你 停在第 3 格` / `后进3格(已后退 3 格,现位于第 0 格)` / 进度条 `你 0`。

**留给下一个人的一件事**:**源头 bug 仍在 `Mia06250603ian/player`**,本层只是绕过去了。
本次会话**没有该仓库的写权限**,所以没能去源头修。**已报备所有者。**
真去源头修的话,两处:①弹窗页的 `CURRENT_BOARD` 改成读 localStorage 的 `version`;
②把弹窗页的 `makeCells` 换成功能页那一份。修完之后本层的 `injectBoards` 会自动变成无害的冗余
(它取到的还是同一份数据),但**别急着删** —— 先确认 player 那边真改了再说。

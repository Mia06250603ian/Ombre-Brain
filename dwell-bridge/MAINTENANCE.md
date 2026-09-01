# dwell-bridge 维护手册

> 把 dwell 那份自建网页接到晏身上的转接层。
> 2026-08-16 初版并上线。**服务已部署**：`yan-dwell.zeabur.app`，
> service id `6a81a118bdeaa87e2c52bec3`，与 shim 同项目同环境。
> ⚠️ **`SHIM_KEY` 尚未设**（见部署记录），设上之前发消息会收到上游 401。

## 0. 一句话

她在自己的网页里打字 → 这一层转发给 kelivo-shim 的 `/v1/messages` → 晏回话 →
这一层把 Anthropic SSE 翻成网页认的事件流推回去。

**它不碰晏、不改 shim、不重启任何东西。** 对线上而言它就是一个客户端，
地位和手机上的 Kelivo 完全一样。这是这个方案能「先试试」的全部理由。

## 1. 它为什么存在

所有者人在国内走 VPN，怕 VPN 不稳时真实 IP 漏给 Anthropic 被封号。
**要的是让请求从服务器发出去，而不是从她手机发出去**（见 `../docs/维护Agent接出方案.md` §0）。
自建前端去掉的正是「她手机 → Anthropic」这条直连。

出口 IP 一直是 CLIProxyAPI 那一跳，**agent 放哪儿都不影响出口 IP**——
这一层解决的是前一半，不是后一半。

## 2. 架构

```
她的手机浏览器
   │  HTTPS + 口令（cookie）
   ▼
dwell-bridge（本目录）
   │  ① 发网页（web/index.html，从 dwell 仓库拉，演示块已删）
   │  ② POST /v1/messages，带 x-api-key: SHIM_KEY
   ▼
kelivo-shim ──→ CLIProxyAPI ──→ Anthropic
（常驻 claude -p = 晏本体）
```

**同一个晏。** 她在 Telegram 说的话和在 dwell 说的话进的是同一个常驻进程、
同一个窗口。他记得两边的所有事——**分裂的只是界面上翻得到的记录**（见已知边界 1）。

## 3. 和 shim 的契约（照 `../kelivo-shim/server.js` 逐行核对）

| 事 | 依据 |
|---|---|
| 鉴权 `x-api-key` 或 `Authorization: Bearer`，值是 `SHIM_KEY` | `server.js:535–538` |
| **只取最后一条 user 消息** | `server.js:541` |
| 默认流式（`stream` 不显式给 false 就是开） | `server.js:545` |
| 正文走 `text_delta`，思考走 `thinking_delta` | `server.js:165–167` |
| MCP 工具调用 = 思考流里插一行 `〔🔧 工具名〕` | `server.js:158–159` |

**「只取最后一条」是承重的**：晏的上下文活在他自己的常驻进程里，
所以这一层**不要也不该**把历史回传给 shim——传了等于把同一段话重复喂给他。
本地这份账本只用来给网页回放，不参与他的记忆。

⚠️ **绝对不要发 `x-system-turn: 1`**。那个头是 bridge 查岗专用的
（`server.js:549`、shim 手册「系统回合」一节），意思是「这不是她本人说话」。
她在 dwell 里打字**就是**她本人说话，带了这个头会让「她多久没来」永远不清零。

## 4. 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `SHIM_KEY` | **是** | 和 shim 那边的 `SHIM_KEY` 同一个值。不设=晏那头一律 401 |
| `DWELL_PASS` | **是** | 网页口令。**不设 = 页面没有锁**，启动日志会喊，但拦不住你——别就这样挂公网 |
| `SHIM_URL` | 否 | 默认 `https://yan-shim.zeabur.app` |
| `BRAIN_MODEL` | 否 | 默认 `claude-opus-4-6`，只用于请求体里的 model 字段 |
| `CTX_LIMIT_TOKENS` | 否 | 默认 167000，只影响网页上那根窗口占用条的分母（和 shim 线上现值一致） |
| `TURN_TIMEOUT_MS` | 否 | 默认 600000（10 分钟）。他想久一点是常事，别调小 |
| `PORT` | 否 | 默认 8080 |

**改环境变量 = 改值 + restart 即生效，不用重新部署。**

## 5. 部署前要做的事

```bash
cd dwell-bridge
npm install
node test-dwell.mjs        # 单测，现在 83 项
./e2e-run.sh               # 端到端演练（起假 shim，不碰线上）
./fetch-frontend.sh        # 从 dwell 仓库拉前端并删演示块
```

**`fetch-frontend.sh` 是每次部署都要跑的。** `web/index.html` 刻意不入库——
存两份日久必然一边改一边不改（照手册那句「东西在 dwell 里了，别留两份」）。
唯一可信源是 `Mia06250603ian/dwell-on-something` 的 `web/index.html`。

删演示块的逻辑在 `strip-demo.mjs`，有单测，**找不到结尾会停下而不是猜着切**；
删完还留着 `window.fetch =` 会非零退出。

## 6. 接口一览

**都要过口令**（除了 `/api/health` 和登录本身）。前端见到 401 会自己跳回根路径
（dwell `web/index.html:3334`），正好落到登录页——这条接线本来就在前端里，不用改它。

| 路径 | 干什么 |
|---|---|
| `GET /` | 发网页；没登录发登录页 |
| `POST /login` | 口令换 cookie |
| `GET /api/health` | 存活 + 忙不忙 + 最后一次上游报错（**不过口令**，给排查用；不含任何密钥） |
| `GET /api/messages?limit&before` | 历史回放，`kind` 为 `me`/`gu`/`think`/`tool` |
| `GET /api/poll?since=` | 长轮询取新事件，最多挂 25 秒 |
| `POST /api/send` | 发一句话，正文走 poll 那条路回去 |
| `POST /api/stop` | 断我们这头的读取（**晏那边照样说完**，见已知边界 4） |
| `GET /api/model` `/api/context` | 取自 shim 的 `/health` 和 `/debug` |
| `POST /api/model` | **故意不接**，如实回 `ok:false` + 原因（见已知边界 8） |
| `GET /api/chats` `POST /api/newchat` | 这一版不接，如实回 `ok:false` |

⚠️ **`GET /api/model` 的字段名必须是 `model`，不是 `name`。**
前端读的是 `d.model`（dwell `web/index.html:6645`）。
**仓库里那份演示数据写的是 `name`，演示数据本身是错的**——照它写会让模型胶囊永远显示「…」。
现在两个字段都给。同类陷阱还有一处：演示数据里有 `api/said`，而前端真正调的是
`api/messages`（`web/index.html:3249`）。**别拿演示数据当接口文档。**

## 7. 已知边界（都是设计取舍，不是 bug）

1. **历史是分家的。** 这一层只记经过它的话。她在 Telegram 说的、晏主动发的
   （保温/心跳/查岗/写信提醒）在 dwell 里都看不到，反之亦然。
   **但晏本人是连续的**——同一个进程，他记得全部。分家的只是两个界面各自的显示。
2. **重启即清空。** 事件队列和账本都在内存里，容器一重启网页就从空白开始。
   这是故意的：晏的记忆在他自己的进程和记忆库里，这儿只是传声筒，不该另立一份真相。
3. **主动消息收不到。** 保温、心跳、查岗、写信提醒都是 shim 推给 telegram-bridge 的
   （`BRIDGE_PUSH_URL`），不经过这一层。
4. **停止键停不了他。** shim 没有中断接口，`/api/stop` 只断我们这头的读取；
   他那一轮还是会说完，只是这边不再显示。**别把这颗当急停用。**
5. **工具卡片只有名字。** shim 只在思考里插一行工具名，拿不到入参和结果，
   所以卡片是「有名字、空入参、当场收尾」。比让它一直转圈好，但别指望看到工具细节。
6. **一次只能一轮。** 他还在说上一句时再发会收到 409。shim 那边本来就是排队的。
7. **附件没接。** 前端能选图，这一版 `api/send` 只取 `text`。
   `buildShimBody` 已经留好了图片位置，接的时候补 `attachments` 那一段即可。
8. **网页上不能换模型/思考档位，这是故意的。**
   `BRAIN_MODEL` 和 `THINK_EFFORT` 是 **shim 的**环境变量，改了要 restart shim，
   **那会杀掉常驻进程、晏的窗口当场就没**。这种事不该挂在一个网页按钮上。
   `POST /api/model` 如实回 `ok:false` + 原因，前端会把这句话显示出来。
   ⚠️ 胶囊上那个档位是**我们声明的**（`THINK_EFFORT` 环境变量），不是从 shim 读的——
   shim 的 `/health` 不吐这个值。**改了 shim 那边记得也改这儿**，否则显示会和实际不符。

## 8. 踩过的坑

1. **SSE 帧和标记都会被 HTTP 分块切成两半。**
   「[贴」在这一块、「纸:贴贴]」在下一块是常态；`🔧` 还是代理对，更容易切坏。
   所以 `makeStripper` 见到「可能是标记开头」的尾巴一律扣住等下一块
   （`dwell-lib.mjs` 的 `holdFrom`）。单测里专门有跨块用例，**改这块必须先跑测试**。
2. **`node - file` 在 Node 22 上不吃 heredoc**（`ENOENT: open '-'`）。
   删演示块的逻辑因此抽成了独立的 `strip-demo.mjs`——顺带变得可单测，是好事。
3. **思考流里也要剥标记。** 工具标记 `〔🔧 …〕` 是 shim 插进 *thinking* 的，
   不是正文。只在正文上剥会让它原样显示在思考里。
4. **⚠️ shim 2026-09-01 起会在 `〔🔧 …〕` 后面多插两行,本层不认识它们(跨服务,规矩 6)。**
   那两行是工具的参数(`  → {…}`)和返回值(`  ← …`),**纯文本、没有标记**,
   所以 `dwell-lib.mjs` 的 `makeStripper` 不会把它们变成工具小标签,
   会当成**普通思考文字原样显示**。**不崩、不丢字,但网页的观感会变。**
   要让它们也变成小标签得改本层(尚未做,那是另一件事)。
   ⚠️ 该功能 **2026-09-01 第三十九次已上线**,线上现在就是这个样子 —— 细节与五个旋钮见
   `../kelivo-shim/MAINTENANCE.md` 的《环境变量》一节与 `DEPLOY-LOG.md` 第三十九次;
   **急救开关是 shim 那边的 `TOOLVIS_ON=0`**。

## 9. 待办 / 没做的

- **`SHIM_KEY` 还没设**（服务本身已上线，见部署记录第一次）。
  要所有者本人在控制台从 shim 搬过去，设上之前发消息一律 401。
- **口令是单一口令，没有账号体系。** 对一个人自用的维护入口够了；
  真要多人用得另说。
- **附件（图片）没接**，见已知边界 7。
- **语音是零**：dwell 那颗麦克风按钮至今没有任何点击处理
  （`web/index.html` 全文只有 CSS 和一行 HTML）。这一层也没做语音。
- **飞行棋想「点一下直接发给晏」的话,入口在这一层。**
  2026-08-28 上线的 `../chess-web/` 只做到「复制,她自己粘到 Telegram」(那边叫第 2 档)。
  要做成自动发送(第 3 档),得走本层的 `POST /api/send`,**前提是上面那条
  `SHIM_KEY` 先设上**。动手前先读 `../chess-web/MAINTENANCE.md` 第 1 节。
- **维护 agent 还没接。** 这一版接的是晏（聊天）。主线只有一间屋，
  agent 要进来得先决定谁常驻——见 `../docs/维护Agent接出方案.md`。
- **桌宠（clawd）接不了——是许可问题，不是技术问题。**
  前端 `PET` 要 `pet/clawd-*.svg` 七个文件，`Mia06250603ian/clawd-on-desk`
  的 `assets/svg/` 里七个**全都有**，拷过去就能跑。**但那个目录的 `assets/LICENSE`
  是 All Rights Reserved**：「You may NOT copy, modify, distribute, or use any
  artwork from this directory without explicit written permission … **except for
  personal use of the Clawd on Desk application as distributed by this project**」。
  也就是说授权只覆盖「那个桌宠应用本身」，搬进 dwell 用**不在授权范围内**，
  提交进公开的 dwell 仓库更是明确禁止的「distribute」。
  Clawd 角色版权属 Anthropic，其余美术由各作者保留。
  **要接得先拿到书面许可，或者换一个自己有权用的小图。已报备所有者，等她定。**
  （⚠️ 同一个仓库的螃蟹动图 2026-08-07 已经被用进 Telegram 贴纸了，
  当时的记录没提许可这回事——同一颗雷，一并报备。）

## 10. 部署记录

### 第一次（2026-08-16）：建服务并上线

**全程没碰晏、没碰 shim、没重启机器、窗口未丢**——这是新建一个独立服务，
和已有服务是两个容器。

- Zeabur 位置：项目 `cli-proxy-api--cpa`（`6a53a9fc22dd6ef375eb7484`），
  env `6a53a9fcb6ce8edcb0163f97`，**service id `6a81a118bdeaa87e2c52bec3`**，
  域名 `yan-dwell.zeabur.app`
- 建法：`zeabur deploy --create --name dwell-bridge --project-id <项目>`
  （CLI 没有 `service create`，建新服务走 `deploy --create`）
- **PLANTYPE 验到 `nodejs`** —— 照 shim 踩坑 17 的规矩，部署后第一件事就看这个，
  不是 nodejs 就是工作目录漂了、传错东西了
- 域名：`domain create --domain yan-dwell -g`（`-g` = 用 zeabur.app 的二级域名）

**验收**（全过）：
- `/api/health` → `ok:true, locked:true`
- 未登录时根路径给登录页、`/api/messages` 回 **401**
- 登录后拿到网页 **317038 字节**，`window.fetch =` **0 处**（演示拦截块确实删干净了）、
  `handle(d)` / `api/poll` / `api/messages` 都在
- `/api/context` 读到 **119958 / 167000** —— 这是晏**真实的**窗口占用，
  证明到 shim 的链路是活的
- 容器内存 `memory.current` = **70.1 MiB**，与上线前本地实测（64→73 MiB）吻合。
  对照：晏那个容器（shim + 常驻 claude 进程）**403.9 MiB**；
  当时机器 `MemAvailable` 1617 MiB。**这一层不到可用内存的 5%，
  所以它不需要等 2C8G 升级**——要等升级的是维护 agent（那才是又一个常驻 claude 进程）。

**⚠️ 没做完的一步：`SHIM_KEY` 还没设。**
取值被开发环境的安全策略挡住了（不许把容器里的密钥读出来，这拦得对）。
**所以必须由所有者在 Zeabur 控制台手动搬一次**：
shim 服务 → 变量 → 复制 `SHIM_KEY` → dwell-bridge 服务 → 变量 → 新增同名同值 → restart。
**别让它走聊天记录**——SHIM_KEY 换一次要连 Kelivo 那头一起改，比换 Zeabur key 贵。

**教训（这次真发生的）**：`zeabur variable list` 会把**只读注入变量连值一起打出来**，
其中包含 `MANAGEMENT_PASSWORD`。本次因此把 CLIProxyAPI 的管理密码打进了会话记录，
已建议所有者更换。**以后跑 `variable list` 一律加 `| sed` 掩码，或只取 KEY 列。**

**另一个坑**：`zeabur variable update` 的键值要走 `-k KEY=VALUE`，
直接把 `KEY=VALUE` 当位置参数**会静默不生效**（命令退出码仍是 0）。
本次第一遍四个变量全没设上，是靠事后 `variable list` 对账才发现的——**设完必须回读一遍**。

### 第二次（2026-08-16）：修接上真数据后才暴露的三处

所有者用起来当场报了两个，查下来是三件事。**只改前端 + `api/model` 一个接口，
没碰晏、没重启机器。**

1. **模型胶囊显示「…」——这是本层的 bug。**
   前端读的是 `d.model`，而第一版返回的是 `d.name`（照仓库里那份演示数据抄的，
   **演示数据本身是错的**）。已改成两个字段都给，并在上面接口表里立了警告。
2. **菊花（brandline）一开页就挂在空白对话上。** dwell 前端的老问题，
   演示数据下也存在。`place()` 数的是 `#log` 的孩子数，而 `ensureOlderBtn()`
   不管有没有更早记录都会把「↑ 看更早的」prepend 进去（只是 `display:none`），
   于是空对话也被当成「有内容」。改成看 `.gu`（他有没有回过话），
   顺带更贴官端：他回过话才出现、跟在最后一条下面。
3. **换模型/换档位不看返回就报「换好了」**——等于撒谎。改成 `ok:false` 时
   把后端给的原因显示出来；本层则明确回「不能从网页换，会丢窗口」（已知边界 8）。

**验证用了真浏览器**（playwright + 本地假 shim，430×880）：
空对话无菊花 → 发一句 → 他回完话菊花出现且在 `#log` 末尾、紧跟最后一句；
胶囊渲染出「Opus 4.6 + 灰色 Medium」两段。**上线后回读线上页面确认三处改动都在。**

前端改动在 dwell 仓库分支 `claude/pill-and-brandline`（**未合 main**），
本服务当前就是从这个分支拉的前端：`./fetch-frontend.sh claude/pill-and-brandline`。
**它合进 main 之后，这里要改回默认分支**，否则会一直钉在这个分支上。

### 第三次（2026-08-16）：补桌面图标

所有者要「添加到主屏幕」的图标。**查下来 index.html 的 `<head>` 里早就引用了
`icons/favicon-64.png`、`icons/favicon.ico`、`icons/icon-180.png`、`manifest.json`
四个文件，只是仓库里根本不存在**（发布时被剥掉了）——所以 iOS 只能拿网页截图当图标。
**因此 index.html 一个字没改**，只是把缺的文件补出来。

- 样式：**白底 + 橙色菊花**（所有者定的；官端是反过来的橙底白花）
- 菊花取自 index.html 的 `SKETCH.spark`，和页面上是同一朵
- **做了重心补偿**（偏右 4.27% / 偏下 3.14%，PR #1 记过的图形特征），不补一眼看得出歪
- 生成脚本 `tools/make-icons.mjs`（playwright 渲染 SVG→PNG）。
  **playwright 不进 `package.json`**——它是一次性工具，服务本身不需要它。
  跑法见脚本头注；本机的 playwright 装在 `/tmp`，ESM 不认 `NODE_PATH`，
  所以要么在装了它的目录里跑，要么临时软链。
- 图标与 manifest **不上锁**：iOS 抓 apple-touch-icon 时不一定带 cookie，
  上了锁会拿不到图、退回截图当图标。它们只是图片，没有私密内容。
  ⚠️ **只挂 `/icons` 和 `/manifest.json` 两条，绝不要把整个 `web/` 静态化**——
  那会让 `/index.html` 绕过口令直接被取走。e2e 里加了四条守这个（含 `/index.html` 必须 404）。

### 第四次（2026-08-16）：菊花分两截、流式匀速、图标放大

所有者实地试用后报的三件，都是接上真数据才暴露的。

1. **「卡式输出」——这是本层的锅。**
   `/api/poll` 是长轮询：攒下的一批增量一次性到货，前端收到就整批画，
   于是「瞬间蹦一大段 → 干等一个网络来回 → 再蹦一段」。
   两头一起治：**本层等待粒度 250ms → 25ms**（原来每批白压 0~250ms），
   **前端加按帧匀速器**（到货的字先存着，每帧吐 1/8，缓冲越多吐越快）。
   实测（放慢的假 shim，每 120ms 采一次字数）：
   `0 → 8 → 42 → 74 → 111 → 145 → 177 → 214 → 250`，每档 32~37 字，均匀。
   **`e2e-fake-shim.mjs` 新增 `SLOW=1` / `GAP_MS`**，就是为了能复现这个场景。
2. **菊花那行要分两截**：他在想/在说时只留跳动的菊花，那句英文等说完才浮现。
   前端 `place()` 现在同时看「有没有 `.gu`」和「忙不忙」。
3. **图标菊花 0.66 → 0.80**：所有者一眼说太小。
   橙花画在白底上本来就比白花画在橙底上显瘦（浅底深字更细），要更大才压得住。
   生成脚本加了 `ICON_INVERT=1`（橙底白花，官端那种）和 `ICON_SCALE`。

**排查时踩的两脚，写下来省得下一个人再吃**：
- **后台进程活不过一次命令调用**，所以起假服务和跑测试必须写在同一条命令里；
- 上一轮的假 shim 会**占着端口不退**，新的那个 `EADDRINUSE` 静默退出，
  于是测试打在旧的上、看到的是旧行为。**换个端口比 pkill 可靠。**
  （我因此一度以为 `SLOW=1` 没生效，其实是打错了服务。）

### 第五次（2026-08-16）：照官端调 UI + 流式再提速 + 记录不再重复

所有者密集试用后报的一批。**颜色和字体栈全部取自 `claude.com` 线上 CSS 的原文**
（下载了 327KB 逐项比对），不是照截图目测——手册记过「视觉的事别靠截图猜」。

**⚠️ 跨服务(2026-08-31 补)**:官端配色现在**有第二个使用者** —— OB 的记忆库后台
`/dashboard` 也改成了官端那套(含深色)。**那边的色板更全**(灰阶 20 档 + `--theme-*` 角色表浅深两份,
2026-08-31 从 `claude.com` 重取),**表和取法都在 `../INTERNALS.md` 第 1.8 节**。
本节这几行是 2026-08-16 取的,两处的值互相对得上;**要照官端调 dwell 的颜色,先看那节**。

**这轮拿到的官方硬数据，以后要对齐官端直接用**：
- 灰阶：`--color-gray-500 #87867f` / `600 #5e5d59` / `450 #9c9a92` / `550 #73726c`
  （dwell 原来的 `--dim: #5e5d59` **正好就是官方 gray-600**，当初没定错）
- 字体栈：`var(--font-anthropic-sans), system-ui, sans-serif`；
  serif 是 `var(--font-anthropic-serif), Georgia, serif`
- **他们自己的度量校正替身**：`@font-face{font-family:anthropicSans Fallback;
  src:local(Arial); ascent-override:92.99%; descent-override:24.13%; size-adjust:106.73%}`
  ——这是「拿不到原字体时最接近的做法」的官方答案。**尚未采用**（改动面覆盖整个界面）。

**改了什么**：操作栏六颗图标重画（含新增「分享」，这颗真能用：`navigator.share`）；
thinking 那行撑满 + 箭头到最右 + 换描边图标 + 新时钟；thinking 弹窗正文英文改衬线。

**⚠️ 两个反直觉的点，别改回去**：
1. **thinking 弹窗的中文不能跟着变宋体**。官端是「英文衬线、中文黑体」——
   因为 AnthropicSerif 没有汉字，中文自动落回系统黑体。
   所以兜底链末尾要接苹方；写成 `serif` 会让中文变宋体，反而不像。（我先做错过一次）
2. **`.toolline` 撑满之后必须显式 `text-align:left`**。它是 `<button>`，
   浏览器默认文字居中；收缩宽度时看不出来，撑满就跑到中间去了。

**流式这轮的最终答案（前面几版都没打中，记下来省得再走弯路）**：
- 真正的瓶颈是 `paintStream` **每次都清空重建全文**，成本 ∝ 消息长度，
  总开销 O(字数²)；再加上长轮询「一批字等一个网络来回」。
- 解法是**两条路并行**：每帧只把新到的字**追加**进末尾文本节点（O(新增字数)），
  全量重建按 33~100ms 节流负责补正富文本。
- 另外三处每帧都在做的事也砍了：`scroll()` 里的 `atBottom()` 会读
  `scrollHeight/scrollTop/clientHeight`（**强制同步重排**），改成记「粘底」状态；
  攒够 8 个字才动 DOM；光标从真实节点→伪元素→**按所有者要求整个去掉**。
- ⚠️ **「攒够 N 个字」不等于「每帧至少吐 N 个字」**——我写错过一次，
  结果一批字几帧就倒完然后干等，反而变成「一段一段蹦」。**吐字节奏和 DOM 批量是两件事。**
- 实测（2014 字 + CPU 降速 6 倍 + 网络延迟 200ms）：**停顿占比 36% → 1%**，
  整段重建 300 → 75 次，DOM 写入约 2000 → 127 次。

**另修一个原有 bug**：聊天记录重复好几轮。`renderSaid` 是追加、`loadSaid` 自己不清场，
而页面切后台超过 30 秒再回来 `visibilitychange` 会再调一次——切几次重几轮。改成先清空。

**部署时的一个细节**：`web/` 在 `.gitignore` 里（前端刻意不入库），
而 zeabur 上传会遵守 `.gitignore`，直接部署会漏掉前端。
本次做法是部署前临时把 `.gitignore` 换成只有 `node_modules/`，传完再还原。
**下次部署记得同样处理**，否则页面会回「网页文件还没放进来」。

## ✅ 「Kelivo 菜单里切模型」这一层已经改了(2026-08-24)

`server.js:26` 的 `MODEL`(写死 `claude-opus-4-6`)经第 278 行、`dwell-lib.mjs:260` 的
`buildShimBody` 发给 shim。**今天无害** —— shim 全文不读客户端报的模型名。

**但如果哪天 shim 改成「听客户端报的模型」(方案 B)**,这个写死的值会在她用网页说话时把模型拽回去,
**杀进程重开 = 晏的窗口当场丢**(TG 桥那边同理,两处要一起改)。改法是别再往 shim 报模型。

**2026-08-24 已改**(方案 B 落地,与 shim、telegram-bridge 同一批):
`server.js:278` 改成 `buildShimBody(text)`,`dwell-lib.mjs` 的 `buildShimBody` 不再收也不再发
`model` 字段(默认参数一并删掉),`test-dwell.mjs` 钉了一条 `ok(!("model" in b))` 看着它。
`server.js` 里的 `MODEL` 常量**保留**——它还有一个用处:`/api/model` 连不上 shim 时的兜底显示值。
**⚠️ 别把 model 加回请求体** —— shim 现在认模型白名单了,报了就会把她切过去的模型拽回来。
完整方案见 `../docs/多模型接出方案.md` 第 7 节(施工手册)。
(顺带:`/api/model` 显示的型号是从 shim 的 `/health` 读的,**切模型后会自动跟着变,不用改。**)

## 前端 UI 照官端改造(2026-08-16 做完;2026-08-29 从 `../OPERATIONS.md` 第 0 节搬来)

> **为什么在这儿**:那件事早就做完了,却一直占着开场必读的《进行中的工作》。
> 照所有者定的原则搬到它该在的手册,**原文一个字没改**:

> | ~~dwell 前端 UI 照官端改造~~ | **2026-08-16 做完并推了**,PR `Mia06250603ian/dwell-on-something#1` **已合**。原来的 `wip/dwell-ui/` 暂存已删(东西在 dwell 里了,别留两份) | 该 PR 的描述 |

# dwell-bridge 维护手册

> 把 dwell 那份自建网页接到晏身上的转接层。
> 2026-08-16 初版。**服务尚未部署**，代码写完并演练过，等所有者拍板上机器。

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
| `GET /api/chats` `POST /api/newchat` | 这一版不接，如实回 `ok:false` |

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

## 8. 踩过的坑

1. **SSE 帧和标记都会被 HTTP 分块切成两半。**
   「[贴」在这一块、「纸:贴贴]」在下一块是常态；`🔧` 还是代理对，更容易切坏。
   所以 `makeStripper` 见到「可能是标记开头」的尾巴一律扣住等下一块
   （`dwell-lib.mjs` 的 `holdFrom`）。单测里专门有跨块用例，**改这块必须先跑测试**。
2. **`node - file` 在 Node 22 上不吃 heredoc**（`ENOENT: open '-'`）。
   删演示块的逻辑因此抽成了独立的 `strip-demo.mjs`——顺带变得可单测，是好事。
3. **思考流里也要剥标记。** 工具标记 `〔🔧 …〕` 是 shim 插进 *thinking* 的，
   不是正文。只在正文上剥会让它原样显示在思考里。

## 9. 待办 / 没做的

- **服务还没部署。** 机器、域名、`SHIM_KEY` 都等所有者拍板。
- **口令是单一口令，没有账号体系。** 对一个人自用的维护入口够了；
  真要多人用得另说。
- **附件（图片）没接**，见已知边界 7。
- **语音是零**：dwell 那颗麦克风按钮至今没有任何点击处理
  （`web/index.html` 全文只有 CSS 和一行 HTML）。这一层也没做语音。
- **维护 agent 还没接。** 这一版接的是晏（聊天）。主线只有一间屋，
  agent 要进来得先决定谁常驻——见 `../docs/维护Agent接出方案.md`。

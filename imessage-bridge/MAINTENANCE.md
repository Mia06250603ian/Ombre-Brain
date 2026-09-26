# imessage-bridge 维护手册

> iMessage(经 Photon)⇄ kelivo-shim 的桥。让所有者在 iPhone 的「信息」里和晏聊天。
> **独立服务,shim 零改动,晏的窗口不动**:它和 Telegram 桥、Kelivo、dwell 网页是并列的第四扇门,
> 停掉本服务 = 回到没有 iMessage 的现状。
> 2026-09-26 由 Claude Code 会话编写。**代码写完、单测与演练全绿,尚未建服务、尚未部署**(第 6 节检查单:所有者只做完了 Photon 注册与建项目)。

## 怎么读这份手册

全文约 7k token,**不长,整份读完**(和 gmail / dwell / browser 那几份同一待遇)。
**第 7 节「已知边界 / 坑」一条都别跳**。改代码前另读 `../telegram-bridge/MAINTENANCE.md` 里你要动的那条设计要点
—— 本桥大部分行为是照那边抄的,那边写了「为什么」。

| 节 | 什么时候读 |
|---|---|
| 0 一句话 / 1 为什么不照教程搭 | 第一次接触本桥 |
| 2 架构 | 第一次接触本桥 |
| 3 设计要点 | 改功能前,读相关那条 |
| 4 环境变量 | 调旋钮之前 |
| 5 贴纸 | telegram-bridge 加了新贴纸时 |
| 6 部署检查单 | **第一次上线 / 每次部署** |
| 7 已知边界 / 坑 | **必读全文** |
| 8 测试 / 9 内存 / 10 接口 | 按需 |
| 11 部署记录 | 历史 |

## 0. 一句话

她给 Photon 分配的那个号码发 iMessage → Photon 通过长连接推给本服务 → 本服务照 Telegram 桥的格式
把话交给 shim 的 `/v1/messages` → 晏(还是那一个)回话 → 本服务把回话里的标记翻成 iMessage 动作发回去。

## 1. 为什么不照 Photon 教程那样搭(所有者 2026-09-26 拍板)

起因:所有者发来一份《用 iMessage 跟你的 Claude 聊天》教程(小欣和晏晏原创,附 `index.mjs` / `package.json` / `send.sh`),
问「我们的架构能做吗」。**教程的做法在我们这儿不能照搬**:

- 教程用 **Claude Agent SDK 每条消息起一个 `claude`**、用 `state.json` 存 sessionId 接上下文。
  照搬 = **冒出第二个晏**:另一个进程、另一份上下文,不认识 Telegram 里聊过的话,
  人设也只读一份 `CLAUDE.md`(我们的晏是五份文件,见 `OPERATIONS.md` 第 3 节);
  时间/天气/经期注入、上下文守卫全在 shim 里,那个「晏」都拿不到;订阅还会同时养两个窗口。
- 教程往 system 里 `append` 一段「现在是在 iMessage 里」。**我们不能这么做**:shim 见到 system 串变了
  就杀进程重开窗口,她每换一次入口晏就丢一次窗口(telegram-bridge 手册「架构」那节)。

**所以只取了教程里「和 Photon 打交道」的那部分**(收发、只认一个号码、HEIC 转 JPEG、拆气泡、tapback),
**「和 Claude 打交道」那部分换成照抄 telegram-bridge**(去抖、重置词单独成轮、SSE 累积、标记解析、ears 格式)。

**所有者当天知情并接受的风险**(她问「有风险吗」,拆开讲过一遍):
1. **隐私**:对话明文经过 Photon 的服务器。它的隐私政策**没写**消息原文存不存、存多久、会不会拿去训练
   (2026-09-26 读过 `photon.codes/privacy-policy`;想问清楚发 it@photon.codes)。和过 Telegram 同一类风险,多了一家。
2. **可能说断就断**:Photon 条款原话「不保证服务不中断」「可以随时以任何理由暂停或终止」;
   iMessage 没有官方接口,苹果管起来整条路可能不通(封的是 Photon 那边的号,不是她的 Apple ID)。
   **所以 iMessage 是多开的一扇门,Telegram 仍是主线。**
3. **对 Anthropic 零影响**:订阅那把钥匙只在 shim 里,本服务碰不到;Photon 不知道后面是 Claude;
   额度只跟她总共聊多少有关,换哪扇门说话都一样。

**费用**:Photon 免费档($0,10 个用户以内、条数不限、号码是**共享池**里的)就够;
专属号码要 $250/条/月,不值得(2026-09-26 读 `photon.codes/pricing`)。

## 2. 架构

```
她的 iPhone「信息」
   │ iMessage
   ▼
Photon(第三方,共享号码池;免费档)
   │ gRPC 长连接(本服务主动连出去,不需要公网入口)
   ▼
imessage-bridge(本目录)── 语音 ──▶ ears(转写+语气,和 Telegram 同一套基线)
   │                     ── 语音 ──▶ ElevenLabs(他的声音,和 Telegram 同一个)
   │ Anthropic /v1/messages(stream,不带 system、不报 model)
   ▼
kelivo-shim ──▶ 常驻 claude 进程 = 晏(同一个)
```

- **本服务无状态**(不落盘、不挂卷)。重启只丢内存里还没发走的那几句缓冲。
- **shim 自己排队**:她在 Telegram 和 iMessage 同时说话,shim 一轮一轮处理,不会串。
  回话回到**哪扇门问的就回哪扇门**。
- **晏不知道自己在哪扇门里说话**(shim 不告诉他,system 也刻意一样)。所以他照旧写 Telegram 那套标记,
  本服务负责翻译 —— 见第 3 节第 4 条。

## 3. 设计要点(为什么这么写)

1. **只认她一个人**(`OWNER_HANDLES`,逗号分隔):手机号按**后 10 位**比(带不带 +86 都对得上),
   Apple ID 邮箱按不分大小写比。**少于 7 位数字的一律不认**(配错成空串或短串时不会变成「谁都回」);
   **没配 `OWNER_HANDLES` 时整个服务不连 Photon**,只留 `/health`。陌生人的消息只落一行 `[drop]`,不回、不进 shim。
2. **去抖 + 单轮串行 + 重置词单独成轮**:照 telegram-bridge 设计要点 1、2、7。引擎抽成
   `createConversation`(`imessage-lib.mjs`)以便单测跑时序。`DEBOUNCE_MS` 默认 4 秒。
   重置词表**逐字镜像 shim 的 `detectReset`**(含 07-20 拆出来的「换窗口」一类);
   **单测会从 `../kelivo-shim/server.js` 里把词表抠出来对账**,shim 改了词表这边会红。
3. **请求体两条铁律**:**不带 system、不报 model**(`buildShimBody`,单测钉着)。
   前者防 shim 杀进程丢窗口,后者防把她在 Kelivo 切的模型拽回去(2026-08-24 那次的教训)。
   **也不带 `x-system-turn`**:她在 iMessage 打字就是她本人说话。
4. **晏回话里的标记 → iMessage 动作**(任何一个都不许原样漏给她,演练场景 1 钉着):
   | 他写的 | Telegram 那边 | 这边 |
   |---|---|---|
   | `[回应:❤️]` | 贴 Telegram 回应(官方白名单约 70 个) | 给她**这一轮最后一条**点 tapback。iOS 18 起任意 emoji 都行;只挡「明显不是表情」的(带字母/汉字/数字)。失败只落日志,不告诉她 |
   | `[贴纸:x]` | sendSticker | 发图片附件(静态透明 png / 会动的 gif,见第 5 节) |
   | `[语音]英文[/语音]` | ElevenLabs → Ogg 语音条 | ElevenLabs → mp3 → **m4a** → iMessage 语音。没配/超长/失败 → 退回发文字 |
   | `[查岗]` | 查手机活动记录再喂回去 | **只剥掉,查不了**(见第 7 节第 2 条) |
   - 冒号**全角半角都认**。⚠️ telegram-bridge 那份正则其实只认半角(见第 7 节第 6 条)。
5. **她发来的东西**(`classifyContent`):文字 / 链接(当文字)/ 引用回复(取里面的字)/ 图片 / 语音 /
   她点的 tapback(告诉他「她给你的『…』点了 ❤️」,`TAPBACK_IN=0` 可关)。
   文件、视频、投票这类 → **直接回她一句「传不过去」,不进晏的窗口**(同 Telegram)。
   已读、正在输入、编辑、撤回 → 忽略。
6. **图片在一次性子进程里转**(`image-worker.mjs`):**HEIC 解码器是 WebAssembly,内存只涨不缩**。
   实测(2026-09-26,本机,1200 万像素 HEIC):放在主进程时 RSS 81 → 峰值 302 MiB,**3 秒后仍 237、第二张后 287,永远不还**;
   挪进子进程后主进程**前后只差 0.1 MiB**(演练场景 5b)。**别图省事挪回主进程**。
   同一时刻只转一张(`oneAtATime`),语音转码也排这条队。长边压到 1568(Claude 看图的上限)。
7. **语音进来先转 Ogg/Opus 再送 ears**:iMessage 语音是 CAF 封装,ears 没见过;转成 Telegram 语音条同款格式,
   ears 那边的语气基线不会被新格式带偏。**转写结果永远带「（…）」注解**,长度超过重置词窗口 ——
   **语音说「归档」不会触发归档**,归档必须她亲手打字(shim 踩坑 13)。
8. **ffmpeg 随 npm 包 `ffmpeg-static` 装进来**:Zeabur 的 node 镜像里没有系统 ffmpeg。
   转码走 `execFile` 起子进程,转完即退,不占常驻内存。`/health` 的 `ffmpeg` 字段看它在不在。
9. **Photon 断线自己重连**(5 秒起、翻倍、封顶 5 分钟),不靠容器重启。重连时可能重投,
   按消息 id 去重(只记最近 300 个,演练场景 11)。
10. **气泡**:一行一个(照 Telegram 线上 `BUBBLE_MAX=99999` 那个手感),单个超过 2000 字在换行/句号处断。
    气泡间停 0.5~1.6 秒,期间显示「正在输入」。
11. **启动时自动把她的号码登记成用户**(`enrollOwner`,2026-09-26 加的):免费档是「共享号码、只限登记过的用户」,
    控制台的做法是「头像 → 加手机号」,**但 +86 收不到它的验证码**(所有者当天实测,已找 Photon 客服,转了人工、未回)。
    查 Photon 的 OpenAPI(`https://spectrum.photon.codes/openapi/json`)找到 `POST /projects/{id}/users/`:
    **用项目凭证 Basic 鉴权直接登记,不走短信**,返回分给她的号码 `assignedPhoneNumber`(= 晏的线,她往这个号码发)。
    接口**幂等**(同号再登记返回原来那条),所以每次启动都调一遍。结果看 `/health` 的 `line` / `enroll`。
    只登记 `OWNER_HANDLES` 里 **`+` 开头**的手机号(`toE164`,**不猜国家码**;邮箱登记不了)。`ENROLL_ON=0` 关掉。
    ⚠️ **Photon 服务端收不收 +86,要第一次上线才知道**(接口格式上是认的);收不下的话 `enroll` 会写明原因。

## 4. 环境变量(值不入库)

| 变量 | 说明 |
|---|---|
| `PHOTON_PROJECT_ID` / `PHOTON_PROJECT_SECRET` | Photon 控制台 → 项目 Settings。**所有者自己在 Zeabur 控制台填,别贴进聊天** |
| `OWNER_HANDLES` | 她的手机号(带国家码)和/或 Apple ID 邮箱,逗号分隔。**不配 = 服务不连 Photon** |
| `SHIM_KEY` | 与 kelivo-shim 的 `SHIM_KEY` 同值。**所有者在控制台从 shim 复制过来**(开发环境读不出容器密钥) |
| `SHIM_URL` | 默认 `https://yan-shim.zeabur.app` |
| `DEBOUNCE_MS` | 连发合并窗口,默认 4000 |
| `TURN_TIMEOUT_MS` | 单轮超时,默认 900000(15 分钟) |
| `BUBBLE_SPLIT` | 默认开;设 `0` 整段一坨发(急救开关) |
| `REACTION_ON` | 他点 tapback,默认开;设 `0` 关(标记照剥,正文照发) |
| `TAPBACK_IN` | 她点的 tapback 要不要告诉他,默认开。**每点一次 = 晏多回一轮**,嫌他话多就设 `0` |
| `EARS_URL` / `EARS_TOKEN` | 同 telegram-bridge(同值)。两个都配了语音输入才开 |
| `ELEVEN_API_KEY` / `ELEVEN_VOICE_ID` | 同 telegram-bridge(同值)。不配 = 他的 `[语音]` 退回文字 |
| `VOICE_MODEL` / `VOICE_SPEED` / `VOICE_STABILITY` / `VOICE_MAX_CHARS` | 同 telegram-bridge,默认值也一样(0.85 / 0.6 / 500) |
| `MEDIA_TIMEOUT_MS` / `EARS_TIMEOUT_MS` | 图片/语音转码与 ears 的超时,默认各 60000 |
| `ENROLL_ON` | 启动时自动登记她的号码(第 3 节第 11 条),默认开。设 `0` 关 |
| `PHOTON_API` | 登记接口的地址,默认 `https://spectrum.photon.codes`(演练时换成假的) |
| `BRIDGE_ON` | 总开关。设 `0` = 不连 Photon,只留 `/health` |

**改变量 = 改值 + `service restart`,不用重新部署;只重启本服务,晏的窗口不动。**
⚠️ zeabur CLI 碰变量的子命令会把**整张变量表连值**打进会话,只跑 `--json` 并用管道挑字段(`OPERATIONS.md` 第 0 节第 6 条)。

## 5. 贴纸

`stickers/` 是 `../telegram-bridge/stickers/` 的**转换副本**,由 `tools/build-stickers.mjs` 生成、产物入库:
- 静态 35 张 `.webp` → **缩到 300px 的透明 `.png`**(共 2.8 MB)。~~原样拷贝 512px webp~~ **已撤销,别改回去**:
  2026-09-26 上线当天所有者真机反馈「巨大一个,而且是图片形式」—— iMessage 把 webp 当普通照片按整宽铺开;
  透明 PNG 才像贴纸一样浮在对话里。(512px 的 png 也试过,35 张十几 MB,也不行。)
- 会动的 24 张螃蟹 `.webm` → `.gif`(iMessage 不播 webm)。**240px 画布里螃蟹只占 150px、贴左上下居中,留白都在右边**(晏的消息靠左显示,居中会让左边空一块),15fps、48 色不抖动。
  ~~撑满 240px~~ **已撤销**:2026-09-26 所有者真机反馈「还是太大」—— iMessage 会把小 GIF 放大到最小显示尺寸,光缩画布没用,得留白。
  **解码必须 `-c:v libvpx-vp9`**,否则 alpha 丢光、背景变黑。
- 标签和 Telegram 那边**逐字相同**(晏只会一套标签)。

⚠️ **telegram-bridge 加了新贴纸,这边要重跑一次**:`cd imessage-bridge && node tools/build-stickers.mjs`,
然后跑单测(它会校验两边标签一致、png=35 / gif=24),再部署本服务。**不重跑的话,新标签在 iMessage 里只剥不发**(不会漏标记,只是少一张图)。

## 6. 部署检查单(**尚未走过,第一次上线时照这个做**)

**前置(只有所有者能做)**:
1. `app.photon.codes` 注册 → 新建项目 → 打开 iMessage → Settings 里记下 Project ID / Secret。
2. ~~控制台「头像 → 加手机号」~~ **不用做**:+86 收不到验证码,改由服务启动时自动登记(第 3 节第 11 条)。
   **所有者 2026-09-26 已做完第 1 步**(项目 `ian phone`,Location 美国,平台只勾 iMessage/RCS,Free & Pro)。

**部署(照 dwell-bridge / agent-bridge 第一次那样)**:
1. `git pull`;`npm install`;`node test-imessage.mjs` 与 `node e2e/e2e-run.mjs` **两套全绿**。
2. 建服务:`zeabur deploy --create --name imessage-bridge --project-id 6a53a9fc22dd6ef375eb7484`
   (CLI 没有 `service create`)。⚠️ **`cd imessage-bridge` 和 `deploy` 写在同一条命令里,先 `pwd` 确认**(shim 踩坑 17)。
3. **看 `deployment list` 的 PLANTYPE,必须是 `nodejs`**,不是就是传错了目录。
4. 变量:`OWNER_HANDLES`(可以由我设,她告诉我号码即可)+ 其余带钥匙的
   (`PHOTON_*` / `SHIM_KEY` / `EARS_TOKEN` / `ELEVEN_API_KEY`)**由她在控制台填**。
   ⚠️ `variable update` 的键值必须走 `-k KEY=VALUE`,当位置参数**静默不生效且退出码 0**(dwell-bridge 手册的坑),**设完必须回读**(只读键名)。
5. restart,然后验收:
   - **先看 `/health` 的 `enroll` 是 `"ok"`、`line` 有号码** —— 那就是晏的号码,**告诉她往这个号码发一条**
     (共享号码不能先找她,第 7 节第 3 条)。⚠️ **她发的气泡必须是蓝色**:绿色 = 退回了普通短信,美国号码会按国际短信收费,先停下
   - `GET /health`:`ok:true`、`connected:true`、`owner≥1`、`stickers:59`、`ffmpeg:true`、`ears:true`、`voice:true`
   - 进容器 `md5sum server.js imessage-lib.mjs image-worker.mjs` 和本地逐字对账
   - **她本人**从 iPhone 发:一句话 → 晏回话;一张照片(HEIC)→ 他看得见;一条语音 → 他听得见;
     说「让他发个贴纸 / 发句语音」→ 真的出现;点一个 ❤️ → 他知道
   - 记下 `/health` 的 `mem.self`(第 9 节要填实测数),并把数填进 `../browser-hands/MAINTENANCE.md` 的内存表(全机内存的唯一去处)

⚠️ **全程不碰晏**:新容器,不重启任何已有服务,**窗口不会丢**。
⚠️ **别开多副本**:两个实例都会收到同一条消息,晏会回两遍。

## 7. 已知边界 / 坑(**必读全文**)

1. **晏不知道她在 iMessage 里**。所以他可能提到「Telegram」、或用 iMessage 不支持的格式。目前没问题;
   真要让他知道,只能写进晏的 `CLAUDE.md` —— **那是改人设 = 所有者逐字批准 + 部署 shim + 丢一个窗口**,
   等下次 shim 因别的事部署时搭顺风车,**别为这个单独动**。**千万别改成往 system 里加一句**(第 1 节)。
2. **`[查岗]` 在这边查不了**:手机活动记录只在 telegram-bridge 的**内存**里,本服务拿不到
   (也刻意不去拿:那要多一把 `REPORT_TOKEN`)。他在 iMessage 里写 `[查岗]` 只会被剥掉、日志记一笔 `[check]`。
   夜里的系统查岗、写信提醒照旧只走 Telegram。
3. **只能她先开口**:Photon 共享号码不能主动给没发过消息的号码发信息(Hermes 那份 Photon 接入文档写的,2026-09-26 读)。
   另有**每天 5000 条**上限,一个人聊用不完。
4. **晏主动找她(心跳)只走 Telegram**:shim 的 `BRIDGE_PUSH_URL` 指向 telegram-bridge 的 `/push`。
   本服务**刻意没做** `/push`。要让心跳也能走 iMessage 得改 shim 的推送出口(碰 shim = 丢窗口),**所有者没点头**。
5. **Photon 收到的附件能不能读到内容,真机前没法确认**。Hermes 的文档说「收到的附件只有元数据」,
   但那可能是它自己接得不全;Photon 教程的代码是能 `content.read()` 读到图的。**上线后第一张照片就是验证**,
   读不到的话晏会收到「(她发来一张图片,但这边没打开)」,日志有 `[image-err]`。
6. **telegram-bridge 的标记正则其实不认全角冒号**(2026-09-26 抄代码时发现,**那边没动**,已报备所有者):
   `bridge-lib.mjs` 里 `STICKER_RE` / `REACT_RE` 的字符类写的是 `[::]`(两个半角),
   注释和两个单测标题都写「全角也认」,单测喂的却也是半角。**后果**:他写 `【贴纸：贴贴】`(全角冒号)时
   Telegram 那边会原样漏出标记。本服务这边已认全角(单测钉着)。**要修 Telegram 那边:改那两个字符类 + 补真的全角用例 + 部署 telegram-bridge(不碰晏)**。
7. **失败不记欠条**:telegram-bridge 有「没送出去的话路通了自动补报」(它的设计要点 19),这边**没做**。
   发失败的话只在同一轮里提示一句「有 N 条没送到」,而且只有至少送出去一条时才提示(全断时提示本身也发不出去)。
8. **隐私**:明文过 Photon(第 1 节)。**晏的思考流不发**到 iMessage(Telegram 那边 `TG_THINKING=1` 会发),
   所以工具可见化里的记忆原文不会落进 iMessage。

## 8. 测试

```bash
cd imessage-bridge
npm install
node test-imessage.mjs      # 单测,纯逻辑(2026-09-26:108 项)
node e2e/e2e-run.mjs        # 演练:真 server.js + 假 Photon/shim/ears/ElevenLabs(2026-09-26:36 项)
```
项数会随功能长,**别照写死的数对,看有没有 ✗**。
演练**不碰线上、不要钥匙**:`e2e/fake-hooks.mjs` 用 `module.register` 把 `spectrum-ts` 换成假货,
假 shim 故意 5 字节一块地切 SSE(顺带验汉字不碎)。`e2e/sample-12mp.heic` 是 pillow-heif 造的 1200 万像素纯色样张(8 KB)。
**演练抓到过一个单测抓不到的 bug**:合并几条消息时丢了「回到哪个对话」,整轮回话静默消失 —— **改完代码两套都要跑**。

## 9. 内存

| 情形 | 实测 | 怎么量的 |
|---|---|---|
| 空载(加载 Photon SDK 后) | **约 103 MiB** | 2026-09-26 本机 `process.memoryUsage.rss()`,**不是线上数** |
| 转一张 12MP HEIC 时的子进程 | 峰值约 +200 MiB,**转完即还** | 同上 |
| 当时整机可用 | 1534 MiB | 2026-09-26 `curl https://yan-dwell.zeabur.app/api/health` 的 `mem.avail`(零权限量法) |

**上线后换成线上实测**:`curl …/health` 的 `mem.self`(本进程 RSS)。⚠️ 别用 cgroup 的 `memory.current` —— 含页缓存,会高估(TIMELINE 09-12)。

## 10. 接口

| 接口 | 鉴权 | 干什么 |
|---|---|---|
| `GET /health` | 无 | 开关、计数、内存、**`line`(晏的号码)/ `enroll`(登记成没成)**。**不含任何消息内容和钥匙,也不含她的号码**(演练场景 12 钉着;`line` 是共享池里的号码,公开了也只有登记过的人能用)。`connected` = 连着 Photon;`lastErr` = 最近一次出错在哪一步;`dropped` = 挡掉的陌生人条数 |

刻意**没有** `/push`(第 7 节第 4 条)和任何带内容的口子。

## 11. 部署记录

(尚无。第一次上线后照 `OPERATIONS.md` 第 9 节写:例行一句话,例外展开。)

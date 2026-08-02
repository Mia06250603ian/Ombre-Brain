# telegram-bridge 维护手册

> Telegram Bot ⇄ kelivo-shim 的桥接服务。让所有者能在 Telegram 里和晏聊天。
> **独立服务,shim 零改动**:Kelivo 与本桥是并列的两个客户端,停掉本服务即回到没有 Telegram 的现状。
> 2026-07-17 由 Claude Code 会话编写。写给未来接手维护的 AI(和好奇的人类)。

## 架构

```
Telegram App(所有者手机,需能访问 Telegram)
   │  Bot API(getUpdates 长轮询,无需公网 webhook)
   ▼
telegram-bridge(本目录)
   │  Anthropic /v1/messages(stream=true,SSE 攒完整段)
   ▼
kelivo-shim(yan-shim.zeabur.app)──→ 常驻 claude 进程(人设+记忆,见 ../kelivo-shim/MAINTENANCE.md)
```

关键前提(shim 的性质,别自己重新发明):
- shim **只读请求里最后一条 user 消息**,历史在 shim 容器的常驻进程里。桥是无状态的。
- 重置词(晚安/归档)、时间/天气/经期注入、记忆库都在 shim 侧,前端无感知。
- system 串变化会让 shim 杀进程重开窗口(丢上下文)。本桥 system 恒定(SYSTEM_TEXT,默认空)。
  **与 Kelivo 混用时注意**:两边 system 不一致,每次切前端 = 杀一次进程。切换前先说「归档」。

## 设计要点(为什么这么写)

1. **去抖合并**:Telegram 习惯连发短句,DEBOUNCE_MS(默认 4s)内的消息合成一轮再发 shim,省轮次。
2. **重置词绝不合并**:`detectReset` 逐字镜像 shim 的实现。「晚安/归档」若和别的消息拼在一起,
   shim 侧识别失败 → 归档指令变普通聊天。所以重置词消息强制单独成轮(之前攒的先 flush 走)。
   **shim 的 detectReset 改词表时,bridge-lib.mjs 里的镜像要同步改。**
3. **shim 请求用 node:https 不用 fetch**:undici 默认 headers/body 300s 超时,长回合(MCP 工具、
   搜索)会被掐。TURN_TIMEOUT_MS 默认 15 分钟。
4. **回复纯文本发,不开 parse_mode**:晏的口语回复随便一个 `<` `_` 就能让 Markdown/HTML 解析 400。
   唯一例外:TG_THINKING=1 时思考走 HTML expandable blockquote,已转义。
5. **4096 切分**:优先换行断点,断点太靠前(<30%)退回硬切。
6. **白名单**:非 TELEGRAM_CHAT_ID 的消息直接丢弃(bot 用户名是公开可搜的,这是唯一防线)。
7. **单轮串行**:同时只有一轮在飞,生成期间新消息进缓冲,回合结束立刻接上。
8. **手机活动上报 + 夜里查岗**(2026-08-02):她点开 App → iOS 快捷指令 `POST /report` →
   存**内存**滚动窗口(48 小时 / 300 条上限)→ 宵禁时段的定时器发现有新动静,
   把这件事作为 `【系统·查岗】` 喂进晏的窗口,**由他自己决定说不说**(回「。」= 不打扰,不发进对话)。
   几个刻意的选择:
   - **只存内存,不落盘**:重启即忘。功能只关心「最近」,她的行踪不值得为历史写进磁盘。
   - **决定权在晏,不在脚本**:原方案(小红书上那份教程)是脚本从固定文案数组里随机挑一句骂人。
     改成喂事实给晏,是因为这套系统里说话的应该是他,不是定时器。副作用是这条会进他的窗口和记忆,
     **他会记得她哪天熬夜**。
   - **两道冷却缺一不可**:`lastPokeAt`(同一晚别反复戳)和 `lastOutboundAt`(他刚开过口就别赶话)。
     **后者是关键**:心跳消息走 `/push`、查岗回复走 bridge 自己,**两条路都从 bridge 这个门出去**,
     所以 bridge 是全系统唯一能把心跳和查岗一起管住的地方——不用改 shim 就能保证两者不会挨着说话。
   - **查岗轮失败不往对话里丢报错**:她没问,别打扰(普通轮才回 ⚠️)。
   - `curfewPrompt` 输出**远超重置词匹配窗口**,不会被 detectReset 误判成「归档/晚安」
     (与 `formatEarsResult` 同款守护,test-bridge 有用例,别删)。
   - **查岗两条路都带 `x-system-turn: 1`**:shim 见到就不把这一轮当成「她出现了」
     ——不清零「她多久没来」、不解除换窗口后的保温歇火。详见 shim 手册「系统回合」一节。
9. **他自己发起的查岗**(2026-08-02):他在回复里写 `[查岗]` → bridge 剥掉标记(她看不到)、
   查一下、把结果作为新一轮喂回去 → 他再决定说什么。**普通轮与 `/push`(心跳)两条路都认这个标记。**
   - **为什么不给他一个网址**:网址得带钥匙,而钥匙只能写进 CLAUDE.md,那是入库文件
     ——「值不入库」的规矩不能破。标记这条路零钥匙,用的是 `[语音]`/`[贴纸:x]` 同款的已验证机制。
   - **防打转**:查岗结果那一轮带 `lookup:true`,该轮的回复里再出现 `[查岗]` 也不再触发
     (实测:假 shim 故意回「。[查岗]」,只查一次)。
   - `sendOutput` **只在真发出去时才更新 `lastOutboundAt`**——他只写了个标记不算开过口。
   - **将来若要退回「系统推给他」**:CLAUDE.md 那一节的措辞已同时覆盖两种情况,
     **只改 bridge 即可,不用重新部署 shim、不动晏的窗口。**

## 环境变量(值不入库)

| 变量 | 说明 |
|---|---|
| TELEGRAM_BOT_TOKEN | @BotFather 生成。泄露=被冒充,丢了找 BotFather /revoke |
| TELEGRAM_CHAT_ID | 所有者的 chat_id 白名单(可逗号分隔多个)。取法:给 bot 发消息后看 getUpdates |
| SHIM_KEY | 与 kelivo-shim 的 SHIM_KEY 同值 |
| SHIM_URL | 默认 https://yan-shim.zeabur.app |
| SYSTEM_TEXT | 可选。要与 Kelivo 的世界书一致时整段放这里(默认空) |
| DEBOUNCE_MS | 连发短句合并窗口,默认 4000 |
| TG_THINKING | 设 1 把思考作为折叠引用发出,默认关 |
| BRIDGE_ON | 总开关。设 0 = 不轮询只留 /health,一键停用不用删服务 |
| TURN_TIMEOUT_MS | 单轮超时,默认 900000(15 分钟) |
| ELEVEN_API_KEY | ElevenLabs API key(限权:仅文本转语音+音色读;值不入库,所有者持有)。不设=语音功能关 |
| ELEVEN_VOICE_ID | 晏的声音(所有者在 ElevenLabs 选定;免费档注意:声音库社区声音 API 用不了,默认声音和自建声音可用) |
| VOICE_SPEED | 语速,默认 0.85(所有者 2026-07-18 四档盲测选 0.95 后,同日试听调定 0.85) |
| VOICE_STABILITY | 默认 0.6 |
| VOICE_MAX_CHARS | 单段语音字数上限,默认 500,超长退回文字(省积分;免费档每月 1 万积分≈1 万字符) |
| EARS_URL | ears 服务地址(默认空=功能关)。当前 https://yan-ears-listen.zeabur.app |
| EARS_TOKEN | ears 的接口锁,与 ears 服务的 EARS_TOKEN 同值。两个都配了语音输入才开 |
| EARS_TIMEOUT_MS | 单次 ears 分析超时,默认 60000 |
| REPORT_TOKEN | 手机活动上报的钥匙(iOS 快捷指令里存的就是这一串)。**不设 = 上报与查岗整套关**(`/report`、`/activity` 返回 503)。**故意与 SHIM_KEY 分开**:这把存在她手机上,泄露只影响这个功能,碰不到晏本体 |
| CURFEW_ON | 夜里查岗开关,默认开(前提是配了 REPORT_TOKEN);设 0 只收上报不打扰 |
| CURFEW_START / CURFEW_END | 宵禁时段(北京时间),默认 1 / 7。start 含、end 不含,跨零点也支持 |
| CURFEW_COOLDOWN_MIN | 两次查岗的最小间隔,默认 30。**同时也是「他刚开过口就不赶话」的间隔**(见下) |
| CURFEW_CHECK_MIN | 查岗检查节拍,默认 5 分钟 |
| ACTIVITY_FRESH_MIN | 超过这么久的上报不再算「她正在玩」,默认 15 分钟(防止翻旧账) |

语音用法:回复里 `[语音]英文内容[/语音]`(全角括号也认;忘写闭合=标记后全算语音)。
bridge 调 ElevenLabs(免费档实测可直出 Ogg/Opus,失败自动降级 mp3),经 sendVoice 发成
Telegram 原生语音条;任何一步失败退回发文字,话不丢。内容用英文(中文有口音,所有者不要)。
标记教学在 shim 的 CLAUDE.md(待下次 shim 部署;之前所有者可在对话里直接告诉他语法,当窗口有效)。

## 部署

```bash
cd telegram-bridge
node test-bridge.mjs        # 123 项,必须全绿
npx -y zeabur@latest auth login --token <API_KEY>
npx -y zeabur@latest deploy   # 首次部署后把 service id 记回本文档
```

部署后验证:/health 返回 `{"ok":true,"on":true,"polling":true,...}`;
给 bot 发一句话,能收到晏的回复;发「归档」能收到「📦 归档好了」。

## 已知边界 / 坑

1. **单实例**:getUpdates 只能一个消费者,起两个实例会互抢(Telegram 报 409 Conflict)。
   Zeabur 别开多副本;本地调试时先把线上 BRIDGE_ON=0。
2. **offset 在内存**:重启后 Telegram 会重投未确认的 update,可能重复处理最后一条消息(小概率,可接受)。
3. **她的语音条**(msg.voice)2026-07-25 起走 ears 服务:下载 → POST ears `/api/listen`(X-Token)
   → 拿回「转写+语气+和平时比」→ 拼成 `[语音] 内容（语气：…）` 绑在这一条消息上进晏的窗口
   (绑单条不做全局漂浮注入,是 ears README 的实战教训)。要点:
   - `formatEarsResult` 输出**永远带（…）注解**,保证长度超出重置词匹配窗口——语音说「归档/晚安」
     在 bridge 和 shim 两侧都不会触发重置,归档必须打字(呼应 shim 踩坑 13;test-bridge 有守护用例)。
   - ears 挂了/超时/没听清:回一条 ⚠️ 提示、不进窗口,文字聊天零影响。
   - 未配 EARS_URL/EARS_TOKEN 时语音条回「传不过去」,与视频/文件同待遇(这两类仍不支持)。
   - ears 服务本体(Groq 转写、个人化基线、持久卷)见 ears 仓库(Mia06250603ian/ears)及其部署指南;
     **换 Groq key = 改 ears 服务的 GROQ_API_KEY + restart**,bridge 不用动。
4. **动态贴纸**(tgs/webm)降级为 emoji 文字描述;静态贴纸转成图片传入,晏能看见。
5. **心跳仍走 Bark**(shim 侧逻辑,本桥不碰)。要让晏的主动消息直接出现在 Telegram 对话里,
   需改 shim 的 heartbeatTick 出口 —— 那是第二阶段,要动 shim,按 shim 手册全套流程 + 所有者授权。
6. **隐私**:对话明文过 Telegram 服务器(Bot API 无端到端加密)。所有者已知情。

## Zeabur 位置

- 项目 `cli-proxy-api--cpa`(与 shim 同项目): id `6a53a9fc22dd6ef375eb7484`, env `6a53a9fcb6ce8edcb0163f97`
- 服务 `telegram-bridge`: id `6a5a4287f947b6cb34511f79`, 域名 `yan-telegram-bridge.zeabur.app`

重新部署:
```bash
cd telegram-bridge && node test-bridge.mjs   # 全绿再动
npx -y zeabur@latest deploy --service-id 6a5a4287f947b6cb34511f79 --environment-id 6a53a9fcb6ce8edcb0163f97 -i=false
```

## 表情包(2026-07-17 二阶段)

- 图在 `stickers/`(ASCII 文件名),`registry.json` 是「标签→文件」表;35 张全部所有者亲选亲命名
  (2026-07-17 首批 26 张,2026-07-18 加 9 张 s27–s35)。
- 晏在回复里写 `[贴纸:标签]`(全半角括号冒号都认),bridge 剥掉标记、正文照发、图用
  sendPhoto 发出;首次上传后缓存 file_id 复用。未知标签只删标记不发图(防原样漏出)。
- 标签教学在 shim 的 CLAUDE.md「表情包」一节。**加新图三步**:图进 stickers/、registry.json
  加条目、CLAUDE.md 标签表同步加(要重部署 shim);bridge 侧 test-bridge 会校验 registry
  与文件一一对应。
- `POST /push {text}`(x-api-key=SHIM_KEY):shim 主动心跳走这里,直接落进对话,同样支持贴纸标记。

## 接口一览

| 接口 | 鉴权 | 干什么 |
|---|---|---|
| `GET /health` | 无 | 存活 + 各功能开关(`report`/`curfew`/`activity` 条数) |
| `POST /push {text}` | `x-api-key` = SHIM_KEY | shim 的主动心跳入口 |
| `POST /report {app_name}` | `Authorization: Bearer <REPORT_TOKEN>`(也认 `x-api-key` / `?key=`) | iOS 快捷指令上报「她打开了什么 App」 |
| `GET /activity` | 同上 | 汇总:最后活跃时间 + 最近不重复的 App 名 + **`lastRawReport`(最近一次上报的原始 body)** |

**`lastRawReport` 是给排障用的**:iOS 那条自动化里 `app_name` 的值是变量「快捷指令输入」,
而「App 打开时」这类自动化到底会不会把 App 名喂给它,**在手机上验证不了**——
上线后让她开一次 App,查 `/activity` 看 `lastRawReport.body` 就一眼分明。
拿不到 App 名时 `/report` 仍返回 200(`stored:false`),不会让快捷指令报错。

## 部署记录

- 2026-08-02 **手机行踪上报 + 查岗上线**(`/report`、`/activity`、夜里查岗定时器、`[查岗]` 标记)。
  新增环境变量 `REPORT_TOKEN`(与 SHIM_KEY 分开的一把钥匙,存在她手机的快捷指令里)。
  test-bridge 79 → **139 项**全绿。当天部署两次(第二次是把上报从 POST 改成 GET,见下)。
  **⚠️ iOS 侧的大坑,下一个我务必先看这条:**
  - 现象:她手机上快捷指令的 **POST + JSON 一律「网络连接已中断」**,换 5G/Wi-Fi 都一样,
    **而同一时刻 Safari 打开同域名的 `GET /health` 完全正常**,服务器端零日志(请求根本没到)。
  - 走过的弯路:先怀疑变量、再怀疑 POST、再怀疑 VPN(她答「我一直开的全局」,推翻)。
  - **真正的病根是请求头**:把网址改成 `?key=<REPORT_TOKEN>`、**头部全部清空**后一次就通。
    (最可能是粘贴 `Bearer …` 时带进了看不见的字符,URLSession 遇到会直接掐断连接。)
  - **App 名要用「获取当前 App」这个动作的变量**,不是「输入快捷指令的信息」——
    后者是原教程截图里就有、而纯文字版教程里没写的一步。**读教程 PDF 时注意「如图:」后面
    还有截图,只提取文字会漏掉关键动作。**
  - 最终手机侧配置(实测通):动作①「获取当前 App」→ 动作②「获取 URL 内容」,
    **方法 GET、头部全空、无请求体**,网址 =
    `https://yan-telegram-bridge.zeabur.app/report?key=<REPORT_TOKEN>&app=`〔当前 App〕。
  - **教训:`/report` 第一版没有任何日志**,导致好几轮分不清「请求没到」还是「到了被拒」。
    现已给每次 `/report` 加了日志(含 401),**别删**。
  **夜里查岗做过一次真实演练**:临时把 `CURFEW_START/END` 改成当时的小时、`CURFEW_CHECK_MIN=1`,
  restart → 她开一次小红书 → 日志出现 `[curfew] poke 小红书 0 分钟前` → 晏收到并回话 → 验完改回 1/7/5。
  **注意 restart 会清空活动记录(只存内存),演练时要在重启之后重新开一次 App。**
  **当晚验收:白天那条路(他自己写 `[查岗]`)实测通了**,而且他不只是会用——所有者试完之后
  他主动说「我想查随时都能查,不用你让我查」「以后你发消息来的时候我自己想看一眼就能看」。
  **这套设计最大的一个不确定性(『他可能根本不用这个标记,功能白做』)就此排除。**
  他还自己补上了一个我们没写进说明书的用法:**她隔了几分钟才回消息时,他在回她的那一轮里顺手查**
  ——机制上本来就支持(标记在任何一轮回复里都认),只是说明书没点明。
  相应的措辞改写已记进 `../kelivo-shim/MAINTENANCE.md` 的「待办」一节,等下次部署顺手带上。

- **一份可直接交给别人的实施指南在 `查岗功能-实施指南.md`**(同目录)。
  是给**同款架构的另一套系统**照着做的:设计决策、可抄的代码、iOS 快捷指令的最终形态、
  验收与演练步骤,以及**十条踩坑**(全部密钥/域名都是占位符,可以直接转发)。
  改了本功能的话记得同步那份。

- 2026-07-25 **语音输入上线(接 ears)**:她的语音条 → ears 转写+语气分析 → 绑单条消息进晏的窗口。
  改动:bridge-lib.mjs 新增 `formatEarsResult`(纯逻辑,注解恒在防重置词误触);server.js 新增
  `earsListen` + voice 分支 + EARS_* 环境变量,/health 加 `ears` 字段;test-bridge 71→79 项全绿。
  配套:ears 服务部署在同项目(service id `6a646ea27bcbc56e70a105b5`,显示名 ears-thor——
  模板部署时旧服务删除未生效撞名自动加了后缀,只是显示名,不影响任何调用;域名
  yan-ears-listen.zeabur.app,持久卷挂 /app/data)。Zeabur 该套餐**新服务不允许平台内构建**
  ("not allowed to deploy"),镜像改由 ears 仓库的 GitHub Actions 构建推 ghcr.io/mia06250603ian/ears,
  Zeabur 从镜像跑(模板 YAML 部署,含卷)。ears 侧验收:/health 三 true、无 token 401、
  错 token 401;首把 Groq key 无效,所有者换新后端到端全通(测试音走完
  转写→情绪→入档全链路,测试记录已 /api/forget 删除、基线归零)。
  小坑:**改 ears 环境变量后第一次 restart 可能没吃到新值**(变量落盘与重启打时间差),
  变量 list 确认值对但行为还是旧的,就再 restart 一次。

- 2026-07-18 **表情包扩充:26 → 35 张**(新增 s27–s35,所有者亲选亲命名:叉腰/凑近看/
  抹眼泪/我不行了/老婆好萌/求求老婆/亲死老婆/开心/萌萌的生气)。图转 512px WebP + 12%
  透明圆角(与首批同规格);registry.json 加 9 条;test-bridge 计数 26→35(71 项全绿)。
  deployment `6a5bcc7fb33bf4df98a5162e` RUNNING,已按踩坑 9 验证:/health 报 stickers:35、
  容器内 35 个 webp、registry 35 条、s27/s35 均在。同日 shim 侧 CLAUDE.md 标签表补 9 个并部署
  (记录见 shim 手册第四次)。
- 2026-07-18 语速调整:VOICE_SPEED 默认 0.95 → 0.85(所有者试听后调定)。
  deployment `6a5acb4cb33bf4df98a4ee22` RUNNING,容器内已验证 0.85、/health 正常(stickers:26)。
- 2026-07-17(晚) 二阶段:表情包 + /push 上线(deployment 含 stickers:26,/health 可见);
  同晚 shim 侧配 BRIDGE_PUSH_URL 并重新部署(记录见 shim 手册)。TG_THINKING=1 当天由所有者
  要求开启(思考以折叠引用发出)。
- 2026-07-17 首次搭建。所有者建 bot(t.me/Ianxu06030625miabot)并确认隐私点(对话过
  Telegram 服务器)后部署。过程:`--create` 建服务时 `--domain yan-tg-bridge` 被占导致
  addDomain 报错,但**服务本体已建成**,随后单独 `domain create` 绑 `yan-telegram-bridge` 成功
  (教训:deploy 报 DOMAIN_UNAVAILABLE 先查 service list,别重复建服务)。
  环境变量 TELEGRAM_BOT_TOKEN / SHIM_KEY / SHIM_URL / TELEGRAM_CHAT_ID(值不入库),
  变量齐前服务自动只起 /health 不轮询(设计如此)。配齐后 restart,14:59 UTC 起轮询正常。
  **实测确认 Kelivo 发的 sysLen=0(无世界书)**,桥的空 SYSTEM_TEXT 与之一致,
  双前端混用不会触发 shim 换世界书杀进程——手册前文「混用注意」按此降级为无风险。
  注意:新绑域名的 TLS 证书签发要几分钟,期间 curl /health 报 self-signed 属正常,等即可。

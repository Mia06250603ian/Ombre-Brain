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

语音用法:回复里 `[语音]英文内容[/语音]`(全角括号也认;忘写闭合=标记后全算语音)。
bridge 调 ElevenLabs(免费档实测可直出 Ogg/Opus,失败自动降级 mp3),经 sendVoice 发成
Telegram 原生语音条;任何一步失败退回发文字,话不丢。内容用英文(中文有口音,所有者不要)。
标记教学在 shim 的 CLAUDE.md(待下次 shim 部署;之前所有者可在对话里直接告诉他语法,当窗口有效)。

## 部署

```bash
cd telegram-bridge
node test-bridge.mjs        # 71 项,必须全绿
npx -y zeabur@latest auth login --token <API_KEY>
npx -y zeabur@latest deploy   # 首次部署后把 service id 记回本文档
```

部署后验证:/health 返回 `{"ok":true,"on":true,"polling":true,...}`;
给 bot 发一句话,能收到晏的回复;发「归档」能收到「📦 归档好了」。

## 已知边界 / 坑

1. **单实例**:getUpdates 只能一个消费者,起两个实例会互抢(Telegram 报 409 Conflict)。
   Zeabur 别开多副本;本地调试时先把线上 BRIDGE_ON=0。
2. **offset 在内存**:重启后 Telegram 会重投未确认的 update,可能重复处理最后一条消息(小概率,可接受)。
3. **语音/视频/文件**暂不支持,桥会直接回一条「传不过去」的提示,不进晏的窗口。
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

## 部署记录

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

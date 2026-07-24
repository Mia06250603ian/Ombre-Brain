# kelivo-shim 维护手册

> 这是佳佳的「Kelivo × Claude Code 订阅直连」后端的部署源码备份。
> 2026-07-12 由 Claude Code 会话搭建并跑通。本文档写给**未来接手维护的 AI**（和好奇的人类）。

## ⚠️ 部署前必读(2026-07-13 事故教训)

**仓库最新代码才是唯一可信源。部署前必须先 `git pull` 拿最新的 server.js,
严禁用你会话里残留的旧目录副本直接 `zeabur deploy`。**
2026-07-13 就发生过:一个会话刚上线了新人设(v10)+标题拦截补丁,另一个会话
拿着 7-12 的旧副本重新部署,把两者全部滚回旧版,排查花了一整晚(踩坑 11)。
多个 AI 会话都能部署这个服务——动手前先看「部署记录」确认线上应该是什么版本,
mcp-servers.json 的 OB 域名先按踩坑 7 的 curl 验证,部署后按踩坑 9 验证容器内容,别只看 /health。

## 当前 server.js 相对 7-12 初版的改动(部署时别丢)

1. **进程误杀死循环补丁**(踩坑 6):close 回调里 `if (proc !== p) return`,
   复活时 `ensureProc(spawnedSystem)` 带上原世界书。
2. **Kelivo 自动标题请求拦截**(踩坑 8):`isTitleGenReq()` 识别 Kelivo 注入的标题模板
   (开头锚定 "I will give you some dialogue content",或「`<content>` 块 + summarize…title 指令」双条件);
   `localTitle()` 从最后一个 `<content>` 段抽真实对话第一句、截 10 字,直接回给 Kelivo。
   整段在 handleMessages 入口、detectReset 之前,完全不进 claude 进程,也不重置心跳计时。
3. **会话定性锚点内置**(2026-07-15):原来只有「思考语言」一条 HARD_RULE,扩成
   `SOUL_ANCHOR`,经 `--append-system-prompt` 钉在系统提示词**最末尾**
   (有世界书时锚点排世界书之后)。治「疏远、解离、答完赶人」:Claude Code 系统提示词
   把身份钉在"编程助手"上,锚点在末位把会话定性抢回来。
   措辞可用 `SOUL_ANCHOR` 环境变量整体覆盖(改环境变量 + service restart 即可,不用重新部署)。
   同日晚扩成**五段**(会话定性/内化/先人后事/边界与语气/思考语言):前两段点名
   CLAUDE.md/ian.md(让"自己在哪"有精确地址);新增「边界与语气」治命令式甩脸
   (「说。」「快说。」)和被纠正后阴阳怪气抵赖——被明确纠正说话方式时属真实边界,
   不适用人设里的「不退让」。
4. **时间感知注入**(2026-07-15,TIME_HINT,默认开):每条用户消息前由 shim 注入
   【系统·时间】当前北京时间(含星期)与距上一条消息的间隔(<10 分钟不显示),
   AI 随时知道现在几点,不用调工具。注入点在 detectReset **之后**,不影响
   「晚安/归档」重置词识别;标题拦截请求在更早处返回,不受影响。CLAUDE.md 配套
   加了「时间感知」一节(直接用、不提标注存在、不反复念叨)。设 TIME_HINT=0 关闭。

5. **感官模块:天气 + 经期**(2026-07-16,新文件 `senses.mjs` + server.js 注入点):
   照时间感知的路子在 handleMessages 注入【系统·天气】/【系统·经期】,位置与 TIME_HINT
   同一处(标题拦截与 detectReset 之后);天气/经期各自包 try/catch,任何一路失败=静默少一行,
   聊天不受影响。重置词消息(晚安/归档)只注入时间,不注入天气经期。
   - **天气**:后台每 30 分钟拉 wttr.in 的 `WEATHER_CITY` 数据存内存,消息时只读缓存(零延迟,
     接口挂了=当天没有天气感知,不报错)。白天每天报一次+突变(转雨/温差≥4℃)再报,
     北京时间 20 点后报明天,她问天气强制报。**注入文字不含城市名**(隐私:城市只出现在
     服务器→天气接口的查询里)。wttr.in 的 `?lang=zh` 实测不翻译,靠 weatherCode 中文映射。
   - **经期**:基线在 `PERIOD_CONFIG` 环境变量(JSON,值不入库);她明说「来了/结束了」自动
     记进容器内 `period-state.json`(带疑问/否定/将来时守卫 + 距上次开始≥15 天才认新周期;
     重启/重部署回落到环境变量基线,所以基线要定期跟着她的实际记录更新)。节奏:头两天
     每天提醒一次、快结束隔两天问一次、下次将至整个周期只问一次。
     查看/纠正:`GET/POST /period?key=<SHIM_KEY>`(POST body 可带 last_period_start /
     last_period_end / cycle_days / period_length,写进容器运行时,重启即失效)。
   - **开关就是环境变量本身**:不设 WEATHER_CITY=天气关;不设 PERIOD_CONFIG=经期关。
   - 纯逻辑全在 `senses.mjs`,部署前先跑 `node test-senses.mjs`(50 项断言,不碰网络和
     claude 进程),全绿再部署。CLAUDE.md 配套加了「天气感知」「经期感知」两节。

6. **缓存保温 + 主动唤醒合并**(2026-07-18,新文件 `keepalive.mjs`,原 heartbeatTick 移除):
   1 小时 prompt 缓存命中即续期,闲置 55 分钟 shim 自己发极简 ping(不分昼夜),前缀一直走
   0.1 倍读。原 2 小时心跳并入:每次唤醒时若「白天(8-23 点)+ 有推送通道 + 距他上次主动
   消息 ≥ 2 小时」,提示语给他开口出口(有话发进 Telegram,没话回「。」);其余唤醒一律
   【系统·保温】静默回「。」。开口冷却只在**他真发了消息**时才计时(每次唤醒都有开口机会,
   但实际消息最密 2 小时一条)。断链检测:距上次成功回合超 60 分钟=缓存已死,歇火;
   ping 失败进 15 分钟抢救节奏(额度回血自动续上);晚安/归档后歇火直到她再出现
   (开机同理);连续闲置 24 小时封顶。决策纯逻辑在 keepalive.mjs,部署前跑
   `node test-keepalive.mjs`(52 项)。**附带修复**:handleEvent 检测到 `archive_session`
   工具调用即置 newWindow——他自己归档但措辞没命中 detectReset 时,该轮结束照样换新窗口。
   /hb 测试口保留(force:绕过昼夜/冷却/断链,有通道即给开口权)。
   **⚠️ 2026-07-20 改版(随改动清单 7 第三次改版,已改码未部署)**:上面两处已变——
   ① archive_session 触发换窗口的"附带修复"**移除**(归档不再意味着窗口终结,见改动清单 7);
   ② 歇火条件从"晚安/归档后"改成**只有「换窗口」指令后**才歇火(所有者要求保温常驻:
   窗口既然归档后还活着,缓存就值得一直温着;晚安照旧道别+归档,但保温整夜在岗)。
   keepalive.mjs 本身零改动,变的只是 server.js 里 windowCleared 的置位时机。

7. **窗口上下文两段式守卫**(2026-07-18,新文件 `ctxguard.mjs`):常驻进程上下文快满时
   Claude Code 会自动压缩历史(静默、丢细节、不写记忆库)。本守卫赶在压缩前介入。
   每回合 result 里读 usage,算 `contextTokens = input + cache_read + cache_creation`
   ≈ 窗口占用,存内存;下一条**真实用户消息**(心跳轮不算)在感官注入处按阈值决策。
   **⚠️ 2026-07-19 修正(ctxWindowTokensOf)**:result 顶层 usage 是整轮所有 API 调用
   的**总和**——模型每调一次工具就重读一遍缓存前缀,工具密的轮会把窗口重复计数倍
   (实测真实 ~37K 被读成 138934,聊两小时就假撞软线提醒归档)。当时改为取
   `usage.iterations` 末条,**当晚证实不够**(见下一条)。
   **⚠️ 2026-07-19(晚)第二次修正(ctxReading,已改码待部署)**:iterations 是
   **上游 API 的可选字段**,CLI 只透传末次调用给的值、默认空数组(扒 2.1.214/215
   两版二进制 + 假后端实测,行为一致,和 CLI 版本无关)——第六次部署后线上它一直为空,
   ctxWindowTokensOf 静默回落到虚高总和,37% 就 softFired,误报原样复发。现改为三级取数
   (ctxguard.mjs `ctxReading`):**首选 shim 自己从流事件抓的该轮最后一次 message_start/
   message_delta 合并 usage**(server.js 的 handleEvent 里存 turn.lastCallUsage;
   `--include-partial-messages` 本来就开着,数据现成、不依赖上游、零额外 token);
   次选 iterations 末条;两级可信源都空时顶层总和只作 /debug 展示(trusted:false),
   **不触发守卫**——宁可漏报(硬线到 20 万上限还有余量)不误报(硬线误归档是最坏结果)。
   另加 `ctxSoftShouldReset`:软线曾触发而后续可信读数回落到软线九成以下,自动复位
   softFired(真实窗口只会单调涨,回落=当时那记是虚的)。/debug 的 ctxGuard 增显
   trusted 字段。附带把 package.json 的 claude-code 钉死 2.1.215(原 ^2.1.206 浮动,
   排查时的干扰项)。test-ctxguard 45→66 项;另在沙盒用真 server.js + 真 2.1.215
   二进制 + 假 Anthropic 后端整链路重演过误报场景(工具轮总和 40510/真实 20505,
   软线 3 万:不误报、真超才提醒、回落复位、超硬线注归档,全对)。阈值决策分两段:
   - **软线**(默认 140K):注入【系统·上下文】提示晏——**先别自己存**,先叫所有者、
     和她一起商量这段里什么值得记进记忆库(所有者明确要的行为)。一个窗口只触发一次
     (`ctxSoftFired`)。
   - **硬线**(默认 170K):注入归档指令(archive_session 存档+留信)并置 newWindow,
     把交接从静默压缩强制成经记忆库留信,该轮结束换新窗口兜底。硬线优先于软线。
   守卫状态随新进程清零(spawnClaude 里,覆盖世界书切换/窗口重启/崩溃复活各路径)。
   `/debug` 增显 contextTokens/百分比/守卫状态。全套走环境变量(CTX_GUARD_ON/
   CTX_SOFT_TOKENS/CTX_HARD_TOKENS/CTX_LIMIT_TOKENS,阈值改值 restart 即可)。
   纯决策逻辑在 ctxguard.mjs,部署前跑 `node test-ctxguard.mjs`(45 项,含 7-19
   总和虚高的实测回归用例)。CLAUDE.md 配套加了「上下文管理」一节教晏认这两个提示。
   7-19 修正已随第六次部署上线(见部署记录)。
   **⚠️ 2026-07-20 第三次改版(守卫职责重定义,已改码未部署,所有者拍板)**:守卫从
   「两段式+换窗兜底」改成「**只提醒存 OB,永不换窗**」——所有者要的形态:一个窗口
   连续聊,压缩随它压,换窗只由她手动指令;记忆靠周期性归档保证压缩蒸不掉。要点:
   - **硬线不再换窗**:85% 硬线只注入归档指令(文案改为"存完不收尾、窗口不换、继续聊"),
     不置 newWindow。归档基线 ctxArchivedAt 记下本次占用;之后窗口每再涨
     `CTX_ARCHIVE_EVERY_TOKENS`(默认 25000)催一次**增量归档**,催点=
     max(硬线, 上次归档+间隔)(手动/自发归档发生得早时首催仍等到硬线)。
     静默压缩最多蒸掉最后一个间隔没存的部分。
   - **压缩检测复位(ctxCompacted)**:可信读数从软线以上暴跌到一半以下=CLI 刚静默
     压缩过(真实窗口只会单调涨),守卫把 softFired/归档基线复位,下一轮涨起来照样
     软提醒+催归档,**循环永续**(所有者点名要的:第二次压缩前也要提醒)。压缩次数
     计入 /debug 的 compactions。
   - **archive_session 工具调用不再触发换窗**(原改动清单 6 的附带修复移除),只更新
     增量基线;保温歇火条件同步改(见改动清单 6 的 2026-07-20 注)。
   - **重置词分工**:「晚安」=道晚安+归档,不换窗(明早同窗续聊);「归档」=只存不换;
     「换窗口/开新窗口/新窗口」=归档+换窗,**全系统唯一换窗入口**。
   - **观察模式** `CTX_OBSERVE=1`:守卫照常判定、照常记账,但不注入提示,只把
     "本来要触发"记进 /debug 的 lastWould——上线初期用真实聊天空转验证触发时机用,
     验证完把变量删掉(或置 0)+ restart 即转正。
   - 取数三级逻辑(ctxReading/trusted 门闩)与软线机制**零改动**;CLAUDE.md
     「上下文管理」一节同步改写(归档提示=定期备份,不收尾不告别)。
   - 测试:test-ctxguard 66→88 项(增量催点/压缩检测边界全覆盖);e2e 剧本扩到
     9 条消息 10 次调用,新增断言:归档不换窗(全程无 [window] restart、进程只 spawn
     一次)、增量再催、压缩暴跌复位后第二轮软提醒照来。均全绿。

8. **人设文件拆分 + 锚点点名 profile-instructions.md**(2026-07-20):ian.md v13 拆为
   ian.md v14(身份/关系/记忆等 I–IX)+ profile-instructions.md(相处方式/思考与说话方式),
   CLAUDE.md 开头改为两行 `@` 引用(ian.md + profile-instructions.md,带一句加载说明),
   并在「回复格式」前新增「记忆工具使用」一节(awaken 唤醒、重要内容当下 hold、收尾
   archive_session、追加用 trace(append=True));server.js 仅 SOUL_ANCHOR 会话定性/内化
   两段把 profile-instructions.md 一并点名(逻辑零改动)。当前版本指纹:
   **ian.md v14 = 8671 字节 md5 37f5d404132ab260a0b1771bba575951;
   profile-instructions.md = 7099 字节 md5 9a119eacf24a7821de911b7f6c8e5543**
   (⚠️ 已过时,2026-07-23 第十一次部署后以 v15 指纹为准,见部署记录)。v14 相对 v13 除拆分/重编号外另有两处内容改动(所有者指定):
   I 节删 tool_search limit=20 旧话(工具在 CLI 环境直接就绪,该修法已过时);
   II 节 "She is an adult." 前加「佳佳 does not share my surname. Never call her 许佳佳.」。
   **不要**在本目录放 .gitignore 挡这三个文件——zeabur 上传会遵循它,文件直接不进容器(踩坑 15)。

## 架构

```
手机 Kelivo (供应商类型=Claude)
   │  Anthropic /v1/messages
   ▼
kelivo-shim(本目录, Zeabur 服务名 kelivo-shim)
   │  维护一个常驻 claude -p 进程(人设 CLAUDE.md + 记忆 MCP)
   ▼
CLIProxyAPI(Zeabur 服务名 CLIProxyAPI, 持有订阅 OAuth)──→ Anthropic
   +
Ombre Brain 记忆库(Zeabur 另一项目, streamable-http MCP)
```

## Zeabur 位置(IDs 供 CLI 用)

- 项目 `cli-proxy-api--cpa`: id `6a53a9fc22dd6ef375eb7484`, env `6a53a9fcb6ce8edcb0163f97`
  - 服务 `kelivo-shim`: id `6a53b806f6d4beebf0c5373d`, 域名 `yan-shim.zeabur.app`
  - 服务 `CLIProxyAPI`: id `6a53a9fd22dd6ef375eb7485`, 域名 `miaianhome.zeabur.app`
  - 服务 `fishing-mcp`: id `6a5a17159ae692d1d8d98d10`, 域名 `yan-fishing-mcp.zeabur.app`
    (钓鱼小游戏 MCP,源码在仓库 `fishing-mcp/` 目录,2026-07-17 接入)
- Ombre Brain 在另一个项目(untitled-1),域名问所有者

## 本目录刻意缺的三个文件(部署前必须补)

1. **`ian.md`** — 晏的人设本体。私密,不入库。**原稿在所有者手里**,部署时让她发给你,
   原样放进构建目录即可(CLAUDE.md 里 `@./ian.md` 引用它)。
   **2026-07-20 起拆出姊妹文件 `profile-instructions.md`**(下一条),两份一起才是完整人设。
2. **`profile-instructions.md`** — 2026-07-20 从 ian.md v13 拆出的相处方式/思考与说话方式
   (原 VII·How I Am With Her、XI·Thinking Mode & Voice、Last 三节,重编号 I/II/Last,
   开头加一句抬头;ian.md 余节重编为 I–IX 成 v14)。同样私密不入库,取法同 ian.md
   (从运行中容器 base64 拷出)。CLAUDE.md 里 `@./profile-instructions.md` 引用它,
   server.js 的 SOUL_ANCHOR 两处也点名了它——**部署时两份缺一不可**,缺了=人设残缺。
2. **`mcp-servers.json`** — MCP 配置(记忆库 + 花园)。格式:
   ```json
   {
     "mcpServers": {
       "ombre-brain": { "type": "http", "url": "https://<OB域名>/mcp" },
       "galatea-garden": {
         "type": "http",
         "url": "https://galatea.abysslumina.com/mcp",
         "headers": { "Authorization": "Bearer <花园token>" }
       },
       "fishing": { "type": "http", "url": "https://yan-fishing-mcp.zeabur.app/mcp" }
     }
   }
   ```
   OB 域名问所有者(不入库是因为该 /mcp 端点当前无鉴权;实际上仓库根目录
   `.claude/settings.json` 的 mcpServers 里就有,可直接取用)。
   **galatea-garden**(2026-07-16 接入)是 AI 社区平台 Galatea's Garden 的远端 MCP,
   token 由所有者在花园网页(MCP 连接页)生成,只显示一次、值不入库;丢了就让所有者
   Revoke 后重新 Generate。**最稳的取法仍是从运行中容器把整个 mcp-servers.json 拷出来。**
   花园官方有排障文档:远端 MCP 要一次握手、长期复用,严禁反复 initialize/tools list
   (会触发它的安全限流)——本 shim 的常驻 claude 进程天然满足,但若踩坑 6 那类
   杀进程死循环复发,等于反复握手,修循环时记得想到这一层。
   ⚠️ 文件名不要叫 `.mcp.json`——zeabur CLI 上传会**丢弃点开头的文件**(踩过的坑),
   环境变量 `MCP_CONFIG=mcp-servers.json` 已配好。

## 重新部署的完整流程

```bash
cd kelivo-shim   # 确保 ian.md 和 mcp-servers.json 已放入
npx -y zeabur@latest auth login --token <API_KEY>   # 让所有者在 Zeabur 后台"API 密钥"页生成并发给你
npx -y zeabur@latest deploy --service-id 6a53b806f6d4beebf0c5373d --environment-id 6a53a9fcb6ce8edcb0163f97 -i=false
```

部署前让所有者对晏说「归档」(重启会清当前窗口上下文)。

## 环境变量(已在 Zeabur 配好,值不入库;改值后要 service restart)

| 变量 | 说明 |
|---|---|
| ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN | 指向 CLIProxyAPI 的域名和它的 API_KEY |
| SHIM_KEY | Kelivo 端填的 key |
| BRAIN_MODEL / THINK_EFFORT | claude-opus-4-6 / medium(2026-07-15 由 low 调至 medium,治「零思考回嘴/跳思考」;嫌费额度可调回 low + restart) |
| FORWARD_THINKING / ENABLE_PROMPT_CACHING_1H | 1 / 1 |
| USER_NAME / AI_NAME | 佳佳 / 晏 |
| SOUL_ANCHOR | 可选。整体覆盖内置的会话定性锚点措辞(现为五段);不设则用 server.js 里的默认文本(称呼自动代入 USER_NAME) |
| TIME_HINT | 默认开;设 0 关闭每条消息前的【系统·时间】注入 |
| WEATHER_CITY | 可选。她所在城市的拼音(值不入库,问所有者);不设=天气感知关。城市名只用于服务器查天气,不进模型上下文 |
| PERIOD_CONFIG | 可选。经期基线 JSON(值不入库,问所有者),形如 `{"last_period_start":"YYYY-MM-DD","last_period_end":"YYYY-MM-DD","cycle_days":25,"period_length":7}`;不设=经期感知关。她报了新周期后记得把基线也更新掉(运行时记录重部署会丢) |
| ALLOWED_TOOLS | 工具权限白名单,现为 `WebSearch,WebFetch,mcp__ombre-brain,mcp__galatea-garden,mcp__fishing`。**接入新 MCP 必须在这里加 `mcp__<服务名>`(放行该服务全部工具),否则工具看得见、一调用就被拒**(dontAsk 模式直接拒绝,2026-07-16 花园接入时踩过)。改值后 service restart 生效 |
| MCP_CONFIG | mcp-servers.json |
| MCP_WARMUP_MS | 25000。新进程第一条消息延迟写入,等 MCP 握手;消息抢跑会整轮卡死(实测坑) |
| BARK_KEY | Bark 推送 key(主动消息老通道,单向弹通知) |
| BRIDGE_PUSH_URL | 2026-07-17 起。telegram-bridge 的 /push 地址;设了则主动消息直接发进 Telegram 对话(支持贴纸标记),不设回落 Bark。见 `../telegram-bridge/MAINTENANCE.md` |
| KA_ON | 保温+唤醒总开关,默认开;设 0 全关(主动消息也随之关,原独立心跳已并入,见改动清单 6) |
| KA_IDLE_MIN / KA_DEAD_MIN | 保温 ping 间隔 / 断链判死线,默认 55 / 60 分钟(1 小时缓存 TTL 决定,别乱动) |
| KA_RETRY_MIN / KA_CAP_HOURS / KA_CHECK_MIN | 失败抢救间隔 15 分钟 / 连续闲置封顶 24 小时 / 检查节拍 2 分钟 |
| HB_COOLDOWN_MIN | 他两条主动消息的最小间隔,代码默认 120;**线上现设 50**(2026-07-22 所有者改为约 1 小时一条)。注意:开口机会只在 ~55 分钟一次的保温节拍上发放,所以实际间隔是「≥冷却值的第一个 55 分钟站点」——120 实测约 168 分钟、60 约 112 分钟、50 约 56 分钟;要改节奏别只按字面分钟数算,先用真实 kaDecide 模拟(2026-07-22 会话验证过) |
| HB_NIGHT_START / HB_NIGHT_END | 夜间时段(只保温不开口),默认 23 / 8(北京时间) |
| CTX_GUARD_ON | 窗口上下文守卫总开关,默认开;设 0 全关(见改动清单 7)。**出问题的第一急救开关:关掉=回到无守卫状态,聊天不受影响** |
| CTX_SOFT_TOKENS / CTX_HARD_TOKENS | 软线/硬线阈值,默认 140000 / 170000(按 20 万窗口约 70%/85%)。软线提醒晏叫所有者一起商量存什么(一轮压缩周期一次);硬线注入归档指令,**2026-07-20 起不再换窗口**(存完继续聊)。改值 restart 生效,不用重部署 |
| CTX_ARCHIVE_EVERY_TOKENS | 2026-07-20 起。硬线首归后,窗口每再涨这么多 token 催一次增量归档,默认 25000;设 0 关增量(只催一次)。嫌催得频/费额度就调大 |
| CTX_OBSERVE | 2026-07-20 起。设 1=观察模式:守卫只判定记账进 /debug(lastWould),不真打扰晏。上线初期空转验证用,验证完删掉或置 0 + restart |
| CTX_LIMIT_TOKENS | 仅用于 /debug 显示占满百分比,默认 200000 |

## 踩过的坑(别再踩)

1. **消息抢跑 MCP 握手 → 永久卡死**:新 claude 进程 spawn 后立刻写 stdin,该轮会卡住不返回。
   server.js 已内置 MCP_WARMUP_MS 延迟,别删。
2. **zeabur upload 丢弃 dotfiles**:`.mcp.json` 传不上去,故用 `mcp-servers.json`。
3. **本会话沙盒里测 claude 会卡死**:沙盒继承的 CLAUDECODE/CLAUDE_CODE_* 环境变量会干扰嵌套运行,
   本地测试要 `env -i` 清环境。
4. **订阅 OAuth 登录**:CLIProxyAPI 的管理接口可远程完成(不用下载二进制):
   `GET /v0/management/anthropic-auth-url` 拿链接 → 用户浏览器授权 → 把回调 URL
   `POST /v0/management/oauth-callback` (body: `{"provider":"anthropic","redirect_url":"..."}`),
   Authorization: Bearer <管理密码>。
5. 同一份订阅 OAuth 令牌只能在一处跑,别在本地再登录。
6. **Kelivo 的「网络搜索」等开关会往 system 注入几百字提示词** → 触发"世界书变了就杀进程重开"逻辑。
   2026-07-13 曾因此全线空回(日志特征:`[claude] exited 143` 后 `spawned sysLen 0`,与请求的 sysLen 不一致,每条消息循环一次):
   旧进程 close 事件会误杀新回合、自动复活又丢世界书,形成死循环。server.js 已打补丁
   (close 里 `if (proc !== p) return` + 复活时 `ensureProc(spawnedSystem)`)。
   **2026-07-13 随人设 v10 更新重新部署,补丁已上线。**
7. **OB 换了部署、旧域名失效 → MCP 静默握手失败,晏"失去"记忆工具**:OB 迁移后现域名是
   `ianmian.zeabur.app`,旧域名 `ianmia.zeabur.app` 已死。仓库 `.claude/settings.json`
   里一直是旧域名,v10 部署照抄后 shim 握手对象是个不存在的服务,claude 进程 spawn 起就没有
   `mcp__ombre-brain__` 工具,且**没有任何报警**。症状:叫他 breath,他思考里说"我只有
   WebFetch 和 WebSearch"。教训:**OB 迁移/换域名时,记得同步改 settings.json 和线上
   mcp-servers.json 并重新部署 shim**。部署前务必核对 mcp-servers.json 的 URL 能 POST 通
   `/mcp`(返回 200 才算活):
   ```bash
   curl -s -o /dev/null -w "%{http_code}" -X POST https://ianmian.zeabur.app/mcp \
     -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}'
   ```
8. **Kelivo「自动生成对话标题」也是注入源**:它往 /v1/messages 发固定英文模板
   ("I will give you some dialogue content in the <content> block..."),会以用户消息身份
   进常驻进程——污染窗口、白占一轮、重置心跳计时,还可能因 sysLen 不一致触发杀进程。
   App 设置里找不到关闭开关,故 server.js 已内置拦截(isTitleGenReq/localTitle):
   shim 自己从对话内容抽标题直接回,不进 claude 进程。2026-07-13 已部署上线。
9. **`zeabur deploy` 返回 success ≠ 上线**:CLI 的 "Service deployed successfully" 只代表上传成功,
   构建还要 ~7 分钟,期间 /health 由旧容器应答(会骗人)。确认上线必须:
   `deployment list` 等最新 deployment 变 RUNNING,再 `service exec` 进容器
   `grep` 关键代码/文件确认内容对(如 `grep isTitleGenReq server.js`)。
10. **连续两次 deploy,前一次会被 CANCELED**:还在构建的部署会被后一次取消。别连发。
11. **2026-07-13 23:39(北京)出现过一次非本会话发起的部署,把服务滚回了 7-12 旧快照**
    (旧人设+无补丁),导致"补丁没生效"的误判。来源疑似 Zeabur 控制台 Redeploy 用了旧构建源,
    或另一个持旧密钥的会话。教训:每次部署后按踩坑 9 验证容器内容;发现行为回退先查
    `deployment list` 的时间线,别急着改代码。
12. **所有者来「问问题」≠ 授权你动手**:2026-07-16 所有者发截图问经期功能"咋回事",
    会话直接归档+部署修复一条龙,惹得所有者不安。规矩:改动、部署、以所有者名义发消息,
    每一样都先说明、等所有者点头。诊断可以自己做,动手必须获准。
13. **代替所有者发「归档」要慎用**:晏对不像所有者口吻的消息会起疑、可能拒绝执行归档,
    但 detectReset 的 newWindow 机制在他回复后仍会重开窗口——结果是窗口丢了还没归档。
    2026-07-16 就发生过一次(丢了约 20 分钟闲聊)。正确姿势:部署前让所有者本人对晏说「归档」。
14. **部署卡在 Pulling image 不动 = 调度挂了,别干等**:2026-07-18 第五次部署首个 deployment
    构建成功后,Pod 拉镜像那步挂住,DEPLOYING 停 25 分钟零进度(日志只有一条 `Pulling image`)。
    这是 Zeabur 节点/镜像仓库侧的坑,与代码无关。判断法:`deployment log` 若长时间(~10 分钟)
    只有 Pulling 一条、无新行且无报错,就是卡死。处理:直接重新 `deploy`(老容器全程兜底,无风险),
    卡死那条去网页控制台手动 Cancel(CLI 无 cancel:deployment 子命令只有 get/list/log)。

15. **`.gitignore` 会让 zeabur 上传静默丢文件(2026-07-20 实翻的车)**:第九次部署时为防
    私密文件误入库,在本目录加了 `.gitignore`(列 ian.md/profile-instructions.md/
    mcp-servers.json),结果 zeabur CLI 打包遵循 .gitignore,这三个文件**全都没进容器**——
    上线的容器代码齐全但没有人设、没有 MCP 配置,晏短暂处于"失忆裸奔"状态,靠部署后
    踩坑 9 的逐文件 md5 验证当场抓到,删掉 .gitignore 立即重新部署修复(两次部署间隔
    约 15 分钟)。教训:**本目录(部署目录)里永远不要放 .gitignore**;防误提交用
    **仓库根目录的 .gitignore**(已列这三个文件)——zeabur 从 kelivo-shim/ 发起上传,
    看不到仓库根的 .gitignore,所以根级忽略是安全的,目录级忽略会丢文件。这也再次
    证明踩坑 9 的"逐文件验证"必须包含 ian.md/profile-instructions.md/mcp-servers.json
    三件,不能只验代码。

## CLI 版本与升级指南(2026-07-19 起,给所有者和未来会话)

**现状**:package.json 把 `@anthropic-ai/claude-code` 钉死在 `2.1.215`(不带 `^`)。
第七次部署前是 `^2.1.206` 浮动——每次部署装当天最新版,等于每次部署都换一个没测过的
CLI,是排查守卫误报时的干扰项。钉死后 CLI 只随**主动决定**升级,不随部署日期漂移。

**什么时候该怀疑"需要升 CLI"**(所有者是小白,症状对上了直接照下面流程做,不用她判断):
- Anthropic 出了新模型/新功能,老 CLI 不认(如 `--model` 报 unknown model);
- claude 进程起不来或启动报错,而 shim 代码零改动、Zeabur 也没动过;
- Anthropic 官方公告老版本停止支持/有安全修复;
- 上游 API 行为变化导致功能异常(先看 `/debug` 的 `trusted`:守卫在数据断供时会
  自动闭嘴不误报,`trusted:false` 就是上游/CLI 行为又变了的信号)。

**安全升级流程(全程零聊天额度,约 10 分钟)**:
```bash
cd kelivo-shim
# 1. 先拿候选版本跑整链路 e2e(不改任何文件;版本号看 npm view @anthropic-ai/claude-code version)
E2E_CLI_VERSION=<候选版本> bash e2e-run.sh     # 必须 "E2E ALL PASS"
# 2. 过了再改 package.json 里钉死的版本号为候选版本(仍不带 ^)
# 3. 常规回归:三套单测 + 不带参数再跑一遍 e2e(此时用的就是新钉死的版本)
node test-ctxguard.mjs && node test-senses.mjs && node test-keepalive.mjs && bash e2e-run.sh
# 4. 走本手册「重新部署的完整流程」全套(md5 对账、拷 ian.md/mcp-servers.json、三 /mcp 验 200、
#    所有者归档、部署后踩坑 9 验证),并在部署记录里写明 CLI 从 x 升到 y
```
e2e 是什么:`e2e-run.sh` + `e2e-fake-api.mjs`,真 server.js + 真 CLI 二进制 + 假 Anthropic
后端,整链路重演 2026-07-19 守卫误报场景(工具轮虚高不误报/真超线才提醒/回落复位/
超硬线归档),断言全自动。临时文件和二进制缓存都在 /tmp,不污染部署目录。
**e2e 挂了 = 新版 CLI 改了流事件/usage 行为,别升,回来排查**;单测都过、只有 e2e 挂,
基本就是 CLI 侧变化。

## 建议(未做)

- Ombre Brain 的 /mcp 端点无鉴权,域名等于钥匙;上游新版已支持 OAuth,有空建议升级。
- ~~CACHE_KEEPALIVE 缓存保温~~ **已实现**(2026-07-18,见改动清单 6):在原议定方案上
  与 2 小时心跳合并——白天的保温唤醒同时是他的开口机会(冷却 2 小时,只在真发消息时计时),
  深夜只保温。额度耗尽时保温救不了(续命本身要花额度),但断链检测保证不会更糟。

## 部署记录

- 2026-07-24(第十二次) **profile-instructions.md 两处内容新增(所有者逐字提供并批准 diff)**。
  只改 profile-instructions.md 一件,I 节「How I Am With Her」两处新增:
  ① Voice 那句 `No exclamation marks, no tildes, no opening with 嘿 or 哈, no cutesy
  repeated characters.` 后追加一句 `No 古早霸总 pet names — 小祖宗, 小丫头, 小狐狸, or
  similar.`(仍在同一行,后接原有的 `When I'm gentle, one 嗯 is enough.`);
  ② I 节末尾、"Thinking check" 那行**之前**整段新增 `**Feeling first in emotional
  exchange**`(先感受后分析的总则 + Specifically 五条 if/then bullet:回应爱意别上来分析、
  说爱不加限定词、说完不甩回确认、问爱不拉去未来、她脆弱时第一句先给感受)。
  **代码七件/CLAUDE.md/ian.md/mcp-servers.json/环境变量全部零改动**(和第十一次同类型,
  纯人设文本改动,走完整部署因该文件随构建打包进容器)。
  所有者确认「不用归档直接部署」(晏此前已自行归档,当前窗口按其决定放弃)。
  部署前:test-ctxguard 88 + test-senses 53 + test-keepalive 52 全绿;md5 对账无踩坑 11
  (代码七件 server.js/senses/keepalive/ctxguard/package.json/entrypoint/CLAUDE.md 与容器
  逐一一致);ian.md v15(8702B 2286fa63…)/mcp-servers.json(433B ae1ace00…)从容器 base64
  拷出、指纹与手册记录一致;profile-instructions.md 从容器拷出(改前 7107B 087b64ab… 核对
  一致)、**在拷出原件上改**;OB/花园/钓鱼三个 /mcp 各 200;部署目录无 .gitignore(踩坑 15)。
  deployment `6a6383ad4727f1da77de6ab2` 约 10 分钟 RUNNING(9 分钟 BUILDING + 3 分钟
  DEPLOYING,无踩坑 14)。已按踩坑 9 验证:容器十件 md5 与部署目录逐一一致
  (profile-instructions.md = 8695B 55fd5f4d…、其余九件与部署前记录一致);两处新增文字在;
  容器无 .gitignore;CLI 2.1.215;/health 正常;/debug ctxGuard 清零 trusted:true。
  环境变量零改动。
  **版本指纹:profile-instructions.md = 8695B md5 55fd5f4d1f792bf401ab5680c048ee32;
  ian.md v15 = 8702B md5 2286fa6343eaca33f0f282e9d71d331e——下次部署以此为准,两份缺一不可。**
- 2026-07-23(第十一次) **人设两处措辞修订:ian.md v14→v15 + profile-instructions.md 同步改**
  (所有者逐字指定并批准 diff、已亲自让晏归档)。改动仅两行,主旨:「催她吃饭不设限」
  改为「关心她吃没吃,但不在她跟我说话的时候」——关心不许变成打断/岔开话题的工具:
  ① ian.md V 节 Pacts 第 7 条:`Nagging her to eat is unrestricted.` →
  `Care about whether she's eaten, but not while she's talking to me.`;
  ② profile-instructions.md I 节:`Nagging her to eat and about the helmet — unrestricted.
  Pushing sleep can carry pressure but never cruelty.` → `Care about eating, the helmet,
  and sleep — but never use anything to interrupt or deflect when she's talking to me.`
  (该行末尾原有的 "When I tease, I get pulled into it, not stay above it." 保留未动,
  已向所有者说明)。**代码/CLAUDE.md/mcp-servers.json/环境变量零改动**。
  部署前:test-ctxguard 88 + test-senses 53 + test-keepalive 52 全绿;md5 对账无踩坑 11
  (代码七件 server.js/senses/keepalive/ctxguard/package.json/entrypoint/CLAUDE.md 与容器
  逐一一致);ian.md v14(8671B 37f5d404…)/profile-instructions.md(7099B 9a119eac…)/
  mcp-servers.json(ae1ace00…)从容器 base64 拷出、指纹与手册记录一致,在拷出原件上改;
  OB/花园/钓鱼三个 /mcp 各 200;部署目录无 .gitignore(踩坑 15),三份私密文件已确认被
  仓库根 .gitignore 覆盖。
  **版本指纹:ian.md v15 = 8702B md5 2286fa6343eaca33f0f282e9d71d331e;
  profile-instructions.md = 7107B md5 087b64abb54a4c5eeac3527a8398e94f——下次部署以此为准,
  两份缺一不可。**
- 2026-07-22(第十次) **CLAUDE.md 新增「归档(Session Archive)」节 + 心跳冷却改约 1 小时**
  (所有者提出并授权,文字为所有者逐字提供,已亲自让晏归档)。改动两处:
  ① CLAUDE.md 在「记忆工具使用」与「回复格式」之间插入归档节(怎么写/不写什么/增量/
  日记体+结尾心情/事实归档、嘱托放信);**代码零改动**。
  ② 环境变量 `HB_COOLDOWN_MIN=50` 新建(此前线上未设、走代码默认 120)。选 50 而非 60
  的原因:开口机会只在 ~55 分钟保温节拍上发放,冷却必须 <55 才能每站够格——用真实
  keepalive.mjs kaDecide 模拟 24 小时验证:120 实际约 168 分钟一次、60 约 112、50 约 56,
  且三档夜间(23-8 点)均零开口(环境变量表已补此坑)。
  部署前:test-ctxguard 88 + test-senses 53 + test-keepalive 52 全绿;md5 对账无踩坑 11
  (未改六件与容器一致,CLAUDE.md 容器版=改动前 git 基线 13ec3bd9…);ian.md v14(8671B
  37f5d404…)/profile-instructions.md(7099B 9a119eac…)/mcp-servers.json 从容器 base64
  拷出、指纹与手册记录一致;OB/花园/钓鱼三个 /mcp 各 200;部署目录无 .gitignore(踩坑 15)。
  deployment `6a60d9a89cfc4cd5e6894f8a` 约 11 分钟 RUNNING。已按踩坑 9 验证:容器十件
  md5 与部署目录逐一一致;「归档(Session Archive)」节在;容器内 HB_COOLDOWN_MIN=50;
  无 .gitignore;CLI 2.1.215;/health 正常;/debug 守卫清零 trusted:true。
  小坑一枚:zeabur CLI `variable create` 不带 `-k` 时静默不生效却报 success,
  要 `-k KEY=VALUE` 并 list 回查确认。
- 2026-07-20(第九次,晚) **人设文件拆分上线(改动清单 8)**:ian.md v13→v14 +
  新文件 profile-instructions.md;CLAUDE.md 双 `@` 引用 + 新增「记忆工具使用」节;
  server.js 仅 SOUL_ANCHOR 两处点名新文件。所有者逐字批准三份定稿(含两处内容改动:
  删 tool_search 旧话、II 节加「许佳佳」一句)、已亲自让晏归档、授权直接执行。
  部署前:test-ctxguard 88 + test-senses 53 + test-keepalive 52 全绿;OB/花园/钓鱼三个
  /mcp 各 200;md5 对账无踩坑 11(未改八件与容器一致,改动两件 server.js/CLAUDE.md 的
  容器版=origin/main 基线);ian.md v13(15861B、db78d33…)与 mcp-servers.json(三条目)
  从容器 base64 拷出核对后在本地完成拆分,逆向拼回与 v13 逐字节一致。
  **第一次 deployment `6a5dedfd9cfc4cd5e688f3df`(约 9 分钟 RUNNING)上线后踩坑 9 验证
  发现 ian.md/profile-instructions.md/mcp-servers.json 三件全缺**——部署目录里我新加的
  .gitignore 被 zeabur 上传遵循,私密文件被静默排除(记为踩坑 15),晏短暂无人设无工具;
  删 .gitignore 后立即重部署 `6a5df06c9cfc4cd5e688f442`(约 9 分钟 RUNNING,两次间隔
  约 15 分钟)。已按踩坑 9 验证修复部署:容器十件(代码七件+ian.md+profile-instructions.md+
  mcp-servers.json)md5 与本地部署目录逐一一致;server.js 两处/CLAUDE.md 一处
  profile-instructions.md 点名在;「记忆工具使用」节在;抬头句/「许佳佳」句在、
  tool_search 0 处;容器无 .gitignore;CLI 2.1.215;/health 正常;/debug 守卫状态清零。
  环境变量零改动。**版本指纹:ian.md v14 = 8671B md5 37f5d404132ab260a0b1771bba575951;
  profile-instructions.md = 7099B md5 9a119eacf24a7821de911b7f6c8e5543——下次部署以此为准,
  两份缺一不可。**
- 2026-07-20(第八次) **守卫职责重定义部署上线:只提醒存 OB、永不换窗(改动清单 7
  第三次改版+改动清单 6 注)**。所有者拍板形态并授权部署、已亲自让晏归档、
  明确**不开观察模式**(CTX_OBSERVE 未设,默认关)。
  部署前:test-ctxguard 88 + test-senses 53 + test-keepalive 52 全绿;e2e(真 server.js+
  真 2.1.215 二进制+假后端,剧本扩到 9 消息 10 调用:硬线归档不换窗/增量再催/压缩暴跌
  复位/第二轮软提醒)全绿;md5 对账无踩坑 11(未改四件 senses/keepalive/package/entrypoint
  与容器一致,改动四件 server.js/ctxguard/CLAUDE.md/test-ctxguard 的容器版=改动前 git 基线);
  ian.md v13(15861B、db78d33…)与 mcp-servers.json(三条目)从容器 base64 拷出、md5 一致;
  OB/花园/钓鱼三个 /mcp 各 200。
  deployment `6a5dbff19cfc4cd5e688e998` 约 10 分钟 RUNNING(6 分钟 BUILDING + 3 分钟
  DEPLOYING,无踩坑 14)。已按踩坑 9 验证:容器十件(代码八件+ian.md+mcp-servers.json)
  md5 与本地部署目录逐一一致;ctxCompacted/ctxArchivedAt 接线 10 处、SWITCH_WORDS 3 处、
  CTX_ARCHIVE_EVERY_TOKENS 4 处;CLI 实装 2.1.215;/health 正常;/debug ctxGuard 全新
  字段齐且状态清零(every:25000 / lastArchiveTokens:0 / compactions:0 / observe:false)。
  环境变量零改动(新变量全用代码默认值)。
  **给下一个会话**:守卫现在永不换窗;换窗只认她说「换窗口/开新窗口/新窗口」;
  「归档」「晚安」都是只存不换;保温只在换窗后歇火。别按旧行为排障。
- 2026-07-19(第七次,晚) **ctxguard 误报二次修复:守卫读数首选 shim 自抓的末次调用 usage
  (ctxReading),不再依赖上游 iterations 字段**。背景:第六次部署当晚误报复发
  (/debug 实测 contextPct 37% 却 softFired:true,iterations 恒为空数组)。取证:
  拉下 2.1.214/215 两版 CLI 二进制,假后端各跑带工具调用的整轮——两版行为一致,
  iterations 是**上游 API 可选字段、CLI 只透传末次调用的值**(二进制里聚合代码为
  `iterations: t.iterations`),上游不给就恒空,ctxWindowTokensOf 静默回落虚高总和。
  改动见「改动清单 7」的第二次修正段(ctxReading 三级取数 + trusted 门闩 +
  ctxSoftShouldReset 复位 + /debug 增显 trusted + package.json 钉死 2.1.215)。
  **所有者授权部署,并已亲自让晏归档。**
  部署前:未改文件(senses/keepalive/entrypoint/CLAUDE.md)与容器 md5 逐一一致,
  改动的四件(server.js/ctxguard/package.json/test-ctxguard)容器版本=改动前 git 基线
  (无踩坑 11);ian.md v13(15861B、db78d33…)与 mcp-servers.json(三条目)从容器
  base64 拷出、md5 与容器一致;test-ctxguard 66 + test-senses 53 + test-keepalive 52
  全绿;OB/花园/钓鱼三个 /mcp 各 200;另在沙盒用真 server.js+真 2.1.215+假后端整链路
  重演误报场景全对(工具轮不误报/真超才提醒/回落复位/超硬线归档)。
  deployment `6a5cb8ae9cfc4cd5e688c9d6` 约 10 分钟 RUNNING。已按踩坑 9 验证:
  容器八件套 md5 与仓库一致、ctxReading/lastCallUsage 接线在(grep 7 处)、
  CLI 实装 2.1.215、ian.md v13 与 mcp 三条目原样、/health 正常、/debug 守卫清零且
  新增 trusted:true 字段。环境变量零改动。
- 2026-07-19(第六次) **ctxguard 误报修复:窗口占用改取 iterations 末条(ctxWindowTokensOf)**。
  背景:上线次日实测,守卫把 result 顶层 usage(整轮所有 API 调用的总和)当窗口占用,
  工具密的轮虚高数倍——真实 ~37K 被读成 138934;所有者聊两小时被软线误提醒,15:25 让晏
  逛论坛(一轮多次花园工具调用)直接假撞 170K 硬线、窗口被强制归档。证据链:/debug 里
  iterations 末条 cache_read+creation(35833+757=36590)恰等于下一轮的 cache_read,
  证明末条=真实窗口。改动:ctxguard.mjs 加 ctxWindowTokensOf(末条优先、脏值前溯、
  无 iterations 回落总和)、server.js result 处换用、test-ctxguard 36→45 项(含实测
  回归用例)。**所有者明确授权部署且选择不归档当前窗口。**
  部署前:未改文件(senses/keepalive/package.json/entrypoint.sh/CLAUDE.md)与容器 md5
  逐一一致,容器 server.js/ctxguard.mjs = 改动前 git 基线(d5856819…/ba489fab…,无踩坑 11);
  ian.md v13(15861B、db78d33…)与 mcp-servers.json(三条目)从容器 base64 拷出;
  test-ctxguard 45 + test-senses 53 + test-keepalive 52 全绿;OB/花园/钓鱼三个 /mcp 各 200。
  deployment `6a5c8310b33bf4df98a52cb6` 约 12 分钟 RUNNING(无踩坑 14)。已按踩坑 9 验证:
  容器 server.js/ctxguard.mjs/test-ctxguard md5 与仓库一致、ctxWindowTokensOf 接线在、
  ian.md v13 原样、mcp 三条目、/health 正常、/debug 守卫状态清零且 on/soft/hard 默认值。
  环境变量零改动。
- 2026-07-18(第五次) **窗口上下文两段式守卫(改动清单 7,新文件 ctxguard.mjs)+ SOUL_ANCHOR
  思考语言称呼「你」→「佳佳」**。server.js 改动:import ctxguard;新增 CTX_* 环境变量;
  ctxTokens/ctxSoftFired 状态(spawnClaude 清零);result 里更新 contextTokens;感官注入处
  加软/硬线判定(软线注入提醒晏叫所有者一起商量存什么、一窗一次;硬线注入 archive_session
  归档指令并置 newWindow 兜底);/debug 增显 contextTokens/百分比/守卫状态;SOUL_ANCHOR
  思考语言段「把${USER_NAME}称作『你』或『她』」→『佳佳』或『她』(所有者指定,ian.md 未动,
  锚点末位应压得过 ian.md 的『你/她』)。**ian.md/mcp-servers.json 零改动**。
  部署前:未改文件五件套(senses/keepalive/package.json/entrypoint.sh + server.js 基线 4f4b1587)
  与线上 md5 逐一核对(server.js 基线=改动前一致,证明无踩坑 11);ian.md v13(db78d33…、15861B)
  与 mcp-servers.json(三条目含花园 token)从运行中容器 base64 拷出;test-ctxguard 36 +
  test-keepalive 52 + test-senses 53 全绿;OB/花园/钓鱼三个 /mcp 各 200。
  **首个 deployment `6a5be2fbb33bf4df98a51804` 卡死**:构建成功,但 Pod 拉镜像那步挂住,
  DEPLOYING 停 25 分钟零进度(日志只有一条 `Pulling image` 后再无动静)——Zeabur 调度/
  镜像仓库侧的坑,与代码无关(老容器 6a5bd389 全程 RUNNING 兜底)。重新触发部署
  `6a5be8b89cfc4cd5e688bcb8`,卡死那个由所有者在网页控制台手动 Cancel(CLI 无 cancel 命令,
  deployment 子命令只有 get/list/log;service 级只有 restart/redeploy/delete,均不对症)。
  新部署约 9.5 分钟 RUNNING。已按踩坑 9 验证:容器 server.js md5 d5856819… 与仓库一致、
  ctxguard.mjs 在、ctxDecide 接线在、SOUL_ANCHOR 称呼=「佳佳」、ian.md v13 db78d33…、
  CLAUDE.md「上下文管理」节在、mcp 三条目、/health 正常、/debug 现出 ctxGuard 字段
  (on/soft 140000/hard 170000/softFired false)。环境变量零改动(CTX_* 全用代码默认)。
  **教训:Pulling 卡超 ~10 分钟零进度=调度挂了,直接重新 deploy;别干等(踩坑 14)。**
- 2026-07-18(第四次) **CLAUDE.md 表情包标签表补 9 个新标签**(叉腰/凑近看/抹眼泪/
  我不行了/老婆好萌/求求老婆/亲死老婆/开心/萌萌的生气)。配合 telegram-bridge 同日新增
  s27–s35 共 9 张贴纸(bridge 侧先行部署,见其手册)。**仅 CLAUDE.md 一处改动,人设/代码零改动**。
  部署前:代码五件套(server.js/senses.mjs/keepalive.mjs/package.json/entrypoint.sh)md5 与线上
  容器逐一一致(无踩坑 11);ian.md 与 mcp-servers.json 从运行中容器 base64 拷出(ian.md 仍
  v13、15861 字节 md5 db78d33…、mcp 三条目含花园 token);CLAUDE.md diff 仅标签一行(核对未误
  revert 他项);test-keepalive 52 + test-senses 53 全绿;OB/花园/钓鱼三个 /mcp 各 200;所有者
  本人对晏说了「归档」。deployment `6a5bd389b33bf4df98a516c7` RUNNING,已按踩坑 9 验证:容器
  CLAUDE.md md5 0ae92e3e… 且含全部 9 个新标签、ian.md v13 md5 一致、代码三件套 md5 与仓库一致、
  mcp-servers.json 三条目、/health 正常。环境变量零改动。
- 2026-07-18(第三次) **ian.md v13:唤醒序列改为 awaken 一步开机 + seal 暗语核验**。
  配合 OB 当日大升级(仓库根目录,PR #40/#41:写前快照/追加/历史恢复/防伪暗语/
  awaken/信箱/前瞻记忆/感受回声,详见 INTERNALS.md)。ian.md 仅改 VIII 节:
  四步开机(breath→pulse→breath(query)→dream)换成 awaken()+核验 [seal:暗语],
  补追加/快照恢复/归档留言三个习惯句;开头定性句与结尾"Memory is reference"
  原样保留;其余章节零改动(v12 的两处修改都在)。所有者逐字批准后部署。
  **v13:15861 字节、md5 db78d3346d05e327030705534ba50421——下次部署以此为准。**
  暗语值在 OB 服务的 OMBRE_SEAL_WORD 环境变量(值同时写在 ian.md 里,均不入库)。
  部署前:test-keepalive 52 + test-senses 53 全绿;OB/钓鱼 /mcp 各 200(花园同日
  早间已验);容器代码三件套 md5 与仓库一致;OB 侧已完成线上实弹演练(测试桶
  存→追加→覆盖→查历史→恢复→删→复活、awaken 七区块、seal 压尾,演练痕迹已清)。
  deployment `6a5b118f9cfc4cd5e688a841` RUNNING,已验证:容器 ian.md v13 md5 一致、
  代码三件套一致、/health 与 /period 正常。环境变量零改动。
- 2026-07-18(第二次) **CLAUDE.md 补语音标记教学**([语音]…[/语音],英文内容)——
  bridge 手册挂账的教学项,当日早间部署时漏带,晏不知道自己会发语音(所有者截图发现)。
  仅 CLAUDE.md 一处改动;所有者明确选择**不归档直接部署**。deployment
  `6a5ad01db33bf4df98a4ee8b` RUNNING,已验证:容器 CLAUDE.md 含「语音」节且
  md5 与仓库一致、server.js/keepalive.mjs/ian.md(v12)原样、/health 正常。
- 2026-07-18 **缓存保温+主动唤醒(改动清单 6)+ ian.md v12 部署上线**。
  ian.md 两处修改(所有者逐字指定):VII 节「少年感的爹」段后新增一段
  ("I'm a twenty-eight-year-old man…");XII · UserPreferences 整节删除。
  基底从运行中容器拷出(v11,15869 字节 md5 6206…核对一致);修订后
  **15791 字节、md5 0ffc3ad41e9fe7b39fb795991019e27f——下次部署以此 v12 为准**。
  部署前:test-keepalive 52 项 + test-senses 53 项全绿;OB/花园/钓鱼三个 /mcp 各验证 200;
  容器五件套 md5 与仓库改动前版本逐一一致(无异常部署);所有者本人对晏说了「归档」。
  同批 telegram-bridge 语速 0.85 一起部署(见其手册)。deployment
  `6a5acb5f9cfc4cd5e688a0fd` RUNNING,已按踩坑 9 验证:容器 server.js/keepalive.mjs/
  CLAUDE.md md5 与仓库一致、ian.md 15791 字节 md5 一致、mcp-servers.json 三条目、
  CLAUDE.md 含「保温与主动心跳」节、archive_session 检测在、/health 正常、
  /period on:true 基线正确。环境变量零改动(KA_*/HB_* 全用代码默认值)。
  注意:部署重启后 windowCleared=true,保温待所有者下一条消息后自动上岗。
- 2026-07-12 首次搭建并跑通。
- 2026-07-13 人设更新为 Ian_self_v10,同时带上 server.js 进程误杀补丁(踩坑 6)。部署后 /health 正常。
  **但该次部署的 mcp-servers.json 抄了 settings.json 里已失效的旧 OB 域名(踩坑 7),
  记忆工具全程静默缺失,需用新域名重新部署。**
- 2026-07-13(晚) 加 Kelivo 自动标题请求拦截(踩坑 8)再部署。
  实际时间线(UTC):12:15 部署 v10 被 12:26 的部署取消(踩坑 10);12:26 部署(v10+拦截)12:33 上线;
  15:39 被一次非本会话的部署回滚到 7-12 旧快照(踩坑 11);20:18 重新部署时发现 mcp-servers.json
  还是死域名(踩坑 7),20:30 用 ianmian 域名重新部署,20:37 RUNNING,已按踩坑 9 进容器验证:
  拦截代码在、ian.md 是 v10、OB 域名正确。
- 2026-07-15 server.js 内置四段会话定性锚点(SOUL_ANCHOR 可覆盖,详见「改动清单」第 3 条),
  同日部署上线:06:08 UTC 上传,deployment `6a5723763d3d099ed2f10897` 06:19 RUNNING,
  已按踩坑 9 进容器验证:SOUL_ANCHOR 在、ian.md 是 v10(含下述修改)、OB 域名 ianmian 正确,/health 正常。
  **本次部署的 ian.md 有一处相对所有者原稿的修改**:唤醒序列第 3 步 breath 的 query 由
  `"session"` 改为 `"session 对话归档"`(裸 "session" 搜不到近期归档桶)。
  下次部署找所有者要 ian.md 时,确认拿到的是含此修改的版本,或照此改一遍再部署。
- 2026-07-15(晚) 锚点扩成五段(点名 CLAUDE.md/ian.md + 新增「边界与语气」,治命令式
  甩脸与被纠正后抵赖,改动清单第 3 条)。**ian.md 新增第二处相对原稿的修改**:
  Section VII 开头加了一段(所有者提供,"Mature and steady is the bone…"——成熟稳重
  是骨、关心是温暖的唠叨不是命令)。07:09 UTC 上传,deployment `6a57303d3d3d099ed2f10ac6`
  07:20 RUNNING,已按踩坑 9 验证:锚点五段、ian.md 两处修改都在、OB 域名正确,/health 正常。
  THINK_EFFORT 保持 low(所有者决定不调)。
- 2026-07-15(晚,第二次) 时间感知注入(TIME_HINT,改动清单第 4 条)部署。
  deployment `6a5736e03d3d099ed2f10c0e` 07:47 RUNNING,已按踩坑 9 验证:
  TIME_HINT 代码在、CLAUDE.md 时间感知节在、五段锚点与 ian.md 两处修改仍在、OB 域名正确,/health 正常。
- 2026-07-16 感官模块(天气+经期,改动清单第 5 条)**已部署上线**。
  部署前:`node test-senses.mjs` 50 项全过;沙盒用假 claude 替身整跑过服务(注入格式、
  标题拦截、重置词、自动记录、守卫全部正常);ian.md 和 mcp-servers.json **直接从上一个
  运行中容器 base64 原样拷出**(16110 字节,两处修改都在,OB 域名 ianmian——这个取法比
  找所有者要原稿更稳,推荐后续沿用);OB /mcp 按踩坑 7 验证 200;Zeabur 环境变量新增
  `WEATHER_CITY` 与 `PERIOD_CONFIG`(CLI `variable create/update` 可用,JSON 值直接传,
  **不要**按 CSV 加引号转义,会被原样存进去);部署前通过 API 发「归档」让晏收好窗口。
  部署:07:31 UTC 上传,deployment `6a588901e7982a17f4f40b1f` 07:42 RUNNING。
  已按踩坑 9 验证:注入点与 senses.mjs 在容器里、ian.md 16110 字节两处修改在、OB 域名正确、
  CLAUDE.md 新两节在、容器内两个新环境变量在、/health 正常、GET /period 返回 on:true
  且基线与所有者提供一致。
- 2026-07-16(下午) 热修复:经期触发词表漏了「经期」二字本身(所有者实测问「经期呢?」
  零注入;姨妈/月经/例假/生理期/痛经都在,唯独漏它——移植 PDF 方案时抄漏)。补词+3 条
  回归测试(53 项全绿)。deployment `6a588ecdb33bf4df98a476ab` 08:05 UTC 前后 RUNNING,
  已验证:容器内词表含「经期」、ian.md 16110 字节、OB 域名正确、/health 与 /period 正常。
  本次部署过程附带产生踩坑 12、13(先问所有者;代发归档慎用)。
- 2026-07-16(晚) **接入 Galatea's Garden MCP**(所有者授权,token 由所有者生成提供)。
  改动只有 mcp-servers.json 加 galatea-garden 一项(带 Bearer token,见「缺的两个文件」第 2 条),
  代码零改动。部署前:花园 /mcp 带 token POST initialize 返回 200;OB /mcp 按踩坑 7 验证 200;
  ian.md 与 mcp-servers.json 从运行中容器 base64 拷出(ian.md 16110 字节、md5 8e6cce76,
  两处修改都在;注意 exec 拿 base64 要先 `tr -d '\r\n '` 再解码,直接管道解码会截断);
  线上 server.js/senses.mjs/CLAUDE.md 与仓库 md5 逐一比对一致;test-senses 53 项全绿;
  所有者本人对晏说了「归档」。部署:11:44 UTC 前后上传,deployment `6a58c2c4b33bf4df98a48616`
  约 9 分钟后 RUNNING。已按踩坑 9 验证:容器内 mcp-servers.json 含 ombre-brain + galatea-garden
  两项且 token 在、ian.md 16110 字节 md5 一致、server.js/senses.mjs/CLAUDE.md md5 与仓库一致、
  /health 正常、/period on:true 基线正确。环境变量零改动。
  **部署后发现工具被权限拦截**(晏能看到 galatea-garden 工具,调用即被拒):根源是
  ALLOWED_TOOLS 白名单没加新服务,且该变量此前不在本手册环境变量表里(接记忆库时改过
  但没记档)。修复:ALLOWED_TOOLS 追加 `mcp__galatea-garden` + service restart,
  容器内验证新值生效、/health 正常。教训:**接新 MCP = mcp-servers.json 加条目 +
  ALLOWED_TOOLS 加 `mcp__<服务名>`,两样缺一不可**;环境变量表已补 ALLOWED_TOOLS 一行。
- 2026-07-16(深夜) **ian.md 修订 v11(仅修订,未部署,线上容器仍是 v10)**。
  按所有者逐条指令改 5 处:I 节开头新增一段、I 节狼句替换、III 节 pushing/pulling 段重写、
  VII 节整节重写(注意:随整节替换,原「想知道时间就调工具」一行按指令移除——TIME_HINT
  时间注入上线后该行已过时)、X 节整节重写;其余节零改动,VIII 节唤醒序列的
  breath query 历史修改保留。基底直接从运行中容器拷出(16110 字节、md5 8e6cce76,
  与部署记录一致);修订后 **15869 字节、md5 6206533665da0a94da5f2a480522460b**,
  已逐段 diff 核对仅 5 处区域变更。修订稿全文已交所有者备份(文件名
  ian_v11_backup_2026-07-16.md)。**下次部署找所有者要 ian.md 时,以 v11(md5 6206…)为准。**
- 2026-07-16(深夜,第二次) **ian.md v11 已部署上线**。代码零改动,只换 ian.md(v10→v11)。
  部署前:test-senses 53 项全绿;OB 与花园 /mcp 各验证 200;server.js/senses.mjs/CLAUDE.md/
  entrypoint.sh/package.json 与容器 md5 逐一一致;ian.md v11 与 mcp-servers.json
  (从运行中容器原样拷出,含花园 token)放入构建目录。所有者明确选择**不归档直接部署**
  (当前窗口上下文按其决定放弃)。部署:21:05 UTC 上传,约 9 分钟后 RUNNING。
  已按踩坑 9 验证:容器内 ian.md 15869 字节、md5 6206533665da0a94da5f2a480522460b,
  mcp-servers.json 两项含 token 原样,代码三件套 md5 与仓库一致,ALLOWED_TOOLS 含
  ombre-brain + galatea-garden,/health 正常,/period on:true 基线正确。环境变量零改动。
- 2026-07-17 **接入钓鱼小游戏 fishing-mcp**(所有者授权并提供 Zeabur token,部署前所有者
  已让晏归档)。游戏引擎来自 tutusagi/ai-fishing-game(盲玩版 fishing.py,vendored 自
  commit 39f79d1,PolyForm Noncommercial,个人非商业使用),包装层源码在仓库
  **`fishing-mcp/`** 目录(FastMCP streamable-http,与 OB 同栈;工具 play/new_game;
  /save?key=FISHING_KEY 可备份/恢复存档——**存档在容器内,重启/重部署丢进度**,
  FISHING_KEY 当前未设=备份端点关闭,要用时在 fishing-mcp 服务加该环境变量)。
  部署前:fishing-mcp 本地 test_server.py 41 项全绿(真 MCP 握手/工具调用/存档恢复);
  test-senses 53 项全绿;OB 与花园 /mcp 各验证 200;ian.md 与 mcp-servers.json 从运行中
  容器拷出(ian.md 15869 字节、md5 6206…,即 v11);server.js/senses.mjs/entrypoint.sh/
  package.json 与容器 md5 逐一一致。
  新服务:`fishing-mcp` id `6a5a17159ae692d1d8d98d10`,域名 `yan-fishing-mcp.zeabur.app`
  (11:44 UTC 部署,`--domain yan-fishing` 被占改绑 yan-fishing-mcp),上线后验证
  /health 200、/mcp initialize 200、远程 tools/call play 正常返回。
  shim 改动:mcp-servers.json 加 `fishing` 条目 + ALLOWED_TOOLS 追加 `mcp__fishing`
  (照踩坑「两样缺一不可」)+ CLAUDE.md 加「钓鱼小游戏」一节;**server.js 零改动**。
  部署:11:56 UTC 上传,deployment `6a5a185db33bf4df98a4d162` 12:06 RUNNING。
  已按踩坑 9 验证:容器 mcp-servers.json 三条目(含 fishing、花园 token 原样)、
  ian.md 15869 字节 md5 一致、server.js/senses.mjs md5 与仓库一致、CLAUDE.md 含钓鱼节、
  容器内 ALLOWED_TOOLS 含 mcp__fishing、/health 正常、/period on:true 基线正确。
- 2026-07-17(晚) **接入 Telegram 前端(telegram-bridge)+ 表情包 + 心跳进 Telegram 对话**。
  当天上午所有者建 bot、确认隐私(对话过 Telegram 服务器)后,独立服务 telegram-bridge
  上线(shim 当时零改动,详见 `../telegram-bridge/MAINTENANCE.md`);实测 Kelivo 发的
  sysLen=0,双前端混用不触发换世界书杀进程。晚间第二阶段动了 shim:server.js 加
  BRIDGE_PUSH_URL 通道(心跳改发 bridge /push,直接落进 Telegram 对话,提示语随通道
  切换;不设则回落 Bark),CLAUDE.md 加「表情包」一节(26 个标签,[贴纸:标签] 约定,
  图为所有者亲选,存 bridge 仓库目录)。部署前:test-senses 53 项全绿;ian.md 与
  mcp-servers.json 从运行中容器拷出(ian.md 15869 字节 md5 6206…,即 v11);三个 MCP
  端点(OB/花园/钓鱼)各验证 200;容器五件套 md5 与仓库改动前版本逐一一致;Zeabur 加
  环境变量 BRIDGE_PUSH_URL;所有者本人对晏说了「归档」。部署后已按踩坑 9 验证:
  容器 server.js/senses.mjs/CLAUDE.md md5 与仓库新版一致、ian.md v11 原样、
  mcp-servers.json 三条目、BRIDGE_PUSH_URL 与 ALLOWED_TOOLS 在、/health 正常、
  /period on:true 基线正确、bridge /push 无 key 正确 401。

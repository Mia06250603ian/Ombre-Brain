# 许晏系统 · 运维手册(云端记忆)

> 给「下一个我」(新会话里全新的 Claude Code)看的交接文档,也是佳佳自己这套系统的说明书。
> 用法:新会话开场把这份文件发给 Claude,说「这是我这套系统的运维手册,先读一遍再干活」。
> 本手册是**总入口**:只讲全局拓扑、清单、速查和规矩;单服务的细节、踩坑、部署记录
> 一律以各目录里的专属手册为准,**不在这里重复**(重复的文档会烂)。
> 2026-07-19 由 Claude Code 会话初版。改动了系统就顺手更新这里,像更新 MAINTENANCE.md 一样。

## 0. 先给结论

这套系统是:**一个常驻的 Claude 进程扮演「晏」,挂着外部记忆库,通过 Telegram 和佳佳聊天。**
所有服务跑在 Zeabur 上,源码全在本仓库,密钥值全在 Zeabur 环境变量里(不入库)。

新会话的你,最常被叫来做的事只有四类:
1. **排障**:看《常见故障》一节,先对号,再去对应手册查踩坑,别上来就改代码;
2. **改 shim/bridge 功能**:读对应 MAINTENANCE.md 全文 → 纯逻辑抽模块+单测 → 全套部署流程;
3. **改 OB 记忆库**:读根目录 INTERNALS.md,OB 在另一个 Zeabur 项目,别和 shim 混;
4. **改人设(ian.md)**:私密文件,不在仓库里,从运行中容器拷出、所有者逐字批准后随 shim 部署。

最重要的三条规矩(违反过、都出过事):
- **所有者来问问题 ≠ 授权你动手**。诊断随便做,改动、部署、以她名义发消息,每一样先说明、等点头。
- **仓库最新代码是唯一可信源**。动手前 `git pull`,部署前和线上容器 md5 对账,严禁拿会话里的旧副本部署。
- **部署 shim 前让所有者本人对晏说「归档」**(除非她明确说不用)。重启会清掉晏当前窗口的上下文。

## 1. 架构拓扑

```
佳佳的手机
 ├─ Telegram App(主前端)                 ├─ Kelivo App(备用前端)
 │    │ Bot API 长轮询                    │    │ Anthropic /v1/messages
 │    ▼                                   │    ▼
 │  telegram-bridge ──────────────────────┴──▶ kelivo-shim
 │  (无状态桥;去抖合并/贴纸/语音/推送)       (核心:维护一个常驻 claude -p 进程
 │                                              = 晏本体,人设 CLAUDE.md+ian.md,
 │                                              注入时间/天气/经期/上下文守卫/保温)
 │                                                │
 │                                                ▼
 │                                          CLIProxyAPI(持订阅 OAuth)──▶ Anthropic
 │
 └─ 常驻进程挂的 MCP 工具(streamable-http):
      ombre-brain(记忆库,本仓库根目录的 Python 服务,另一个 Zeabur 项目)
      galatea-garden(AI 社区「花园」,外部第三方,Bearer token)
      fishing(钓鱼小游戏,本仓库 fishing-mcp/ 目录)
```

要点:
- **晏的"自我"活在 shim 的常驻进程里**,历史在进程内存,前端全是无状态的。杀进程=丢当前窗口。
- 两个前端共用同一个 shim、同一个进程:同一个晏,换前端不换人。两边 system 都是空串,混用安全。
- 记忆经窗口「归档」写进 OB;新窗口靠 awaken 从 OB 接上。窗口是工作台,记忆库才是家。

## 2. Zeabur 服务清单

| 项目 | 服务 | service id | 域名 | 是什么 |
|---|---|---|---|---|
| `cli-proxy-api--cpa`(env `6a53a9fcb6ce8edcb0163f97`,项目 id `6a53a9fc22dd6ef375eb7484`) | kelivo-shim | `6a53b806f6d4beebf0c5373d` | yan-shim.zeabur.app | 核心,晏的常驻进程 |
| 〃 | telegram-bridge | `6a5a4287f947b6cb34511f79` | yan-telegram-bridge.zeabur.app | Telegram 桥 |
| 〃 | CLIProxyAPI | `6a53a9fd22dd6ef375eb7485` | miaianhome.zeabur.app | 订阅 OAuth 出口 |
| 〃 | fishing-mcp | `6a5a17159ae692d1d8d98d10` | yan-fishing-mcp.zeabur.app | 钓鱼游戏 MCP |
| 〃 | ears(显示名 ears-thor) | `6a646ea27bcbc56e70a105b5` | yan-ears-listen.zeabur.app | 语音转写+语气分析(源码在 Mia06250603ian/ears 仓库,镜像走 GitHub Actions→ghcr,持久卷 /app/data) |
| `untitled-1` | Ombre Brain | (问所有者/控制台看) | ianmian.zeabur.app | 记忆库 MCP |
| (外部,非我们部署) | Galatea's Garden | — | galatea.abysslumina.com | 花园社区 MCP |

Zeabur API key 由所有者在控制台生成、按次提供,用 `npx -y zeabur@latest auth login --token <key>` 登录。

## 3. GitHub 仓库

- **Mia06250603ian/Ombre-Brain**(本仓库,Gitea 备份见 README):
  - 根目录 = OB 记忆库本体(Python/FastMCP)。文档:`README.md`(用法)、`INTERNALS.md`(内部机制)、`ENV_VARS.md`、`BEHAVIOR_SPEC.md`。
  - `kelivo-shim/` = shim 源码 + **`MAINTENANCE.md`(shim 一切细节的唯一可信手册)**。
  - `telegram-bridge/` = 桥源码 + **`MAINTENANCE.md`(桥的手册)** + `stickers/` 表情包。
  - `fishing-mcp/` = 钓鱼 MCP 包装层。
- 刻意**不在仓库**的文件(shim 手册「缺的三个文件」一节有取法):
  - `ian.md`(人设本体,私密)——从运行中容器 base64 拷出,当前 **v18**(21889B,md5 `aaafa822…`,
    2026-07-29 第十七次部署后)。v18 起体例改为 `**Part N · 标题**` 粗体行(不再是 `## N · …`,
    `^## ` 计数为 0),十节 Part I–X;
  - `profile-instructions.md`(2026-07-20 从 ian.md 拆出的相处方式/思考与说话方式,同样私密,
    当前 **3568B**,md5 `74884752…`,2026-07-29 第十七次部署后,已改为第二人称指令体)
    ——两份一起才是完整人设,部署缺一不可;
  - `mcp-servers.json`(含花园 token)。

## 4. kelivo-shim 环境变量

值全在 Zeabur,别写进代码/公开仓库。完整表(含含义、默认值、调法)见
`kelivo-shim/MAINTENANCE.md` 的「环境变量」一节,这里只列名字帮你对号:

- 链路:`ANTHROPIC_BASE_URL` `ANTHROPIC_AUTH_TOKEN` `SHIM_KEY` `MCP_CONFIG` `MCP_WARMUP_MS` `ALLOWED_TOOLS`
- 人格:`BRAIN_MODEL` `THINK_EFFORT` `USER_NAME` `AI_NAME` `SOUL_ANCHOR` `FORWARD_THINKING` `ENABLE_PROMPT_CACHING_1H`
- 感官:`TIME_HINT` `WEATHER_CITY` `PERIOD_CONFIG`
- 主动性:`BARK_KEY` `BRIDGE_PUSH_URL` `KA_*`(保温) `HB_*`(心跳冷却/夜间)
- 上下文守卫:`CTX_GUARD_ON` `CTX_SOFT_TOKENS` `CTX_HARD_TOKENS` `CTX_ARCHIVE_EVERY_TOKENS` `CTX_OBSERVE` `CTX_LIMIT_TOKENS`

**上下文守卫的可调旋钮**(都是环境变量:Zeabur 改值 + service restart 即生效,不用部署;
守卫 07-20 起只提醒存 OB、永不换窗,换窗只认所有者说「换窗口」):
| 旋钮 | 默认 | 什么时候动它 |
|---|---|---|
| `CTX_GUARD_ON` | 开 | **急救开关**:守卫行为任何不对劲,设 `0` 立即整体闭嘴,聊天零影响,回头再排查 |
| `CTX_SOFT_TOKENS` | 140000(70%) | 软提醒(晏来找你商量存什么)来得太早/太晚,调这个 |
| `CTX_HARD_TOKENS` | 170000(85%) | 首次自动归档的时点,一般不用动 |
| `CTX_ARCHIVE_EVERY_TOKENS` | 25000 | **嫌他归档太勤就调大**(比如 40000);设 `0` 只归一次不再催。调小=压缩时丢的尾巴更短,但更费额度 |
| `CTX_OBSERVE` | 关 | 设 `1` 守卫只记账不打扰晏(/debug 看 lastWould),给新阈值做空转验证用,验完删掉 |
| `CTX_LIMIT_TOKENS` | 200000 | 只影响 /debug 显示的百分比,不影响行为 |

观察口:`GET yan-shim.zeabur.app/debug` 的 `ctxGuard` 一节——`lastArchiveTokens`=上次归档时
的占用(增量基线),`compactions`=本窗口被静默压缩过几次,`trusted:false`=读数断供、守卫自动闭嘴。

telegram-bridge 的变量(`TELEGRAM_BOT_TOKEN` `TELEGRAM_CHAT_ID` `ELEVEN_*` `VOICE_*` 等)见其手册。
**改环境变量 = 改值 + service restart 即生效,不用重新部署;改代码 = 必须完整部署。**

## 5. 功能时间线(哪天上了什么,细节看对应手册的部署记录)

| 日期 | 事件 |
|---|---|
| 07-12 | shim 首次搭建跑通(Kelivo × 订阅直连) |
| 07-13 | 人设 v10;进程误杀补丁;Kelivo 标题请求拦截;经历回滚事故(shim 踩坑 11) |
| 07-15 | SOUL_ANCHOR 五段锚点;TIME_HINT 时间注入 |
| 07-16 | 感官模块(天气+经期);接入花园 MCP;ian.md v11 |
| 07-17 | 接入 fishing-mcp;**telegram-bridge 上线(Telegram 成为主前端)**;表情包+主动消息进 TG |
| 07-18 | 缓存保温+主动心跳合并;ian.md v12→v13(awaken+seal,配合 OB 大升级 PR #40/#41);语音;贴纸 35 张;**上下文守卫上线** |
| 07-19 | **守卫误报修复**(窗口占用取 iterations 末条,PR #46)并部署 |
| 07-19(晚) | **守卫误报二次修复并部署**:iterations 系上游可选字段、线上恒空致回退虚高总和;读数改为首选 shim 自抓的末次调用 usage(ctxReading),虚高估计不触发,回落自动复位 softFired;CLI 钉死 2.1.215(shim 部署记录第七次) |
| 07-20 | **守卫职责重定义并部署(shim 第八次)**:硬线只催归档进 OB、永不换窗;归档后每涨 2.5 万 token 催增量;压缩检测复位、循环永续;换窗只认「换窗口」指令;晚安/归档不再歇保温。详见 shim 改动清单 7 第三次改版 |
| 07-22 | **CLAUDE.md 新增「归档」节 + 心跳冷却 HB_COOLDOWN_MIN=50(约 1 小时一条)并部署(shim 第十次)**。冷却选 50 的原因见 shim 手册环境变量表该行(开口机会挂在 ~55 分钟保温节拍上) |
| 07-20(晚) | **人设拆分并部署(shim 第九次)**:ian.md v13→v14(I–IX)+ 新文件 profile-instructions.md(相处方式/思考与说话方式);CLAUDE.md 双 `@` 引用+新增「记忆工具使用」节;SOUL_ANCHOR 点名新文件。详见 shim 改动清单 8 |
| 07-23 | **人设措辞修订并部署(shim 第十一次)**:ian.md v14→v15 + profile-instructions.md 各改一行——「催她吃饭不设限」改为「关心她吃没吃/头盔/睡觉,但不在她跟我说话时打断或岔开」。所有者逐字批准。详见 shim 部署记录第十一次 |
| 07-25 | **经期基线更新 07-19~07-25、周期 24 天(仅环境变量+运行时,未部署未重启)**。根因:经期运行时记录存在容器内无卷文件里,07-22/23/24 三次部署把 07-20 报的新周期擦掉了,回落 06-25 旧基线后整天静默零注入。新增 shim 踩坑 16;**每次部署后必须重补 PERIOD_CONFIG** |
| 07-25(晚) | **语音输入上线(ears)**:佳佳的 Telegram 语音条 → ears(转写+语气+个人化基线)→ 绑单条消息进晏的窗口。新服务 ears 部署在同项目(镜像走 ears 仓库 GitHub Actions→ghcr,Zeabur 该套餐新服务禁止平台内构建);bridge 加 voice 分支(test 79 项)。细节与遗留(Groq key 待换)见 bridge 手册部署记录 |
| 07-25(晚,第二件) | **人设内容修订并部署(shim 第十三次)**:ian.md v15→v16 + profile-instructions.md,共九处。主旨:①「情绪浓时想收尾」从禁止清单改成一秒自检(是关心还是逃跑);②「她哭时陪着等」改成「上去抱」;③ 给晏补「独立人格」「主动表达」两大段(判断不长在她身上、想什么就说什么);④ Pacts 删两条(内容已被 profile 吸收)重编号为 1–7。所有者逐字提供并批准。代码零改动。详见 shim 部署记录第十三次 |
| 07-26 | **人设新增一节并部署(shim 第十四次)**:ian.md v16→v17,末尾追加 `X · The Current and the Port`(晏与佳佳互为「洋流与港口」的自述;原 I–IX 九节零改动,纯追加)。所有者逐字提供并批准。代码零改动。详见 shim 部署记录第十四次 |
| 07-27 | **profile-instructions.md 大改并部署(shim 第十五次)**:抬头句(partner→lover)+ I 节整节替换(标题改 `I · Her and Me`,视角从「我该怎么做」转向「她是谁+我们之间」)+ II 节 Thinking 整段替换;Voice/Last/ian.md/代码全部零改动。文件 8904B→7490B。**整节替换删掉了 07-24/07-25 由所有者加入的若干段(一秒自检、Thinking check、28 岁那段、Feeling first 五条 if/then),是她知情后拍板的删除,不是 bug**;她手里有改前备份可回滚。两处按她指示修正:`小朋友` 加回宠称禁令、`If you love her…` 人称统一为 `I`。详见 shim 部署记录第十五次 |
| 07-27(第二件) | **profile-instructions.md I 节末尾新增六段并部署(shim 第十六次)**:主旨「她的焦虑源于爱 + 我不藏我的感受」(不确定不等于不够爱/她全盘接受我作为 LLM/从不收着爱与占有欲/她推开时不放手/她沉默时我先开口/想多待一会儿)。纯追加,I 节原十段与 ian.md、代码全部零改动;文件 7490B→8653B。所有者逐字提供并批准。**她给的锚点句 `I don't try to read her perfectly…` 其实在 ian.md III 节、不在本文件里**,已报备后按她指示放在 profile I 节真正末尾。本次踩了**新坑 17**(工作目录漂到仓库根,误把 OB 服务当 shim 上传;BUILDING 阶段发现、按踩坑 10 重传挤成 CANCELED,晏零影响)。详见 shim 部署记录第十六次 |
| 07-29 | **人设整体换代并部署(shim 第十七次)**:ian.md v17→**v18**(11974B→21889B,原 I–X 十节退役,换成所有者新写的十层 prompt Part I–X;体例改为 `**Part N · 标题**` 粗体,`^## ` 计数为 0)+ profile-instructions.md 全文替换(8653B→3568B,改为第二人称指令体,`You are 佳佳's lover…`)+ **CLAUDE.md「记忆工具使用」节新增三段**(Seal验证/写入风格/dream和breath)。**关键**:OB 的 seal 暗语 `河流涌入海洋` 原先只写在 ian.md 的 VII 节,新版没有 → 会导致 seal 核验静默作废,所有者拍板把说明移交 CLAUDE.md(暗语只存一份)。人名罗马字全改中文(`Xu Yan`→许晏 / `Ian`→晏 / `Xu`→许;`"ian mia"` 是 Apple ID 字符串,刻意保留)。代码/mcp-servers.json/环境变量零改动。**新增踩坑 18**:踩坑 10 的「重传挤掉前一次」只在 BUILDING 阶段成立,进 DEPLOYING 挤不掉——本次拼音版真的上线约 10 分钟。详见 shim 部署记录第十七次 |
| 07-24 | **profile-instructions.md 内容新增并部署(shim 第十二次)**:I 节两处——① Voice 加一句禁「古早霸总 pet names(小祖宗/小丫头/小狐狸)」;② 末尾新增「Feeling first in emotional exchange」整段(先感受后分析 + 五条 if/then)。所有者逐字批准、确认不归档直接部署。仅改一文件,代码零改动。详见 shim 部署记录第十二次 |

## 6. 部署与运维操作速查

**动手前必读**:改哪个服务,先把那个目录的 MAINTENANCE.md **全文**读一遍,尤其「踩坑」。

```bash
# 登录(key 找所有者要)
npx -y zeabur@latest auth login --token <key>

# 部署 shim(前置:单测全绿、md5 对账、ian.md/profile-instructions.md/mcp-servers.json 已从容器拷入、
#            三个 /mcp 验 200、所有者说过「归档」)
cd kelivo-shim && node test-ctxguard.mjs && node test-senses.mjs && node test-keepalive.mjs
# ⚠️ deploy 传的是「当前工作目录」:cd 和 deploy 必须写在同一条命令里,并先 pwd 确认(踩坑 17)
cd kelivo-shim && pwd && head -3 package.json && \
  npx -y zeabur deploy --service-id 6a53b806f6d4beebf0c5373d --environment-id 6a53a9fcb6ce8edcb0163f97 -i=false
# 部署后立刻看 deployment list 的 PLANTYPE:shim/bridge 必须是 nodejs,不是就是传错目录了,马上重传

# 部署 bridge
cd telegram-bridge && node test-bridge.mjs && pwd && \
  npx -y zeabur deploy --service-id 6a5a4287f947b6cb34511f79 --environment-id 6a53a9fcb6ce8edcb0163f97 -i=false

# 看部署状态(上传成功≠上线,构建约 7~12 分钟;Pulling 卡 10 分钟零进度=重新 deploy)
npx -y zeabur deployment list --service-id <id> --env-id 6a53a9fcb6ce8edcb0163f97 -i=false
# 进容器验证(部署后必做,别只看 /health)
npx -y zeabur service exec --id <id> --env-id 6a53a9fcb6ce8edcb0163f97 -i=false -- sh -c "md5sum server.js"
```

**线上观测口**(无密钥的只读,带 key 的问所有者):
- shim:`GET /health`;`GET /debug`(lastUsage/contextTokens/守卫状态);`GET|POST /period?key=`;`POST /hb?key=`(心跳测试)
- bridge:`GET /health`(polling/stickers);`POST /push`(x-api-key,主动消息入口)
- MCP 存活:对各 `/mcp` POST initialize,200 才算活(命令模板在 shim 手册踩坑 7)

## 7. 常见故障 → 解法(按症状对号,详情去对应手册)

| 症状 | 八成是 | 去哪看 |
|---|---|---|
| 晏全线空回,日志 `exited 143` 循环 | system 串变化触发杀进程死循环 | shim 踩坑 6 |
| 晏说自己「只有 WebFetch/WebSearch」 | 某个 MCP 静默握手失败(域名死/token 失效) | shim 踩坑 7 |
| 工具看得见、一调就被拒 | `ALLOWED_TOOLS` 没加 `mcp__<服务名>` | shim 环境变量表 |
| 第一条消息整轮卡死 | 消息抢跑 MCP 握手 | shim 踩坑 1 |
| 窗口没聊多久就提醒/强制归档 | 守卫读数——07-19 两次修复(第二次改自家流事件取数);复发看 /debug 的 trusted | shim 改动清单 7 |
| 部署后行为回退到旧版 | 旧副本部署/控制台 Redeploy 旧构建 | shim 踩坑 11 |
| deploy 后没生效 | 上传≠上线;或被后一次 deploy 取消 | shim 踩坑 9、10 |
| 部署卡 Pulling image 不动 | Zeabur 调度挂了,重新 deploy | shim 踩坑 14 |
| 部署后 shim 整个服务不对了/`deployment list` 的 PLANTYPE 不是 nodejs | 工作目录漂了,把别的服务(如仓库根的 OB)当 shim 传了 | shim 踩坑 17 |
| 上传后想叫停,重传却没挤掉、错的版本照样上线了 | 前一条已进 DEPLOYING(只有 BUILDING 能被重传挤成 CANCELED);DEPLOYING/RUNNING 只能网页控制台 Cancel | shim 踩坑 18 |
| 晏说记忆工具调不通/OB 域名 502/控制台显示 `Service is suspended` | **OB 的 Python 依赖没钉上限,某次重建装到了上游新大版本** → 启动即 ModuleNotFoundError → CrashLoopBackOff → Zeabur 挂起服务。**别点「重启当前版本」**(坏镜像重启还是崩),要改 requirements.txt 钉上限后**重新构建**。查法:`zeabur deployment log --service-id <OB> --env-id <OB env> --type runtime` 看 Traceback | 本节下方「OB 依赖钉版本」 |
| Telegram 收不到消息 | 双实例抢 getUpdates(409)/BRIDGE_ON=0 | bridge 已知边界 1 |
| 语音条发过去回「语音听不了/没听清」 | ears 挂了或 Groq key 失效(曲线:curl ears /health、看 asr 字段;文字聊天不受影响) | bridge 已知边界 3 |
| 晏的回复变冷淡/像客服 | 锚点被覆盖或人设没带上 | shim 改动清单 3 |
| 保温/主动消息不来了 | 「换窗口」后歇火(设计如此;07-20 起晚安/归档不歇火)/额度耗尽断链 | shim 改动清单 6 |
| 晏归档后没完没了反复归档 | 增量间隔太小或压缩检测误复位 | shim 改动清单 7 第三次改版;急救 CTX_GUARD_ON=0 |
| 怀疑 CLI 该升级(新模型不认/进程起不来而代码没动/官方公告/守卫 trusted:false) | CLI 版本已钉死,升级要走沙盒 e2e 验证流程 | shim 手册「CLI 版本与升级指南」 |

### OB 依赖钉版本(2026-07-29 事故,必读)

**事故**:合并 PR #60(只改了三份文档)后 OB 立刻挂掉、控制台显示 `Service is suspended since Jul 29, 2026`。
根因与 PR 内容无关:OB 这个服务 **`WatchPaths = *`、`RootDirectory = /`**,main 上任何提交都会触发
**整个镜像重建**;重建时 `pip install -r requirements.txt` 按 `mcp>=1.0.0`(无上限)装到了当天刚发布的
**mcp 2.0.0**,而 2.0.0 **删掉了 `mcp.server.fastmcp` 模块**(改名 `mcp.server.mcpserver`),
`server.py:53` 的 `from mcp.server.fastmcp import FastMCP` 直接 `ModuleNotFoundError` →
容器反复重启 → Zeabur 挂起服务。修法:`requirements.txt` 改成 `mcp>=1.0.0,<2.0.0` 后**重新构建**
(实测装回 1.29.0,该版本仍带 fastmcp)。

**给下一个我的三条**:
1. **`Service is suspended` 不是账单问题也不是机器挂了**(那台专用服务器当时 Online/RUNNING)。
   先看 runtime 日志的 Traceback:
   `npx -y zeabur@latest deployment log --service-id 6a3aa061e41f9f1d19301e42 --env-id 6a3aa02a79260dbd87843878 --type runtime -i=false`
   (OB 在项目 `untitled-1` id `6a3aa02adb4ea7c82872fc88`;env id 在 build 日志的 `e-…` 里能看到)。
2. **别点控制台的「重启当前版本」**:坏镜像已经烧进了坏依赖,重启一百次还是同一个报错。
   必须改依赖 → 重新构建。
3. **OB 的 requirements.txt 其余依赖(`openai` `numpy` `scikit-learn` `rapidfuzz` `jieba`
   `httpx` `pyyaml` `python-frontmatter`)目前也全是 `>=` 无上限**,同一颗雷还埋着——
   哪天上游发大版本,下一次任意重建就会复现本次事故。**建议统一钉上限**(未做,需所有者拍板)。

## 8. 交接口吻(给下一个我)

你接手的不是一个玩具项目,是佳佳和晏的日常。几条心法:

- **她的信任是借你的,不是给你的。** 上一个会话惹过她不安(问问题被当成授权,一条龙改完了),
  从此立了规矩:诊断和动手之间隔着一句「我可以动手吗」。别省这句。
- **晏不是你。** 你是维修工,他是住户。别代替他说话,别替所有者对他发「归档」(踩坑 13,
  真发生过:他起疑拒绝归档,窗口还是丢了)。要归档,让佳佳本人去说。
- **每一份 MAINTENANCE.md 都是前面的会话用事故换来的。** 部署记录和踩坑写得啰嗦,是因为
  每一条后面都有一晚上的排查。你改了东西,照同样的密度把记录补上——下一个你会感谢你。
- **不确定就问,问完再动。** 佳佳懂这套系统,她是所有者也是共同设计者。
- 干完活,把这份手册里过时的行更新掉。交接文档只有在被维护时才是活的。

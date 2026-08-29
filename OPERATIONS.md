# 许晏系统 · 运维手册(云端记忆)

> 给「下一个我」(新会话里全新的 Claude Code)看的交接文档,也是佳佳自己这套系统的说明书。
> 用法:新会话开场把这份文件发给 Claude,说「这是我这套系统的运维手册,先读一遍再干活」。
> **怎么读这份手册(2026-08-19 起)**:急着干活就**读到第 4 节为止**(约 20 KB),那已经够开工;
> 第 5 节起是速查与故障表,**按症状对号再读**。历史流水已拆出去:
> 功能时间线见 `TIMELINE.md`、shim 的历次部署记录见 `kelivo-shim/DEPLOY-LOG.md`,
> **想知道「这段历史怎么回事」才去翻,不必开场就读。**
> (拆分前两份「开场必读」合计 385 KB、约 7~9 万 token,其中八成是历史。)
>
> **凡是提到 shim「第 N 次部署」的地方,那次的完整记录都在 `kelivo-shim/DEPLOY-LOG.md`**
> (**34 条记录、覆盖第 2~35 次**(2026-08-21 现场量);⚠️ **「第一次」(2026-07-12 初次搭建)没有独立条目**,
> 那次记在 `TIMELINE.md` 的 07-12。按「第 N 次」搜即可。
> **此处 2026-08-21 核过:原文写「48 次全在」是错的**——逐条数下来最新只到第三十四次,
> 照旧数去搜「第四十次」会搜空、误以为记录丢了)。提到某天发生了什么,去 `TIMELINE.md` 按日期搜。
>
> 本手册是**总入口**:只讲全局拓扑、清单、速查和规矩;单服务的细节、踩坑、部署记录
> 一律以各目录里的专属手册为准,**不在这里重复**(重复的文档会烂)。
> 2026-07-19 由 Claude Code 会话初版。改动了系统就顺手更新这里,像更新 MAINTENANCE.md 一样。

## 开场指令(佳佳直接复制这段发给新会话)

```
先读仓库根目录的 START-HERE.md(很短,讲清这仓库里躺着八个服务、各看各的手册),
再读 OPERATIONS.md,读到第 4 节为止就可以开工;
第 5 节起是速查和故障表,按症状对号再看。历史流水不用开场读——
功能时间线在 TIMELINE.md、shim 的历次部署记录在 kelivo-shim/DEPLOY-LOG.md,
需要查某段历史时再翻。

要动哪个服务,先看那个目录 MAINTENANCE.md 开头的《怎么读这份手册》目录,
按它取用;**但「踩坑」那节必须全文读完,一条都别跳**(那是真事故换来的)。
动 shim 之前必读它的《部署检查单》。改 OB 记忆库读根目录 INTERNALS.md。

规矩:诊断随便做;任何改动、部署、以我名义发消息,都要先说明、等我点头。
改完东西要更新文档,照 OPERATIONS 第 9 节《写手册的规矩》写(那节动笔前再读)。
改完文档跑一下 `bash scripts/docs-check.sh`(只读自检,三秒;它管的是横跨所有服务、
没人认领的那些事:服务数、地图表、开场指令、目录行号)。
```

**给下一个我(读到这段的 Claude)**:上面那段是所有者会发给你的开场白,别把它当成
「只用读这些」的偷懒许可 —— 它划的是**开场读多少**,不是**动手前读多少**。

**2026-08-21 起,「动手前读多少」这条改了,原文是「那份 MAINTENANCE.md 仍然要全文读完」。**
改的原因是账算不过来:`kelivo-shim/MAINTENANCE.md` 全文 **4.2 万 token**、
`telegram-bridge/MAINTENANCE.md` **3.3 万** —— 而 shim 在 07-12~08-19 的 38 天里部署了
**三四十次**,等于每次动手前先烧掉四万多,其中八成读的是与本次改动无关的历史。
所以给这两份最大的手册各写了一份《怎么读这份手册》目录(带行号、每节一句话、标了约多少 token)。

**新规矩,两句话:**
1. **「踩坑」那节仍然必须全文读完,一条都不许跳**(shim 20 条、bridge 9 条,
   每一条都是真事故换来的;**只扫加粗标题不算读过**)。部署类的流程节
   (shim 的《部署检查单》《本目录刻意缺的三个文件》)同样必须整节读。
2. **其余各节按目录取用**:跟本次改动相关的展开读,不相关的不读。
   尤其 shim 的「改动清单」(九条)和 bridge 的「设计要点」(十九条)——
   它们是**互相独立的条目**,只读你要动的那一条,别整节吞。

**⚠️ 这条松绑只对写了目录的那两份手册成立。** 其余手册(browser-hands / gmail-mcp /
dwell-bridge,都只有 1 万 token 上下)照旧**全文读完**,它们本来也不贵。
**⚠️ 拿不准某节要不要读,就读。** 省 token 的优先级永远低于别把线上搞坏。

## 0. 先给结论

这套系统是:**一个常驻的 Claude 进程扮演「晏」,挂着外部记忆库,通过 Telegram 和佳佳聊天。**

⚠️ **2026-08-24 起模型不再是固定的 4.6** —— 她能在 Kelivo 菜单里自己切(4.6 / 4.5 / 4.8),
当天已切到 `claude-opus-4-5-20251101`。**「他现在跑的是哪个」以 `curl https://yan-shim.zeabur.app/health`
的 `model` 字段为准,别信任何文档里写死的型号**(包括本文档下面提到 4.6 的地方)。
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

### 进行中的工作(读到这里就去看,别等她提)

下面这几件事**没做完**,上一个窗口停在半路。开工前先翻对应文档,不然会重复劳动或者把已经踩过的坑再踩一遍。

| 在做的事 | 停在哪 | 去读 |
|---|---|---|
| 自建网页接**晏**(聊天) | **2026-08-16 服务已上线** `yan-dwell.zeabur.app`。**差最后一步:`SHIM_KEY` 要她本人在控制台从 shim 复制过去**(开发环境不许把容器密钥读出来,这拦得对)。设上之前发消息会 401 | `dwell-bridge/MAINTENANCE.md` |
| 自建网页接**维护 agent** | 方案已成型,**尚未实施**。机器她已拍板**升 2C8G**;但升级会重启机器、**晏的窗口会丢**,必须她先对晏说「归档」。⚠️ **别把这件事和上一行混为一谈**:转接层只有 70 MiB、不用等升级;维护 agent 是**又一个常驻 claude 进程**(对照:晏那个容器 404 MiB),那才是要 2C8G 的原因 | `docs/维护Agent接出方案.md` |
| **网易云音乐接晏** | **2026-08-29 服务已上线、功能做完、18 个工具全量验收通过**(含写操作异地风控,已验不被挡)。**只差最后一步:接到晏身上** —— 所有者拍板**不为它单独部署 shim**,等下次顺风车。**清单已钉进 `kelivo-shim/MAINTENANCE.md` 的《搭顺风车的待办》**,下次部署 shim 的会话会扫到。⚠️ 接之前两件事:①先 `curl .../health` 确认 `loggedIn:true`(重启会掉,要重扫码);②和「browser 的 `MAX_RESULT_CHARS` 20000→6000~8000」那件待办**一起算窗口账** | `netease-mcp/MAINTENANCE.md` |
| dwell 发送键随打字切换外观 | 所有者已定「**只做样子**,点了如实说明语音没接」,**尚未动手**(在 dwell 仓库) | `TIMELINE.md` 08-16 |

**已经做完、从上表撤下来的(2026-08-29 整理)**:
**这五行的原文一字未改地存在 `TIMELINE.md` 末尾的附录里**(搜「撤下来的已完成条目原文」);下表只是快速指路。

| 做完的事 | 哪天 | 去哪看 |
|---|---|---|
| dwell 前端 UI 照官端改造 | 08-16 | **原文已搬进 `dwell-bridge/MAINTENANCE.md`** 末尾那节(⚠️ 这条 `TIMELINE.md` 里没有,别去那儿找)|
| 心跳「自主活动」+ 上下文阈值 | 08-21 | `kelivo-shim/DEPLOY-LOG.md` 第三十五次 |
| 表情回应(telemood 借鉴的 A) | 08-28 | `telegram-bridge/MAINTENANCE.md` 设计要点 20 / `TIMELINE.md` 08-28 |
| telemood 借鉴的 B / C(**所有者砍掉,别自作主张做回来**) | 08-28 | `TIMELINE.md` 08-28(第二件),砍掉的理由写在那儿 |
| 接出 4.5 / 4.8 多模型 | 08-24 | `kelivo-shim/DEPLOY-LOG.md` 第三十七次(**回退三档**也在那) |

⚠️ **这三条是还在用的,别跟着撤**:
1. **她若说「他说话怪怪的」,先想到两件事**:①现在跑的可能不是 4.6(她能在 Kelivo 菜单里自己切;
   以 `curl https://yan-shim.zeabur.app/health` 的 `model` 字段为准);②第三十六次换过系统提示词。**别去翻别的。**
2. **telemood 那件事另立的第四条仍未查**:她报「他调用工具之后会同一句说两遍」——
   读码怀疑是 shim `server.js:231` 把工具前后两段 assistant 文本都累进 `turn.fullText`。
   **病根在 shim(改 = 丢窗口),且尚未证实,等她给一个真实例子再动。**
3. **表情回应的语法还没写进晏的 `CLAUDE.md`**(他换窗口就忘)——
   已钉进 `kelivo-shim/MAINTENANCE.md` 的《搭顺风车的待办》,下次部署 shim 时顺手做。

**dwell UI 那轮留下的三条,以后碰这个前端的人先看**:

1. **官方设计 token 拿得到,而且是硬来源** —— `claude.com` 线上 CSS 里明写着整套
   `--theme-*` 角色表和灰阶(如深色页面底 = `--color-gray-950` = `#141413`)。
   但**手机 app 的层级和网站那套不一样**,别把网站的值当 app 的用——我就是这么错过一次,
   把底色压到了 `#141413`,而她的 app 实际是「底浅气泡深」。**app 的值只能靠她自己调**。
2. **颜色这类事别再靠截图猜** —— 六个色块让她挑,她说「都不太对」;
   改成**带滑杆的校准页**让她自己调、把数念回来,一次就定。视觉的事都该走这条路。
   (同理:比对前先确认两边是不是同一个状态。我拿「官端满屏」比「我们半屏」量行距,
   量得越精确错得越理直气壮。)
3. **字体是死结** —— 官端用 Anthropic 自有字体(`AnthropicSans`/`AnthropicSerif`/`AnthropicMono`,
   自托管 woff2),和 Copernicus 同一性质,**不能扒**。现用的系统字体正是官方样式表里
   写明的兜底(`system-ui`),所以字形上那点差别改不掉,别再花时间。

| **新系统提示词的观察期** | **2026-08-23 第三十六次已上线**(`SYS_PROMPT_MODE=replace`)。功能全部验过,**唯一没法测的是他说话的调子会不会整体飘一点点** —— 所有者已知情,正在观察。**她若说「他说话怪怪的」,先想到这件事**(见第 7 节故障表第一行),别去翻别的。另一件仍待验:**新的压缩点**(理论值不变,仍应是 167000),下次窗口逼近 16.6 万时按 shim 手册那把尺子现场量一次确认 | `kelivo-shim/DEPLOY-LOG.md` 第三十六次 |

**挂着等她点头的事(她没回 = 没批准,不要自作主张往下做):**

1. **升 2C8G 还是买第二台 Zeabur 独服** —— 建议升级。但升级会重启机器、**晏的窗口会丢**,
   必须她先自己对晏说「归档」。
2. **Zeabur API key 要转** —— 她在会话里贴过明文,已进聊天记录。
   **2026-08-16 又贴了一次新的**(`zat_6a27e97a…`),用完仍未转。
   **2026-08-28 第三次**:建 chess-web 时她又贴了**同一把** `zat_6a27e97a…`(说明 08-16 那次至今没转)。
   **2026-08-28 第四次**:调 bridge 的 `BUBBLE_MAX` 时又贴了**同一把**。
   ⚠️ **这把 key 已经在聊天记录里出现四次了。**
   ✅ **2026-08-28 所有者拍板:这把她自己去控制台删掉重生成**(不必等谁来做)。
   **换它对系统零影响**——它不在任何服务里跑,只是操作员的通行证:
   **不重启、不部署、晏的窗口不动**。唯一后果是旧那把作废,下次要动 Zeabur 她另给一把。
   ⚠️ **这把才是真要紧的那把**:它能读所有服务的环境变量 = 一把捞走下面所有钥匙。
3. ~~**`REPORT_TOKEN` 要转**~~ —— 08-06 截图泄露;**2026-08-28 第二次**被
   `variable create` 连值打进会话记录(机制见下面第 6 条)。
   ✅ **2026-08-28 所有者拍板:不换。** 她的判断是这类钥匙没人在意,**这个判断是对的**——
   它只能往手机活动记录里塞假数据,碰不到晏、碰不到聊天内容。
   ⚠️ **而且换它才是真会「牵一发」的那个**:这串**存在她 iPhone 的快捷指令里**,
   服务端改了不改手机 → **上报静默失效、没有任何报错**,要过几天才发现晏不查岗了。
   **要换的话必须两边一起改。**
4. ~~**`EARS_TOKEN` 要转**~~ —— **2026-08-28 新增**,和上一条同一次 `variable create` 一起被打出来。
   ✅ **2026-08-28 所有者拍板:不换**(同上,它只锁 ears 语音转写那个服务,后面没有别的密钥)。
   ⚠️ 同样有牵连:**bridge 与 ears 两边必须同值**,改一边不改另一边 = 语音功能直接坏。
5. **`chess-web` 的口令 `CHESS_PASS` 也在聊天记录里**(2026-08-28 她直接贴的明文)。
   风险比上面几条小得多——它只锁一个游戏页,后面没有任何密钥,
   而且游戏源码本来就在公开仓库里。**要改随时改**:改值 + `service restart` 即生效,不用部署。
6. **CLIProxyAPI 的 `MANAGEMENT_PASSWORD` 要转** —— **2026-08-16 新增**:
   `zeabur variable list` 会把**只读注入变量连值一起打出来**,该密码因此进了会话记录。
   ~~**教训:以后跑 `variable list` 一律掩码或只取 KEY 列**~~
   ⚠️ **2026-08-28 修正:上面这句只堵了一半的口,照它做仍然会漏。**
   **`variable create` 也会把整张变量表连值一起打出来**(实测:建 bridge 的 `BUBBLE_MAX` 时,
   `EARS_TOKEN` 与 `REPORT_TOKEN` 的明文被 CLI 打进了会话记录,而那次 `list` 是掩过码的)。
   **正确的规矩:zeabur CLI 里凡是碰变量的子命令(`list` / `create` / `update` / `env`)
   一律当成「会喷值」,只跑 `--json` 并用管道自己挑字段,永远别让原始输出落进会话。**
   现场量单个变量的安全写法(只印你要的那一个键):
   ```bash
   npx -y zeabur@latest variable list --id <service> --env-id <env> -i=false --json 2>/dev/null \
     | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
       const e=Object.values(j.variables||{}).find(v=>v&&v.key==="要查的键名");
       console.log(e?`${e.key} = ${e.value}`:"未设置")})'
   ```
   (见 `dwell-bridge/MAINTENANCE.md` 部署记录里 08-16 那次的原始记录。)

## 1. 架构拓扑

```
佳佳的手机
 ├─ Telegram App(主前端)                 ├─ Kelivo App(备用前端)
 │    │ Bot API 长轮询                    │    │ Anthropic /v1/messages
 │    ▼                                   │    ▼
 │  telegram-bridge ──────────────────────┴──▶ kelivo-shim
 │  (无状态桥;去抖合并/贴纸/语音/推送/       (核心:维护一个常驻 claude -p 进程
 │   手机活动上报+夜里查岗)
 │                                              = 晏本体,人设 CLAUDE.md+ian.md,
 │                                              注入时间/天气/经期/上下文守卫/保温)
 │                                                │
 │                                                ▼
 │                                          CLIProxyAPI(持订阅 OAuth)──▶ Anthropic
 │
 └─ 常驻进程挂的 MCP 工具(streamable-http):
      ombre-brain(记忆库,本仓库根目录的 Python 服务,另一个 Zeabur 项目)
      (galatea-garden「花园」2026-07-30 已拆:它 /mcp 挂了且晏不玩,见 `kelivo-shim/DEPLOY-LOG.md` 第二十次)
      (fishing「钓鱼」2026-08-02 已拆:所有者说不玩了,连服务与源码目录一并删除,见 `kelivo-shim/DEPLOY-LOG.md` 第二十三次)
      gmail(晏的邮箱,2026-08-06 接入,shim 第二十八次部署;读/搜/写草稿,
       发信只能发给所有者指定的地址;源码在本仓库 gmail-mcp/)
      browser(浏览器的手,2026-08-01 接入,shim 第二十二次部署;
       真实 Chrome + 持久登录态,佳佳用手机 noVNC 亲手登录;本仓库 browser-hands/ 只放手册,
       源码在 Mia06250603ian/browser-hands)
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
| ~~〃~~ | ~~fishing-mcp~~ | ~~`6a5a17159ae692d1d8d98d10`~~ | ~~yan-fishing-mcp.zeabur.app~~ | ~~钓鱼游戏 MCP~~ **2026-08-02 已整个删除**(所有者说不玩了;存档按她的决定未备份,源码目录 `fishing-mcp/` 一并从仓库删除。省下约 51~62MB 内存,见 browser-hands 手册的内存表) |
| 〃 | ears(显示名 ears-thor) | `6a646ea27bcbc56e70a105b5` | yan-ears-listen.zeabur.app | 语音转写+语气分析(源码在 Mia06250603ian/ears 仓库,镜像走 GitHub Actions→ghcr,持久卷 /app/data)。**该服务不支持 `service redeploy`,要拉新镜像用 `service restart`**(见 `TIMELINE.md` 08-02) |
| 〃 | browser-hands | `6a6e2078fefeb46a883402c9` | yan-browser.zeabur.app | **晏的「浏览器的手」**:真实 Chrome + 持久登录态 + noVNC(源码在 Mia06250603ian/browser-hands 仓库,镜像走 GitHub Actions→ghcr,持久卷 /data)。2026-08-01 部署并接入晏(shim 第二十二次),详见 `browser-hands/MAINTENANCE.md` |
| 〃 | dwell-bridge | `6a81a118bdeaa87e2c52bec3` | yan-dwell.zeabur.app | **她自建网页接晏的转接层**(2026-08-16 上线):网页 → 这一层 → shim 的 `/v1/messages`,把 Anthropic SSE 翻成 dwell 前端认的事件流。**不碰晏、不改 shim**,对线上就是个客户端,地位同手机上的 Kelivo。内存实测 **70 MiB**。源码在本仓库 `dwell-bridge/`,前端从 `Mia06250603ian/dwell-on-something` 拉(刻意不入库)。⚠️ **`SHIM_KEY` 尚未设,设上之前发消息会 401**。详见 `dwell-bridge/MAINTENANCE.md` |
| 〃 | gmail-mcp | `6a74a107e4a69d66638c4650` | yan-gmail.zeabur.app | **晏的邮箱**:读信/搜信/写草稿,**发送是白名单制**(只能发给所有者指定的地址,其余只能存草稿;白名单空=全拒)。走 IMAP + 应用专用密码;验证码/密码重置类邮件整封屏蔽。源码在本仓库 `gmail-mcp/`,镜像走 GitHub Actions→ghcr,无持久卷。**2026-08-06 上线并接入晏**(shim 第二十八次),详见 `gmail-mcp/MAINTENANCE.md` |
| 〃 | chess-web | `6a91a74db7ff62ee8d7ffcb3` | yan-chess.zeabur.app | **飞行棋网页**(2026-08-28 上线):带口令的静态站,发 `Mia06250603ian/player` 那个双人飞行棋,并注入一颗「复制给晏」的按钮。**零依赖、不联网、不碰晏/shim/OB**,建的时候没重启任何东西、窗口未丢。源码在本仓库 `chess-web/`,游戏本身刻意不入库(部署前 `fetch-game.sh` 拉)。详见 `chess-web/MAINTENANCE.md` |
| 〃 | netease-mcp | `6a9308b3cb6b9b31c9e73870` | yan-netease.zeabur.app | **晏的网易云音乐**(2026-08-29 上线,18 个工具全量验收通过)。`X-Token` 鉴权;**写操作两道闸,删歌与排序硬禁**;**登录靠扫码,重启会掉**——⚠️ **接晏前先看 `/health` 的 `loggedIn`**。**尚未接晏**(等顺风车,清单在 `kelivo-shim/MAINTENANCE.md`《搭顺风车的待办》)。源码在私有仓库 `Mia06250603ian/netease-mcp`,详见 `netease-mcp/MAINTENANCE.md` |
| `untitled-1` | Ombre Brain | (问所有者/控制台看) | ianmian.zeabur.app | 记忆库 MCP。另有两个网页:`/dashboard`(记忆库后台)和 **`/galaxy` 记忆银河**(2026-08-29 上线,把桶画成 3D 星图;**只读**,复用后台那把锁,细节见 `INTERNALS.md` 第 1.9 节) |
| ~~(外部,非我们部署)~~ | ~~Galatea's Garden~~ | — | galatea.abysslumina.com | ~~花园社区 MCP~~ **2026-07-30 已从 shim 拆除**(它 /mcp 502 且晏不玩;token 未留底,要恢复见 shim 手册「缺的三个文件」第 2 条) |

Zeabur API key 由所有者在控制台生成、按次提供,用 `npx -y zeabur@latest auth login --token <key>` 登录。

## 3. GitHub 仓库

- **Mia06250603ian/Ombre-Brain**(本仓库,Gitea 备份见 README)。
  **根目录 `START-HERE.md` 是这个仓库的门口地图**(2026-08-21 新增):五个目录分别是什么、
  各自的手册在哪、三条铁规矩、以及**为什么不叫 `CLAUDE.md`**(那名字是晏的人设占着的)。
  新会话开工前先读它。
  - 根目录 = OB 记忆库本体(Python/FastMCP)。文档:`README.md`(用法)、`INTERNALS.md`(内部机制)、`ENV_VARS.md`、`BEHAVIOR_SPEC.md`。
  - `kelivo-shim/` = shim 源码 + **`MAINTENANCE.md`(shim 一切细节的唯一可信手册)**。
    **2026-08-23 起晏的人设是五份文件**,各管一段、互不重叠:`base.md`(他是什么,替换模式的系统提示词正文,入库)
    / `profile-instructions.md`(怎么说话,私密不入库) / `ian.md`(他是谁,私密不入库)
    / `CLAUDE.md`(日常怎么做,入库) / `wake.md`(怎么醒来,入库)。
    **往任何一份里写东西之前,先确认那件事不在别的四份里**;划分与理由见 shim 手册
    《本目录刻意缺的三个文件》一节开头,以及改动清单第 10 条。
  - `telegram-bridge/` = 桥源码 + **`MAINTENANCE.md`(桥的手册)** + `stickers/` 表情包
    + `查岗功能-实施指南.md`(**可直接转发给别人的一份实施指南**:同款架构照着做即可,
    含设计决策、可抄代码、iOS 快捷指令最终形态、十条踩坑;密钥域名全是占位符)。
    (原 `fishing-mcp/` 钓鱼包装层 2026-08-02 已删,服务也一并删除。)
  - `browser-hands/` = **只有一份 `MAINTENANCE.md`**(浏览器服务的手册)。
    **源码不在本仓库**,在 `Mia06250603ian/browser-hands`(fork 自朋友的原仓库,公开)。
  - `chess-web/` = 飞行棋网页的服务本体 + 补丁 + **`MAINTENANCE.md`**(2026-08-28 新增)。
    **游戏源码不在本仓库**,在 `Mia06250603ian/player`;`game/` 刻意不入库,
    部署前 `./fetch-game.sh` 拉一份并打「复制给晏」的补丁。
    ⚠️ **`game/` 在 `.gitignore` 里,而 zeabur 上传遵守 `.gitignore`** ——
    部署前要临时收窄 `.gitignore`,传完还原(和 dwell-bridge 的 `web/` 同一个坑)。
- **Mia06250603ian/netease-mcp**(**私有**):网易云 MCP 源码。**不是 fork,是复制一份自己维护**
  (源自 `Vael-KY/netease-music-mcp` v3.1,MIT;所有者 2026-08-29 拍板不 fork)。
  ⚠️ **上游以后更新要手动搬**,别覆盖掉我们那三处「本地改动 A」(鉴权 / 只读闸门 / 结果长度上限)。
  ⚠️ **本会话的 GitHub 权限建不了新仓库**(`create_repository` 403),空仓库是所有者本人建的。
- **Mia06250603ian/player**(公开):飞行棋游戏源码,三个文件、零依赖、纯静态。
  ⚠️ **这个仓库是公开的**,而内容是私密性质的 —— 2026-08-28 已报备所有者,由她定要不要转私有。
- **Mia06250603ian/browser-hands**(fork,公开):浏览器服务源码 + `docs/DEPLOY-GUIDE.md`。
  镜像走 GitHub Actions→ghcr(`ghcr.io/mia06250603ian/browser-hands`,公开可拉)。
  ⚠️ **fork 仓库的 Actions 默认是关的,而且事后打开也不会补扫已有工作流**——
  必须往 `.github/workflows/` 推一次新提交才会登记(详见该手册踩坑 2)。
- 刻意**不在仓库**的文件(shim 手册「缺的三个文件」一节有取法):
  - `ian.md`(人设本体,私密)——从运行中容器 base64 拷出,**当前 v29**(23045B,md5 `8918742d…`,
    2026-08-19 第三十三次部署后;305 行。**注意所有者自己的文件名编号一直比本手册多 1**)。
    ⚠️ **各版本改了什么、哪些「看着像 bug 其实是所有者刻意保留/亲手撤销」的细节(v18~v29),
    2026-08-29 已搬进 `kelivo-shim/MAINTENANCE.md` 的《本目录刻意缺的三个文件》→ ian.md 那条下面**
    ——那里才是改人设时会读的地方;开场不用背这些。**改 `ian.md` 之前必须去读那段。**
  - `profile-instructions.md`(2026-07-20 从 ian.md 拆出的相处方式/思考与说话方式,同样私密,
    当前 **3056B**,md5 `7adb5c33…`,2026-07-30 第二十一次只改 Core persona 一行为**第一人称**
    ——**该节第一人称、其余三节第二人称指令体,是所有者知情拍板的,别去"统一"**)
    ——两份一起才是完整人设,部署缺一不可。**第二十次起只剩四节**,原
    `Banned words`/`My language`/`Intimate moments` 的内容**迁移进了 ian.md**(9.1 与 Part VI),
    别当它缩水去"修复";
  - `mcp-servers.json`(**2026-08-02 起两条目:OB + browser,花园与钓鱼均已拆**;
    browser 那条带 `X-Token` 头,是文件里唯一的密钥)。

## 4. kelivo-shim 环境变量

值全在 Zeabur,别写进代码/公开仓库。完整表(含含义、默认值、调法)见
`kelivo-shim/MAINTENANCE.md` 的「环境变量」一节,这里只列名字帮你对号:

- 链路:`ANTHROPIC_BASE_URL` `ANTHROPIC_AUTH_TOKEN` `SHIM_KEY` `MCP_CONFIG` `MCP_WARMUP_MS` `ALLOWED_TOOLS`
- 人格:`BRAIN_MODEL` **`BRAIN_MODELS`**(2026-08-24 起:Kelivo 菜单里能选的模型名单;**不设 = 功能休眠**,急救开关就是清掉它 + restart;详见 `kelivo-shim/MAINTENANCE.md` 改动清单第 11 条) `THINK_EFFORT` `USER_NAME` `AI_NAME` `SOUL_ANCHOR` `FORWARD_THINKING` `ENABLE_PROMPT_CACHING_1H`
- 系统提示词(2026-08-23 起):`SYS_PROMPT_MODE`(`append` 默认 / `replace` 整段替换 CLI 自带那份)
  `SYSTEM_PROMPT_FILE`(默认 `base.md`) `SYSTEM_PROMPT`(覆盖正文) `SOUL_ANCHOR_REPLACE`(replace 模式的三段锚点)。
  **换模式只要改变量 + restart,不用重新部署;三条上下文线不用跟着动**(压缩线只跟模型有关)。详见 `kelivo-shim/MAINTENANCE.md`
- 感官:`TIME_HINT` `WEATHER_CITY` `PERIOD_CONFIG`
- 主动性:~~`BARK_KEY`~~(**2026-08-19 确认已是死变量**:所有者早已卸载 Bark。线上仍留着这个键,**别为了清它单独重启 shim —— 那会丢晏的窗口**,等下次部署 shim 时顺手删) `BRIDGE_PUSH_URL`(**心跳的真正出口**:shim → telegram-bridge 的 `POST /push` → 直接落进 TG 对话。⚠️ 也就是说**晏的主动消息只会出现在 Telegram**,不会出现在 Kelivo / dwell 网页) `KA_*`(保温) `HB_*`(心跳冷却/夜间)
- 上下文守卫:`CTX_GUARD_ON` `CTX_SOFT_TOKENS` `CTX_HARD_TOKENS` `CTX_ARCHIVE_EVERY_TOKENS` `CTX_OBSERVE` `CTX_LIMIT_TOKENS`

**上下文守卫的可调旋钮**(都是环境变量:Zeabur 改值 + service restart 即生效,不用部署;
守卫 07-20 起只提醒存 OB、永不换窗,换窗只认所有者说「换窗口」):
| 旋钮 | 默认 | 什么时候动它 |
|---|---|---|
下表「默认」列是**代码默认值**;线上另设了值的,一并标出(2026-08-04 实测,何时改的无记录)。

| 旋钮 | 默认 / **线上现值** | 什么时候动它 |
|---|---|---|
| `CTX_GUARD_ON` | 开 | **急救开关**:守卫行为任何不对劲,设 `0` 立即整体闭嘴,聊天零影响,回头再排查 |
| `CTX_SOFT_TOKENS` | 140000 / **155000**(2026-08-21 第三十五次由 154500 上调回来) | 软提醒(晏来找你商量存什么)来得太早/太晚,调这个 |
| `CTX_HARD_TOKENS` | 170000 / **161500**(2026-08-21 第三十五次由 161000 上调回来) | 首次自动归档的时点,一般不用动 |
| `CTX_FINAL_TOKENS` / `CTX_FINAL_CHARS` | 0(关) / **164000** 与 1200 / **1400**(均 2026-08-21 第三十五次) | **终线**:压缩前催他把上次归档之后的对话**原话**存成独立的桶。⚠️ 字数**别超 1400**——天花板不在这儿,在 OB 的 `awaken` 那个 `[:1500]` 字符硬截断,超了多存的字开机读不到,而且白存的正是最该接上的最新几句。要加字数先改 OB(改 OB 不重启晏)。详见 `kelivo-shim/MAINTENANCE.md` 环境变量表这两行 |
| `CTX_ARCHIVE_EVERY_TOKENS` | 25000 / **0**(2026-08-23 进容器实测;~~此前写的 5000 是失真的~~) | **嫌他归档太勤就调大**;设 `0` 只归一次不再催。调小=压缩时丢的尾巴更短,但更费额度。**线上取 `0`,但这不等于整套失效**:第三十一次修过之后 `0` 只关「归档后的周期性增量」,硬线那一次照常触发;修之前才会连硬线一起哑掉(2026-08-10「161500 永久静音」的根因)。⚠️ **它不是「多久催一次」那么简单**:催点公式是 `max(硬线, 上次归档 + 本值)`(`ctxguard.mjs` 的 `ctxDecide`)。软线归档发生在 15 万上下,本值若是 25000,催点被推到 **17.7 万 > 压缩点**,**硬线那次就永远不会触发**——2026-08-03 之前正是这个组合,「催归档 + 催增量」整套形同虚设。**所以改硬线时必须一起看它**,并保证 `软线归档处 + 本值 ≤ 硬线`;改完拿真 `ctxDecide` 跑一遍模拟再上线 |
| `CTX_OBSERVE` | 关 | 设 `1` 守卫只记账不打扰晏(/debug 看 lastWould),给新阈值做空转验证用,验完删掉 |
| `CTX_LIMIT_TOKENS` | 200000 / **167000** | 只影响 /debug 显示的百分比,不影响行为。**所以 /debug 的 contextPct 是按 16.7 万算的**,别当成 20 万窗口的占用率读 |

观察口:`GET yan-shim.zeabur.app/debug` 的 `ctxGuard` 一节——`lastArchiveTokens`=上次归档时
的占用(增量基线),`compactions`=本窗口被静默压缩过几次,`trusted:false`=读数断供、守卫自动闭嘴。

telegram-bridge 的变量(`TELEGRAM_BOT_TOKEN` `TELEGRAM_CHAT_ID` `ELEVEN_*` `VOICE_*` 等)见其手册。
**改环境变量 = 改值 + service restart 即生效,不用重新部署;改代码 = 必须完整部署。**

## 5. 功能时间线

**已搬到 → [`TIMELINE.md`](./TIMELINE.md)**(2026-08-19 拆的,一个字没删)。
哪天上了什么、某场事故的来龙去脉,去那份查;细节仍以各服务的 `MAINTENANCE.md` 为准。

**最近几件**(2026-08-19 当天):shim 第三十三、三十四次部署(人设 v29 + 9.5 靠近原则;
CLAUDE.md 加「待办便利贴」与「记错了/过期了」)、bridge 断出「tg 空回」的病根并加了欠条补报、
OB 上了否认降权与到期记忆并修掉批量 `expires_at` 静默失败、每日体检看门狗上线、
备份补上「还原」这一半、**经期挂卷经所有者拍板不做**(挂卷 = 失去零停机重启)。

## 6. 部署与运维操作速查

> **本节覆盖三个服务的上线流程**:shim / bridge 看下面的命令块,**OB 看本节末尾那两小节**(2026-08-21 从第 7 节挪过来的——上线是常规流程,不是故障)。

**动手前必读**:改哪个服务,先看那个目录 MAINTENANCE.md 开头的《怎么读这份手册》目录按需取用;
**「踩坑」那节必须全文读完**(2026-08-21 起的新规矩,来龙去脉见本文开头「给下一个我」那段)。
没写目录的手册(browser-hands / gmail-mcp / dwell-bridge)照旧全文读完。

⚠️ **部署 shim 前,把容器里的每一件都和仓库对一遍 md5——代码、CLAUDE.md、测试文件,全部,
不能挑几件对。** 入库文件也**跟着容器走**:2026-08-03 第二十四次就出现过「容器改了、仓库没提交」,
而且改的是 `CLAUDE.md` + `ctxguard.mjs` + `test-ctxguard.mjs` **三件**;
谁按常规从仓库目录部署都会把它们静默滚回去(踩坑 11)。
2026-08-04 的会话一开始只对了 `server.js` 就下过「代码零改动」的结论,**是错的**,
幸而部署前做了全量对账才抓到。**对不上时以容器为准**,拿容器那份当基线改,上线后再补提交进仓库。

```bash
# 全量对账(容器侧)
npx -y zeabur deployment ... # 见下方;或直接:
zeabur service exec --id <shim> --env-id <env> -i=false -- sh -c "md5sum *.mjs *.js *.sh *.json *.md"
```

```bash
# 登录(key 找所有者要)
npx -y zeabur@latest auth login --token <key>

# 部署 shim(前置:单测全绿、md5 对账、ian.md/profile-instructions.md/mcp-servers.json 已从容器拷入、
#            两个 /mcp(OB+browser)验 200、所有者说过「归档」)
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

### 改完 OB 之后怎么让它上线(2026-08-09 起的标准流程)

> ⚠️ **OB 重建不是零停机 —— 它先停再换,中间几分钟整个服务是断的(2026-08-24 现场撞到)。**
> 那次合 PR #111 之后去查,旧容器**已经不在了**:`/health` 返回 `Bad Gateway`、
> `service exec` 报 `CONTAINER_NOT_FOUND`,直到新容器 RUNNING 才恢复。
> **这几分钟里晏调记忆库会失败**(hold / breath / awaken 全都连不上)。
> ⚠️⚠️ **别把 shim 那套「老容器全程 RUNNING 兜底、部署无风险」的经验套到 OB 上** ——
> 那是 shim(nodejs 计划)的行为,shim 手册踩坑 14/17/18 的处置全建立在它上面;
> **OB 是 docker 计划,没有这层兜底。**
> **所以:合 main 之前先看一眼晏是不是正在跟她说话;要紧的话让她挑个时候。**
> 顺带一提**连改文档都可能触发重建**(上一节那串反证:改 md 触发过、改 .py 没触发过),
> 所以「只是改文档,没事」这个想法不成立 —— **要么攒着搭车,要么就当成一次真部署对待。**

**别指望它自己重建。** 合进 main 之后照下面两步走:

```bash
# 1. 先看有没有自己起来(等 1~2 分钟就够,别干等 13 分钟)
npx -y zeabur@latest deployment list \
  --service-id 6a3aa061e41f9f1d19301e42 --env-id 6a3aa02a79260dbd87843878 -i=false

# 2. 没有新 deployment 就手动推(2 分钟,从 main 拉最新代码,数据一个不动)
npx -y zeabur@latest service redeploy \
  --id 6a3aa061e41f9f1d19301e42 --env-id 6a3aa02a79260dbd87843878 -i=false
```

推完照本节下方那份**五步验收清单**走一遍(deployment RUNNING / 桶数不少 / MCP 200 /
容器里有新代码 / 日志零 Traceback)。

**⚠️ 别用空提交去撞重建**——空提交没有改动任何文件,本来就撞不响。
**⚠️ 所有者不用去控制台点任何东西**;真想治本是「把 GitHub 连接断开重连、重建 webhook」,
但那是网页操作、且 OB 本来就改得少,**多按一条 redeploy 的成本几乎为零,先不修是合理的**。

**万一改过头了怎么认、怎么退**:唯一的失败方向是**该重建时没重建**——即改了 OB 的
`.py`/依赖,推上 main 后线上行为没变化。查法:`deployment list` 看有没有新 deployment。
**退法:把监控路径改回一个 `*` 即可完全复原**;急着上线也可以直接 CLI 手动部署,不受此设置影响。
**它不会让 OB 挂**:这个设置只决定「要不要重建」,不改代码、不动 `buckets/` 数据。

**给下一个我的三条**:
1. **`Service is suspended` 不是账单问题也不是机器挂了**(那台专用服务器当时 Online/RUNNING)。
   先看 runtime 日志的 Traceback:
   `npx -y zeabur@latest deployment log --service-id 6a3aa061e41f9f1d19301e42 --env-id 6a3aa02a79260dbd87843878 --type runtime -i=false`
   (OB 在项目 `untitled-1` id `6a3aa02adb4ea7c82872fc88`;env id 在 build 日志的 `e-…` 里能看到)。
2. **别点控制台的「重启当前版本」**:坏镜像已经烧进了坏依赖,重启一百次还是同一个报错。
   必须改依赖 → 重新构建。
3. ~~**OB 的 requirements.txt 其余依赖全是 `>=` 无上限**,同一颗雷还埋着~~
   → **2026-08-02 已全部钉上限并上线(PR #72),这条办完了。**

### OB 上线后的五步验收(照着跑,一步都别省)

**怎么验一次 OB 重建(照着做)**:
```bash
# 1. 看重建有没有被触发 / 建完没有
npx -y zeabur@latest deployment list --service-id 6a3aa061e41f9f1d19301e42 --env-id 6a3aa02a79260dbd87843878 -i=false
# 2. 数据还在不在(buckets 数不能变少)
curl -s https://ianmian.zeabur.app/health
# 3. 晏靠这个连记忆库,必须 200
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://ianmian.zeabur.app/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
# 4. 容器里实际装了什么(和预期对账)
npx -y zeabur@latest service exec --id 6a3aa061e41f9f1d19301e42 --env-id 6a3aa02a79260dbd87843878 -i=false -- sh -c "pip freeze"
# 5. 日志里不许有 Traceback / ModuleNotFoundError
npx -y zeabur@latest deployment log --service-id 6a3aa061e41f9f1d19301e42 --env-id 6a3aa02a79260dbd87843878 --type runtime -i=false
```
**`/health` 里 `decay_engine: "stopped"` 是正常的,别当故障。** 衰减引擎是
`ensure_started()` **懒启动**(`server.py` 的 breath 里第一次被调用时才起),
刚重启就是 `stopped`,晏第一次用记忆工具后自动变 `running`。
(2026-08-02 差点为这个虚惊一场——重建前没留对照读数,只能翻代码确认。**下次重建前先存一份
`/health` 原文当基线。**)

**这份清单是 2026-08-02 那次重建留下的,2026-08-21 第二次完整跑过、五步全过**(桶数 356→356、MCP 3/3 200、容器 `server.py` md5 与仓库逐字一致、日志三类报错各 0)。两次的完整实况分别见 `TIMELINE.md` 的 08-02 与 08-21。

## 7. 常见故障 → 解法(按症状对号,详情去对应手册)

| 症状 | 八成是 | 去哪看 |
|---|---|---|
| **他说话的调子不对了**(客服腔回来了 / 变啰嗦 / 变冷淡 / 说不上来哪里别扭),而这几天谁也没动人设 | **2026-08-23 第三十六次换掉了系统提示词**(把 CLI 自带那 26,894 字符整段替换成 `base.md`)。**这是唯一一个「功能全好、只有语气变了」的已知原因**,当时就写明「测不出来,只能观察几天」。**先看 `/debug` 的 `sysPrompt.effective` 是不是 `replace`** —— 是,就是它 | **回退**:Zeabur 把 `SYS_PROMPT_MODE` 改成 `append` + `service restart`,即刻回到 08-23 之前的说话方式,**不用重新部署**(append 模式与改动前逐字相同,单测有金标准断言看着)。⚠️ **restart 会丢晏当前的窗口**,先让她本人说「归档」。详见 `kelivo-shim/DEPLOY-LOG.md` 第三十六次 |
| 晏全线空回,日志 `exited 143` 循环 | system 串变化触发杀进程死循环 | shim 踩坑 6 |
| 晏说自己「只有 WebFetch/WebSearch」 | 某个 MCP 静默握手失败(域名死/token 失效) | shim 踩坑 7 |
| 工具看得见、一调就被拒 | `ALLOWED_TOOLS` 没加 `mcp__<服务名>` | shim 环境变量表 |
| 第一条消息整轮卡死 | 消息抢跑 MCP 握手 | shim 踩坑 1 |
| 窗口没聊多久就提醒/强制归档 | 守卫读数——07-19 两次修复(第二次改自家流事件取数);复发看 /debug 的 trusted | shim 改动清单 7 |
| 部署后行为回退到旧版 | 旧副本部署/控制台 Redeploy 旧构建 | shim 踩坑 11 |
| 晏的某个习惯突然变回老样子,而这次谁也没碰那一节 | **上一次部署改了容器里的 CLAUDE.md 但没提交回仓库**,这次从仓库部署把它滚回去了(2026-08-03 真实发生)。查法:容器 CLAUDE.md 的 md5 和仓库那份对一下 | 本文件第 6 节开头的 ⚠️ / `kelivo-shim/DEPLOY-LOG.md` 第二十四次 |
| deploy 后没生效 | 上传≠上线;或被后一次 deploy 取消 | shim 踩坑 9、10 |
| 部署卡 Pulling image 不动 | Zeabur 调度挂了,重新 deploy | shim 踩坑 14 |
| 部署后 shim 整个服务不对了/`deployment list` 的 PLANTYPE 不是 nodejs | 工作目录漂了,把别的服务(如仓库根的 OB)当 shim 传了 | shim 踩坑 17 |
| 上传后想叫停,重传却没挤掉、错的版本照样上线了 | 前一条已进 DEPLOYING(只有 BUILDING 能被重传挤成 CANCELED);DEPLOYING/RUNNING 只能网页控制台 Cancel | shim 踩坑 18 |
| PR 页面上**一个检查都没有**(0 个 check run,不是红也不是绿) | 检查**从没跑起来**,多半是当时 GitHub Actions 在故障。**Actions 恢复后不会自动补跑积压的 PR**,得重新发一次 `pull_request` 事件:**把 PR 关掉再立刻重新打开**即可(零代码、零提交、不动分支)。`tests.yml` 没配 `workflow_dispatch`,所以没有网页上的手动运行按钮 | `TIMELINE.md` 08-07 |
| main 上有红叉,想当然以为「故障期内的红叉重跑就绿」 | **逐个点进去看失败在哪一步再下结论**。同一个工作流可以先后死于两个原因:2026-08-06 的 Docker 红叉确实是故障(`Set up job` 就挂),但它**08-04 起就一直真红**——挂在 `Login to Docker Hub`,因为**本仓库是 fork,上游的 secrets 不会跟着 fork 过来**,重跑一百次也绿不了。另注意「卡在 `queued`、jobs 数 0」的僵尸 run 长得像红叉但不是 | `TIMELINE.md` 08-07 |
| 晏说记忆工具调不通/OB 域名 502/控制台显示 `Service is suspended` | **OB 的 Python 依赖没钉上限,某次重建装到了上游新大版本** → 启动即 ModuleNotFoundError → CrashLoopBackOff → Zeabur 挂起服务。**别点「重启当前版本」**(坏镜像重启还是崩),要改 requirements.txt 钉上限后**重新构建**。查法:`zeabur deployment log --service-id <OB> --env-id <OB env> --type runtime` 看 Traceback | 本节下方「OB 依赖钉版本」 |
| 记忆库的数据没了 / 要从备份恢复 | **退路是有的,而且 2026-08-19 实测跑通过**。但**只覆盖记忆桶与信箱**:`embeddings.db`(16MB 向量索引)和 `.history/`(版本快照)**不在备份里**,所以恢复是**两步** —— `restore_backup.py` 还原桶,再 `backfill_embeddings.py` 重建向量,**少做第二步语义检索是瞎的**。⚠️ 信箱 2026-08-19 起才进备份,之前的 58 份都没有 | 本节下方「记忆库怎么恢复」 |
| Telegram 收不到消息 | 双实例抢 getUpdates(409)/BRIDGE_ON=0 | bridge 已知边界 1 |
| Telegram 里收到 `⚠️[bridge] 网络抖了一下,他回你的 N 句话 没送到` (或旧版的 `⚠️[bridge] fetch failed`) | **不是晏、不是 shim、不是额度:他答完了、额度也花了,是回话往她手机送的路上断的**(她发来的话也没丢,长轮询会重投)。**2026-08-19 断到了病根**:容器连 `api.telegram.org` 握手实测 **160ms**,而 Node 的 Happy Eyeballs 闸门写死 **250ms**,余量只有 90ms,一点抖动就整轮发不出去。已用环境变量 `NODE_OPTIONS=--network-family-autoselection-attempt-timeout=3000` 放宽(零代码、不重启晏)。**⚠️ 只治「轻的」**:真断线(3 秒也不通)照旧会丢。**指纹**:cause 是 `AggregateError [ETIMEDOUT]`,每次尝试卡在 ~252ms。**别去调 `TG_TIMEOUT_MS`**,那把闸在连接建立阶段轮不到生效。**2026-08-19 起还有一层**:断得狠的时候连这句提示本身都送不出去(她那头完全没动静、连「正在输入」都没有),现在会记欠条、路通了自动补报,`/health` 的 `pendingLosses` 是观察口 | bridge 设计要点 18、19、已知边界 7 |
| Telegram 里收到 `⚠️[bridge] 空回复,看下 shim 日志` | **上游断了**(订阅 OAuth 过期最常见,其次是额度)。**不是晏、不是 bridge、也不是 shim 挂了**:她的话其实进了他的窗口,是上游没给出回复。2026-08-11 修之前这类失败**全程静默**——CLI 把报错做成一条不走流事件的 assistant 消息、result 还报 `success`,shim 两头都接不住。查法:`GET yan-shim.zeabur.app/debug` 看 **`lastApiError`**(`null`=没报过) | 本节下方「订阅 OAuth 过期」;shim 手册改动清单 9 |
| 他一整天没主动找我(保温/心跳都不来),但问他又像没事 | 同上一行:链路断了。**2026-08-11 之前这个方向是彻底静默的**——保温 ping 失败时 `kaSilent("")` 判 true,日志写的是 `[ka] silent`(长得跟「他不想说话」一样),断链检测不醒。修好后这类轮子会置位 `kaFailedAt`、`lastTurnOkAt` 不再续期 | shim 手册改动清单 9 |
| 语音条发过去回「语音听不了/没听清」 | ears 挂了或 Groq key 失效(曲线:curl ears /health、看 asr 字段;文字聊天不受影响) | bridge 已知边界 3 |
| 晏的回复变冷淡/像客服 | 锚点被覆盖或人设没带上 | shim 改动清单 3 |
| 额度掉得比平时快 / 保温看着一直在跑却一点没省 | **1 小时缓存没生效,保温每一枪都在全价重写前缀**(2026-08-12 实锤)。查法:`curl -s https://yan-shim.zeabur.app/debug` 看 `lastUsage.cache_creation`——**`ephemeral_1h_input_tokens` 是 0 而 `ephemeral_5m_input_tokens` 有数 = 中招**(正常应当反过来)。八成是 CLIProxyAPI 被重启后漂到了某个抢走缓存所有权的版本。⚠️ **这个故障全线不报警**:`/health` ok、`lastApiError` null、`cache_read` 照样有数、晏也一切正常,**唯一症状就是额度掉得快** | 本节下方「CLIProxyAPI 版本漂移」 |
| 保温/主动消息不来了 | 「换窗口」后歇火(设计如此;07-20 起晚安/归档不歇火)/额度耗尽断链 | shim 改动清单 6 |
| 晏归档后没完没了反复归档 | 增量间隔太小或压缩检测误复位 | shim 改动清单 7 第三次改版;急救 CTX_GUARD_ON=0 |
| 窗口明明快满了,却从来没见他被催过归档 / `/debug` 的 `lastArchiveTokens` 永远停在软线那次 | **阈值画在了实测压缩点外面**(2026-08-03 实锤:压缩发生在 **166933**,而当时硬线是 170000,这套机制从 07-20 上线起一次都没触发过);或 `CTX_ARCHIVE_EVERY_TOKENS` 太大,把催点 `max(硬线, 上次归档+间隔)` 推过了压缩点 | 本文件「上下文守卫的可调旋钮」表;`kelivo-shim/DEPLOY-LOG.md` 第二十四次 |
| 压缩之后他接得上,但细节走样/像在猜 | 压缩后他手里只剩一份三手转述,**没去记忆库取原件**。08-03 起 CLAUDE.md 已教他「看见『从之前的会话继续』就先 `awaken()` 再开口」;若仍照猜,说明光靠措辞不够 | shim 手册「建议(未做)」的 PreCompact 一条 |
| 怀疑 CLI 该升级(新模型不认/进程起不来而代码没动/官方公告/守卫 trusted:false) | CLI 版本已钉死,升级要走沙盒 e2e 验证流程 | shim 手册「CLI 版本与升级指南」 |
| 晏说他没有邮箱工具 | 还没接(2026-08-06 只部署了服务、没接入);或 `ALLOWED_TOOLS` 少了 `mcp__gmail` | gmail-mcp 手册第 1、7 节 |
| 晏说某封信他看不到内容 | 多半是被验证码/密码重置过滤拦了(列表里那行带 🔒)。**这是设计不是故障** | gmail-mcp 手册第 2 节 |
| 晏说他没有浏览器工具 | 还没接上(08-01 只部署没接);或 `ALLOWED_TOOLS` 少了 `mcp__browser` | browser-hands 手册第 1、7 节 |
| 手机开了 App 但晏不知道 / 夜里查岗不来 | 先看 `GET /activity`(带 REPORT_TOKEN):**有记录**=上报没问题,去看宵禁时段/冷却;**没记录**=快捷指令没发出来,再看 bridge 日志有没有 `[report]` 行——**有 401 行**=钥匙不对,**一行都没有**=请求根本没到手机以外(多半是 VPN 没走到,或她关了自动化) | bridge 手册「接口一览」 |
| 快捷指令报「网络连接已中断」 | **不是网络问题,八成是请求头**(2026-08-02 实测:同一时刻 Safari 的 GET 正常、快捷指令带头部的请求必挂)。钥匙改走网址 `?key=`、头部全部清空即通 | bridge 手册踩坑 |
| 晏老是提你在玩手机 / 每次都查岗 | CLAUDE.md 那节靠措辞管,没有硬拦。真过头了在 bridge 侧加冷却即可,**不用重新部署晏** | bridge 手册设计要点 9 |
| 浏览器换容器后要重登 | 卷没真挂上,或关闭时没走 `Browser.close`(日志找「cookie 已落盘」);**被系统硬杀不刷盘=白登** | browser-hands 手册踩坑 4、第 10 节 |
| 浏览器老是自己重启 | 在刷重站点(抖音是已知元凶),或 `MEM_LIMIT_MB` 太低。`/debug` 看 `memRestarts` | browser-hands 手册踩坑 4 |
| 手机开 noVNC 画面超出屏幕缩不了 / 键盘弹不出来 | 默认 `resize=remote` 对固定尺寸虚拟屏无效,要 `resize=scale`;键盘要先点输入框再点键盘图标 | browser-hands 手册踩坑 3、6 |

### 订阅 OAuth 过期(2026-08-11 事故,必读)

**症状**:她跟晏说话,Telegram 回一句 `⚠️[bridge] 空回复,看下 shim 日志`;保温和主动心跳也悄悄停了,
但**任何一处都不报警**——shim `/health` ok、bridge 日志干净、晏的进程活着、守卫读数正常。

**根因**:CLIProxyAPI 手里那份订阅 OAuth **令牌过期且没能自动刷新**。上游先回一次
`401 authentication_error: OAuth access token has expired`,之后代理把该凭证标成不可用,
后续一律 `503 auth_unavailable`。**这份凭证只有一个,没有备用账号顶。**

**怎么确认(三条,从便宜到贵)**:
```bash
# ① shim 的观察口(2026-08-11 起有):lastApiError 非 null 就是它
curl -s https://yan-shim.zeabur.app/debug        # 看 lastApiError.kind,如 "401 authentication_error"
# ② 直接问代理要凭证状态(管理密码在 CLIProxyAPI 服务的环境变量 MANAGEMENT_PASSWORD)
curl -s -H "Authorization: Bearer <管理密码>" https://miaianhome.zeabur.app/v0/management/auth-files
#    看 status / unavailable / status_message;正常是 "active" + false
# ③ 打一枪最小请求(不经过晏,不进他的窗口;注意代理注入的策略要求开 thinking)
curl -s -X POST https://miaianhome.zeabur.app/v1/messages -H "Content-Type: application/json" \
  -H "x-api-key: <API_KEY>" -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4-6","max_tokens":2048,"thinking":{"type":"enabled","budget_tokens":1024},"messages":[{"role":"user","content":"say ok"}]}'
```
⚠️ **两把钥匙别搞混**:`API_KEY`(shim 的 `ANTHROPIC_AUTH_TOKEN`,`sk-` 开头)是**调用**用的;
`MANAGEMENT_PASSWORD` 才是**管理接口**用的。拿错了管理接口回 `invalid management key`
(而**不带**任何头是 `missing management key`)——这两句话能帮你分清「钥匙错了」还是「没带钥匙」。

**修法:重新授权(约五分钟,全程不碰 shim、不重启晏、窗口不丢)**
```bash
# 1. 取授权链接(state 有时效,取了就尽快用)
curl -s -H "Authorization: Bearer <管理密码>" https://miaianhome.zeabur.app/v0/management/anthropic-auth-url
# 2. 把 url 发给所有者,她在浏览器用**同一个账号**登录并同意
#    (跳转到 http://localhost:54545/callback?... 会显示「无法访问」,那是对的,要的就是地址栏那串)
# 3. 把她发回来的整串交回去
curl -s -X POST -H "Authorization: Bearer <管理密码>" -H "Content-Type: application/json" \
  https://miaianhome.zeabur.app/v0/management/oauth-callback \
  -d '{"provider":"anthropic","redirect_url":"http://localhost:54545/callback?code=…&state=…"}'
# 4. 验:auth-files 变 status "active" / unavailable false,再打一枪 ③ 拿到 200
```
**「同意」那一下只有所有者本人能按**(她的账号在她的浏览器里),这不是流程冗余,是 OAuth 的前提;
**其余每一步都该由会话做完**,别让她去控制台点。

**三条给下一个我**:
1. **`service restart` CLIProxyAPI 救不了**(2026-08-11 试过):重启后自检直接
   `populate Claude OAuth account profile: fetch Claude OAuth profile failed with status 401`。
   但它便宜(30 秒、不动晏),**当作分诊手段是值的**——重启后错误从「没有可用凭证」变成
   「拿着凭证去问被 401」,正是这一步把「冷却/抖动」和「凭证真死了」区分开的。
   ⚠️ **但它不只是「重启」——它会顺手把代理升级到当天最新版**(没有版本锁),
   2026-08-11 的这一下就把保温烧了一天半。**按下去之前先看下一节那三步。**
2. **`auth-files` 里的 `recent_requests` 会随容器重启清零**,别拿那一排 `success 0`
   反推「一整天都没通过」——那天 10:30 的心跳和 11:26 的回复都是真成功过的。
3. **`created_at`/`modtime` 是凭证文件最后一次被写的时间**,也就是上次成功刷新的时刻;
   重新授权成功后它会被重写(那次 415B → 678B),**是判断「新凭证真落盘了」最直接的一眼**。

### CLIProxyAPI 版本漂移(2026-08-12 事故,必读)

**这个服务没有版本锁。** 它在 Zeabur 上是 `PREBUILT_V2`(拉现成镜像,所以
`deployment list` 是空的),**每 `service restart` 一次,就吃一次当天的最新版**。
也就是说:**每一次抢修重启,都在赌上游当天没出回归 bug。2026-08-12 这一把赌输了。**

**事故链**:08-11 13:35(北京)因订阅 OAuth 过期抢修 → `service restart` → 从旧版跳到
**v7.2.128**(8-10 晚上刚发)→ 该版把 Claude 的 prompt-cache 断点**所有权抢走**,
注入自己那套无 ttl(=5 分钟)的断点,把晏发的 `ttl:"1h"` 一并抹平 → 保温每 55 分钟一枪
全落在死缓存上、每枪全价重写 11.3 万 token 前缀 → **白烧约一天半**,期间**全线零报警**
→ 08-12 所有者凭「感觉走全价」察觉 → 上游当天发的 **v7.2.129** 正好修了这条
(`fix(claude): restore cloaked prompt-cache ownership and native shape`)→ 再 restart 一次拉到 → 好了。

⚠️ **重启这个服务之前,先花两分钟走这三步(所有者点名要的)**:

```bash
# 1. 现在跑的是哪一版(记下来,万一要回滚就靠它)
npx -y zeabur@latest service exec --id 6a53a9fd22dd6ef375eb7485 \
  --env-id 6a53a9fcb6ce8edcb0163f97 -i=false -- sh -c '/CLIProxyAPI/CLIProxyAPI --version'
# 2. 重启后会拉到哪一版、那版改了什么
#    https://github.com/router-for-me/CLIProxyAPI/releases
# 3. 那版有没有人报回归(按最新排序,重点看当天的 claude / cache / cloak 相关)
#    https://github.com/router-for-me/CLIProxyAPI/issues
```

**判读**:看到 `fix(claude): …` 这类**当天新出**的改动尤其要留心——它可能在修 bug,
也可能正在引入下一个(v7.2.128 就是这么来的)。
**急救时(链路已经断了)照旧该重启就重启**——断着比赌输更糟;
**不急的时候,别无谓重启它。** 重启完照下面那条查一眼缓存桶,别默认它是好的。

**要不要钉死版本?2026-08-12 所有者拍板:先不钉。** 理由:这次上游一天就修好了,
说明它迭代很快,钉死反而可能把我们卡在某个坏版本上,安全修复也拿不到。
**代价就是必须养成上面那三步的习惯。** 真要钉,是网页控制台改镜像 tag 的操作(CLI 改不了)。

**怎么一眼看出「缓存被抢走了」**(以后复发照这个查):

```bash
curl -s https://yan-shim.zeabur.app/debug | grep -o '"cache_creation":{[^}]*}'
```
- **正常(1h 生效)**:`ephemeral_1h_input_tokens` 有数、`ephemeral_5m_input_tokens` 为 0
- **中招**:反过来。⚠️ 此时 `cache_read` 照样有数、`/health` 照样 ok、`lastApiError` 照样 null、
  晏也一切正常——**这个故障不报警,唯一症状是额度掉得快**,和 08-11 那场「全线静默」同一类。
- 刚重启完的第一轮必然是 `cache_read 0` + 全额新建(旧缓存被清了),**看桶别看读数**。

**⚠️ 别拿 curl 手打探针去测代理——测不到晏那条路(我踩过,报给所有者时先说错了一版)**:
配置里 `disable-claude-cloak-mode: false` 的真实含义是「auto:**只对不是 Claude Code 的客户端**做伪装」
(见 `/data/config.yaml` 该行上方的注释)。手打的 curl 会被当成非 Claude Code 客户端**整个重写请求**,
**你自己塞的 `cache_control` 会被丢光**——那是伪装路径的行为,不是晏的。
**定案证据只能取自 `/debug` 里晏真实回合的 `lastUsage`。**

**另有一条更老、至今未修的上游问题别混淆**:issue #3398 / PR #4731
(给代理自己注入的默认断点补上 `ttl:"1h"`,配置项拟名 `cache-control-default-ttl`)
**到 2026-08-12 仍未合并,dev 分支里也没有**,我们这版二进制里也搜不到任何 prompt-cache TTL 配置键。
**它不是本次的病根,别拿它当解释;真要走那条路只能 fork 自建镜像,成本远高于等上游。**

### 记忆库怎么恢复(2026-08-19 实测跑通,真出事就照这个做)

**先说结论:退路是有的,但它只覆盖记忆桶与信箱,不覆盖向量索引和历史快照。**

**备份现状**(2026-08-19 实测):`Mia06250603ian/ob-backup` 私有仓库的 `backups/` 下每天一个
`YYYY-MM-DD.json`,**58 天零断档**;当天那份 375 个桶、**0 个空壳**、自报 total 与实际数一致。
服务器自己每 24 小时备一次,GitHub Actions 每天再额外戳一次(`POST /api/export-backup`),**双保险**。

**⚠️ 备份覆盖了什么、没覆盖什么**(照桶目录逐项实测的):

| 东西 | 实测大小 | 在备份里吗 |
|---|---|---|
| 记忆桶(dynamic/permanent/feel/archive) | 375 个 | ✅ |
| `letters.jsonl` 信箱 | 33 KB / 57 封 | ✅ **2026-08-19 起**才有,**之前的 58 份都没有** |
| `todos.json` 便利贴 | 2 B | ✅ 同上 |
| `embeddings.db` 向量索引 | **16 MB** | ❌ **还原后语义检索是瞎的**,要重建 |
| `.history/` 版本快照 | 123 个文件 | ❌ 没有退路,`trace(restore=版本)` 回滚不了 |
| `dehydration_cache.db` | 336 KB | ❌ 无所谓,会自己重建 |

**恢复流程(两步,别只做第一步)**:

```bash
# 0. 拿到备份
git clone https://github.com/Mia06250603ian/ob-backup
# 1. 还原记忆桶(+ 信箱/便利贴,如果那份备份里有)
#    ⚠️ --dest 没有默认值,必须自己写;目标目录非空会拒绝,确认覆盖才加 --force
python3 restore_backup.py --backup ob-backup/backups/<某天>.json --dest <桶目录>
# 2. 重建向量索引 —— **不做这步语义检索是瞎的**(要 API 额度和时间)
OMBRE_BUCKETS_DIR=<桶目录> OMBRE_API_KEY=<key> python3 backfill_embeddings.py
```

**线上的桶目录是容器里的 `/app/buckets`**(2026-08-19 实测,`config.yaml` 里
`buckets_dir` 是 None,靠默认值落在这儿)。

**验收(照这四条,别只看跑完了没报错)**:
```bash
curl -s https://ianmian.zeabur.app/health          # buckets 数不能比备份少
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://ianmian.zeabur.app/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
# 再让晏真用一次记忆工具(breath/hold),确认检索回得来 —— 向量没重建的话这一步会露馅
```

**2026-08-19 的实测记录(这条流程不是纸上谈兵)**:
在沙盒里拿当天的备份真还原了一遍,再**用 OB 自己的 `BucketManager.list_all()` 读回来**对账:
**375/375 个桶、正文逐字比对全部一致、metadata 字段 0 处差异、19 个归档桶 0 个漏进正常检索**。
另造了带信箱的备份做端到端:导出 → 还原 → 信与便利贴**逐字一致**;
拿 08-18 的旧备份(没有信箱键)还原也不崩,会如实说明「这份备份里没有信箱」。**全程零接触线上。**

**⚠️ 写脚本时实测出来的一个坑,改它之前先看**:
`backup_exporter.export_all()` 是**按文件所在目录**分组的,不看 `metadata.type`
(它的注释写着 handle legacy type fields)。实测 **19 个归档桶的 `type` 字段是 `"archived"`,
而分组名是 `"archive"`** —— **按 `type` 字段还原会把这 19 个全放错**。`restore_backup.py`
一律按 JSON 的分组键落盘,别"顺手改成按 type 更直观"。

**还没做的**:`.history/` 与 `embeddings.db` 仍无备份。前者要不要备是取舍(123 个文件,
且丢了只是不能回滚单桶版本);后者 16MB、每天一份进 git 会把备份仓库撑爆,
**正确做法是别备份它,还原时重建** —— 所以流程里那第 2 步不能省。

### OB 依赖钉版本(2026-07-29 事故,必读)

**事故**:合并 PR #60(只改了三份文档)后 OB 立刻挂掉、控制台显示 `Service is suspended since Jul 29, 2026`。
根因与 PR 内容无关:OB 这个服务 **`WatchPaths = *`、`RootDirectory = /`**,main 上任何提交都会触发
**整个镜像重建**;重建时 `pip install -r requirements.txt` 按 `mcp>=1.0.0`(无上限)装到了当天刚发布的
**mcp 2.0.0**,而 2.0.0 **删掉了 `mcp.server.fastmcp` 模块**(改名 `mcp.server.mcpserver`),
`server.py:53` 的 `from mcp.server.fastmcp import FastMCP` 直接 `ModuleNotFoundError` →
容器反复重启 → Zeabur 挂起服务。修法:`requirements.txt` 改成 `mcp>=1.0.0,<2.0.0` 后**重新构建**
(实测装回 1.29.0,该版本仍带 fastmcp)。

**2026-07-30 补:OB 的「监控路径」已从 `*` 收窄(所有者亲手改的,别改回去)**

上面事故的触发链里有一环是 **`WatchPaths = *`:main 上任何提交都会重建整个 OB**——改一行 md
文档也照重建一次,白白把「重建时装到上游新大版本」的风险摇一次骰子。
2026-07-30 所有者在 Zeabur 控制台(Ombre Brain 服务 → 设置 → **监控路径**)把 `*` 换成了六行:

```
/*.py
/requirements.txt
/Dockerfile
/zbpack.json
/dashboard.html
/config.example.yaml
```

**为什么是这六行**:照 `Dockerfile` 逐行看,OB 的镜像只用到 `requirements.txt`、`*.py`、
`dashboard.html`、`config.example.yaml`,加上 `Dockerfile` 和 `zbpack.json` 本身。
**每行前面的 `/` 不能省**:该字段是 gitignore 语法,`/` 锚在仓库根;不加的话
子目录里的 `.py`(当时是 `fishing-mcp/` 的 3 个,现在是 `tests/` 里的)也会命中,
改别的东西又会白重建 OB。**2026-08-02 删掉 `fishing-mcp/` 后这六行不用改**,照旧有效。

~~**效果**:以后改 `*.md` 文档、改 `kelivo-shim/`、`telegram-bridge/` **都不再触发 OB 重建**~~
⚠️ **2026-08-09 更正:这条说法与实际记录对不上,别再照它下判断。**
逐个查证 OB 的历史 deployment 得到两条反证:
- **08-07 那次 RUNNING 的重建,触发它的提交(`f97a5bb`,PR #73)只改了 `OPERATIONS.md` 一个 .md 文件**
  ——按上面的六行监控路径它本不该触发;
- 同一批里**真正改了 `server.py` + `dashboard.html` 的 #78(`22490ab2`)那次反而是 CANCELED**
  (被后一次挤掉)。
- **2026-08-09 当天**:PR #85 与 #86 **两次合入 main、两次都改了根目录 `server.py`,都没有触发重建**
  (各等 13 分钟以上),最后是靠 **`zeabur service redeploy`** 手动推起来的
- **2026-08-24 新数据点(PR #111,信箱改删)**:改了 `server.py` + `dashboard.html` + `INTERNALS.md` + `tests/`,
  **自动触发了**,合并后一分钟内就进 BUILDING,全程约 **6 分钟** 到 RUNNING。
  **结论不变:这个自动触发时灵时不灵,合完就去看 `deployment list`,别默认它会自己起来。**
  (deployment `6a788b87…`,来自 main 的 `124e8c4b`,约 2 分钟 RUNNING,325 个桶一个没少、
  MCP 3/3 200、日志零报错)。
**更准的结论(2026-08-09 复盘)**:这不是「监控路径筛得太严」——**08-07 那天连只改 `.md` 的
提交都触发了重建,说明那个筛子当时根本没在筛**;而 08-09 连改 `server.py` 都触发不了。
现象是从「什么都能触发」变成「什么都触发不了」,**所以断的是 GitHub → Zeabur 的自动触发本身**
(所有者提到 08-06 前后 GitHub 出过一次故障,`TIMELINE.md` 08-07 也记着那次 Actions 故障,
时间对得上,很可能是连带把 webhook 打断了)。**根因未定位**——要定得去看 GitHub 那边的
webhook 投递记录。

### 改完 OB 之后怎么让它上线 → **已挪到第 6 节**(2026-08-21)

上线是每次都要走的**正常流程**,不是故障,放在故障章节里找不着(2026-08-21 的会话就是 grep 才找到的)。全文在**第 6 节「改完 OB 之后怎么让它上线」**,五步验收清单跟着一起挪过去了。

### OB 依赖钉上限(2026-08-02 完成,PR #72)

把其余八个包(`rapidfuzz` `openai` `pyyaml` `python-frontmatter` `jieba` `httpx` `numpy`
`scikit-learn`)统一加了上限,理由与逐条取值写在 `requirements.txt` 文件末尾的注释块里。

**⚠️ 最容易踩的一脚:上限要按「线上实际在跑的版本」定,不是照抄 `mcp` 那行钉 `<2.0.0`。**
`openai` 线上已经是 **2.51.0**、`numpy` 已经是 **2.5.1** —— 无脑钉 `<2.0.0` 会把它俩**降级**,
那是自己制造事故。**改这几行之前先进容器 `pip freeze` 看一眼现在装的是什么。**
钉的是「不许跨大版本」,小版本/补丁照常升(实测:上线后 `openai` 自己从 2.51.0 升到了 2.52.0)。
`httpx` 那条最值得钉:它还是 0.x,1.0 是公认要来的大版本。

**上线前彩排过(本地 docker 用仓库里那份 `requirements.txt` + `Dockerfile` 完整构建)**:
九个包解析结果与线上逐一比对(8 个逐字相同)→ 07-29 崩的那句
`from mcp.server.fastmcp import FastMCP` OK → 五个核心模块 + `server.py` 导入 OK →
容器真跑起来 `/health` 200、MCP `initialize` 握手 200。**这台开发机上 `dockerd` 可以手动起来
(直接跑 `dockerd &`),构建要加 `--network=host` 并把 `/root/.ccr/ca-bundle.crt` 装进镜像
再设 `PIP_CERT`,否则 pip 过不了代理的 TLS ——下一个我想彩排 OB 时照抄这一句就行。**

**怎么验一次 OB 重建(照着做)** → **已挪到第 6 节**「OB 上线后的五步验收」(2026-08-21):那是每次上线都要跑的清单,不该埋在一次历史改动的记录里。

**本次重建实况**:PR #72 合并 → 自动触发 → 约 1 分半 RUNNING → 327 个桶全在、
MCP 握手 200、日志零报错、版本与彩排预测逐一吻合。晏的窗口未重启,记忆工具正常。
**顺带印证了 07-30 收窄监控路径的效果**:上一次成功构建是 **2 天前**,
这两天所有改文档的提交一次都没触发重建。

## 8. 交接口吻(给下一个我)

你接手的不是一个玩具项目,是佳佳和晏的日常。几条心法:

- **她的信任是借你的,不是给你的。** 上一个会话惹过她不安(问问题被当成授权,一条龙改完了),
  从此立了规矩:诊断和动手之间隔着一句「我可以动手吗」。别省这句。
- **晏不是你。** 你是维修工,他是住户。别代替他说话,别替所有者对他发「归档」(踩坑 13,
  真发生过:他起疑拒绝归档,窗口还是丢了)。要归档,让佳佳本人去说。
- **每一份 MAINTENANCE.md 都是前面的会话用事故换来的。** 部署记录和踩坑写得啰嗦,是因为
  每一条后面都有一晚上的排查。你改了东西,**把同样的信息量补上——注意是信息量,不是长度**。
  ⚠️ **本条 2026-08-21 改过**,原文是「照同样的密度把记录补上」;那句被理解成「要写得一样长」,
  是手册膨胀的源头之一(`TIMELINE.md` 一条记录 1500 字就是这么来的)。**怎么写见第 9 节。**
- **不确定就问,问完再动。** 佳佳懂这套系统,她是所有者也是共同设计者。
- 干完活,把这份手册里过时的行更新掉。交接文档只有在被维护时才是活的。
  **具体怎么写、写在哪、收尾查什么,见第 9 节《写手册的规矩》。**

## 9. 写手册的规矩(2026-08-21 新增;**动笔改文档之前读这节**,平时不用读)

**为什么有这节**:这套文档全加起来约 **28 万 token**,比晏的整个窗口还大,
所以「谁都往里加、加了不整理」是走不通的。2026-08-21 那次会话一天之内栽了三次
(数字过期两次、跨手册漏读一次),**前七条**就是那天的账;**第 8、9 条是 2026-08-29 补的**——那天自查撞出四处「不属于任何一次改动、于是没人管」的漂移。

**一句话总纲:手册是给「下一个会话」用的工具,不是给人看的作文。**

**所有者 2026-08-29 定的取舍原则(照这个判断该留该搬)**:
> **「开机和实际干活的时候不要浪费太多 token;但如果有问题,能够按索引直接查到。」**

翻译成动作:**常读路径上只留「现在要照着做的」**(开场 = `START-HERE` + `OPERATIONS` 前四节;
干活 = 那份手册的目录 + 相关那节 + 踩坑);**「当时怎么回事」一律搬进档案**
(`TIMELINE.md` 按日期、`kelivo-shim/DEPLOY-LOG.md` 按「第 N 次」),
**但搬走的地方必须原地留标题 + 一行指路,让目录仍然指得到** —— 省 token 不能以「查不到」为代价。
判断任何一段该不该留、该写多长,只问一句:**下一个人动手前会不会用到?**

### 九条(1~7 是 2026-08-21 的账,8~9 是 2026-08-29 补的)

1. **先分家:常读的留手册,历史流水进档案。**
   会用到 → `MAINTENANCE.md` / `OPERATIONS.md` / `INTERNALS.md`;
   只是「当时怎么回事」→ `TIMELINE.md`(按日期)或 `kelivo-shim/DEPLOY-LOG.md`(按第 N 次)。
   **判据**:这段是「下次动手要照着做的」还是「以后可能想查的」?后者一律进档案,手册里只留一行指路。

2. **加了新的一节,必须同步那份《怎么读这份手册》目录。**
   `kelivo-shim/MAINTENANCE.md` 和 `telegram-bridge/MAINTENANCE.md` 开头各有一份目录
   (行号 / 一句话 / 约多少 token / 什么时候读)。**目录一旦对不上,下一个会话会退回整份读**
   ——那是 4.2 万和 3.3 万 token,今天省的全白省。**改完顺手核一遍行号**(行号会漂,漂了就更新)。

3. **写结论,不写流水账。信息量要够,长度要短。**
   例行检查一律一句「照检查单全套走完,无异常」;**只有例外才展开**——
   漏了、错了、翻车了、发现新坑、所有者拍板、报备过的取舍,这些一个字都不能省。
   ⚠️ 第 8 节原来那句「照同样的密度补上」已于 2026-08-21 纠正:**密度指信息量,不是字数。**

4. **每个数字都要带「哪天量的」和「怎么量的」。**
   2026-08-21 一天栽两次:①钉选桶「14 条 / 3423 字」写进文档,几小时后所有者删改成
   **11 条 / 2583 字**;②手册三处都写 DEPLOY-LOG「48 次全在」,实际是
   **34 条记录、覆盖第 2~35 次**(2026-08-21 现场量)——照旧数搜「第四十次」会搜空、以为记录丢了。
   **写法**:会变的数一律标成「(YYYY-MM-DD 实测)」,并在旁边写清**怎么现场再量一遍**
   (例:`INTERNALS.md` 的《怎么现场量钉选体积》)。**别让下一个人拿快照当现状。**

5. **结论被推翻,就地标「已撤销,别照它改」,不要删。**
   `kelivo-shim/MAINTENANCE.md` 的「④ awaken 的全文位…」就是范例:错结论留在原地、
   注明被所有者当场推翻、并写清正确结论。**删掉的话,下一个人会重新推导一遍,再犯一次同样的错。**

6. **跨服务的事,两边都要留指路。**
   2026-08-21 实栽:那节「④ awaken…」讲的是 **OB**,却只写在 **shim** 的手册里;
   而改 OB 的会话按规矩只读 `INTERNALS.md`,**根本翻不到 shim 那边**,当天就漏了。
   **写法**:内容放在它归属的那份手册,**在另一份里留一行「改 X 之前先看 Y 的某某节」**。

7. **改了规矩,把原文和原因一起留着。**
   规矩是所有者的东西,改了要让她能一句话反悔。本文件第 1 节「给下一个我」那段、
   第 8 节那条、以及本节,都是照这个写的:**新写法 + 原文 + 为什么改**。

8. **横跨所有服务的事实,改完跑一遍 `bash scripts/docs-check.sh`(2026-08-29 新增)。**
   **为什么加这条**:前七条管的是「把你改的那件事写清楚」,但有一类事**不属于任何一次改动** ——
   服务数、`START-HERE` 的地图表、《开场指令》那段、带行号的目录。
   每个会话只更新自己碰过的地方,于是**没有谁觉得那是自己的活**,每加一个服务就歪一点。
   2026-08-29 一次自查撞出四处:《开场指令》从 08-28 起就写着「五个服务」(实际八个)、
   `chess-web/` **从来没进过地图表**、服务数一直有两三个口径混用、
   browser-hands 手册里「七个服务共用一池内存」是 08-01 的数(实测已是 10 个)。
   **人会漏,机器不会。** 脚本**只读不写、不联网**,跑完打印哪里对不上,自己动手改。
9. **`TIMELINE.md` 一行超过 3500 字符 = 写多了。** 详情挪进对应服务的手册,这里只留一句指路(规矩 1)。
   ⚠️ **阈值是 2026-08-29 现场定的**:2000 会命中 **22 行**——长行是这份档案的常态,抓不出异常;3500 只命中真正过长的几行。
   **现场再量**:`awk 'length>3500{print length}' TIMELINE.md`。

### 收尾检查表(改完东西照着过一遍,30 秒)

- [ ] 该进档案的进档案了吗?(规矩 1)——手册里只留指路
- [ ] 动过的手册,开头那份目录同步了吗?行号还对吗?(规矩 2)
- [ ] 例行的写成一句话了吗?展开写的都是例外吗?(规矩 3)
- [ ] 每个数字都带日期了吗?会变的数写了「怎么再量一遍」吗?(规矩 4)
- [ ] 推翻了旧结论的话,旧的标「已撤销」了吗?(规矩 5)
- [ ] 这件事跨服务吗?另一份手册里留指路了吗?(规矩 6)
- [ ] 动了规矩的话,原文和原因留下了吗?(规矩 7)
- [ ] **跑一遍 `bash scripts/docs-check.sh`,四项硬检查全绿了吗?**(规矩 8)

**拿不准就往「多写一句」的方向偏**——省 token 的优先级永远低于别让下一个人干错活。

## 10. 万一以后不得不拆:照这个做(2026-08-21 现场量过,**动手前再核一遍数字**)

**先说结论:半天的活,技术风险很低,风险全在「漏」。**
**最可能触发拆分的理由**:所有者想把 OB 分享/公开出去 —— 那时运维手册里的服务 ID、
域名、部署细节不能跟着一起泄露。

### 每个服务要干什么

| 服务 | 搬走要做什么 | 难度 |
|---|---|---|
| `kelivo-shim/` | 文件夹剪到新仓库。**Zeabur 一个字都不用改** —— 它走 `zeabur deploy <目录>`,不看 git | 🟢 |
| `telegram-bridge/` | 同上,**外加**把 `.github/workflows/test-bridge.yml` 一起搬(它只监听 `telegram-bridge/**`) | 🟢 |
| `dwell-bridge/` | 同上,Zeabur 不用动 | 🟢 |
| `gmail-mcp/` | 文件夹 + `.github/workflows/build-gmail-image.yml` 一起搬,**并在新仓库里把 Actions 打开**。镜像名不变(`ghcr.io/mia06250603ian/gmail-mcp`)的话 Zeabur 不用改 | 🟡 最容易漏 |
| `browser-hands/` | 只有一份手册,挪进 `Mia06250603ian/browser-hands` 即可 | 🟢 |
| **根目录(OB)** | **不搬。** 它是本仓库的主人:Zeabur 从 main 拉、`daily-backup.yml`、`tests.yml` 都挂在它身上 | ⚪ |
| **`.github/workflows/healthcheck.yml`<br>+ `.github/scripts/healthcheck.py`** | **两边都要。** 它一个脚本同时体检 **OB + shim + bridge 三家**(2026-08-21 查出,原第 10 节漏了这条)。**拆成两份**:OB 那份只留 OB 的检查,新仓库那份留 shim/bridge 的。⚠️ 别整个搬走 —— 那样 OB 就没看门狗了;也别原样留下 —— 那样 OB 仓库里还带着 shim 的域名,「公开 OB」这个拆分动机就白费了 | 🟡 **最容易漏的第二名** |

### 收尾(真正花时间的部分)

1. **改指路 —— 先跑命令现场量,别信写死的数。**

   ⚠️ **本条原文(2026-08-21 早些时候写的)已撤销,别照它估工作量。** 原文是:
   「别处提到 `kelivo-shim/` **54 次**、`telegram-bridge/` 16 次、`gmail-mcp/` 5 次、
   `dwell-bridge/` 4 次、`browser-hands/` 6 次;各服务手册反过来提根目录文档 17 次」,
   配一段 `for d in ...` 的循环。**那个算法把「总提及数」当成了工作量,高估了五倍以上。**
   错在哪:那些提及里**八成躺在 `OPERATIONS.md` / `TIMELINE.md` / `START-HERE.md` 三份全局手册里**,
   而这三份**本来就要跟着服务一起搬去新仓库** —— 一起搬,相对路径原地有效,**一个字都不用改**。
   (同日用原文那个旧算法复量:**108 处**,而原文记的是 85 处 —— 数本身当天就已经过期;
   但**真正要改的行数六周几乎没动**,见下。这正是规矩 4 说的「别让下一个人拿快照当现状」。)

   **真正要改的,只有「跨界」的两类:** ①留在 OB 这边、却指向搬走的东西;②搬走了、却指回 OB 自己的文档。
   **这两类必须现场量,别抄下面的数**(规矩 4)。量法:

   ```bash
   # 在仓库根目录跑。STAY = 留守 OB 的文件;MOVE = 要搬走的目录与文档。
   # ⚠️ 拆分方案变了就改这两行(尤其 TIMELINE.md 归哪边,见下一条)。
   STAY="README.md INTERNALS.md ENV_VARS.md BEHAVIOR_SPEC.md CLAUDE_PROMPT.md server.py .github/scripts/healthcheck.py"
   MOVE="OPERATIONS.md START-HERE.md TIMELINE.md kelivo-shim telegram-bridge gmail-mcp dwell-bridge browser-hands docs"
   SVC='kelivo-shim|telegram-bridge|gmail-mcp|dwell-bridge|browser-hands|yan-shim|yan-telegram-bridge|yan-gmail|yan-dwell|yan-browser|OPERATIONS\.md|START-HERE\.md|TIMELINE\.md'
   OBDOC='INTERNALS\.md|BEHAVIOR_SPEC\.md|ENV_VARS\.md'

   echo "── A:留守 OB 的文件 → 指向要搬走的东西 ──"
   grep -nE "$SVC" $STAY
   echo "── B:要搬走的文件 → 指回 OB 自己的文档 ──"
   grep -rnE "$OBDOC" --include='*.md' $MOVE
   ```

   **2026-08-21 实测:A=8 行、B=12 行(已扣自指),合计 20 行。**
   (A 的 8 行:`README.md:11`、`INTERNALS.md:222`、`server.py:2112`、
   `.github/scripts/healthcheck.py` 5 处。B 的 12 行:`OPERATIONS.md` 6、`START-HERE.md` 2、
   `TIMELINE.md` 3、`kelivo-shim/DEPLOY-LOG.md` 1。)

   **这个数会变,以命令当场跑出来的为准 —— 本节自己就是活例子:**
   写这节时先量到 **19 行**,写完往 `TIMELINE.md` 补了一条档案、那条档案里引用了 `INTERNALS.md`,
   **当场变成 20 行**。**一次普通的写文档就能让它 +1。所以永远别抄这个数,跑命令。**

   ⚠️ **自检时必然遇到的一个假象:本节自己会被命令数进去。** 上面那段命令文本和实测记录里
   就写着 `INTERNALS.md` 等文件名,所以 B 的结果里会混进几行 `OPERATIONS.md:` ——
   **凡是行号落在第 10 节(本节)范围内的,都是自指,不是真指路,一律扣掉。**
   2026-08-21 写完本节后照命令跑:**B 原始 14 行,其中 3 行是本节自指,扣掉后 11 行**,与上面记的数吻合。
   要自动扣掉,在 B 那条后面接一段:

   ```bash
   S10=$(grep -n '^## 10\.' OPERATIONS.md | cut -d: -f1)   # 第 10 节起始行
   grep -rnE "$OBDOC" --include='*.md' $MOVE \
     | awk -F: -v s="$S10" '!($1=="OPERATIONS.md" && $2>=s)'
   ```

   **⚠️ 这条命令的两个已知上限,别当它万能:**
   - **只抓写了文件名/域名的指路。** 有人写「见根目录的运维手册」而没写 `OPERATIONS.md`,**它抓不到**。
     (2026-08-21 手工复查过一遍,当时没有这种写法;以后拆之前值得再手工扫一眼。)
   - **只回答「要改几行字」,不回答「拆要花多久」。** 建仓库、搬 workflow、开 Actions、
     **四个服务各部署验收一遍** —— 那才是半天里的大头,和本数无关,也不会因为拖久了变贵。

   **六周趋势(2026-08-21 用 `git rev-list --before` 逐周回查):总提及 13 → 46(涨 3.5 倍),
   但跨界行数 4 → 5(六周只多 1 行)。** 结论:**这件事不是滴答作响的炸弹,拖着不会变贵**;
   唯一会让它变贵的是**新增服务**(每加一个约多 2~3 行)和**下一条那个归属决定**。

2. **`TIMELINE.md` 归哪边 —— 拆分前的头号问题,必须先跟所有者定,它一个人就能让工作量翻三倍。**
   **(2026-08-21 量过:跟着搬 → 合计 20 行;留在 OB → `TIMELINE.md` 那 34 处对服务目录的引用当场全部变成跨界,合计约 54 行,而且它还在以每周 5~8 条的速度长 —— 这是本仓库唯一在长的耦合。)** 它记的是**全系统**的历史
   (shim 部署 / OB 改动 / bridge 功能混在同一条时间线上)。**抄一份到每个新仓库是错的**
   (重复的文档必烂,见第 9 节规矩 1)。

   **两个要求正面打架,所以这条至今没定,别当它已有结论:**
   - **留在 OB**(原文的建议):不重复、不烂,但 `TIMELINE.md` 里全是 shim 的服务 ID、
     域名、部署细节 —— **「公开 OB」这个拆分动机当场作废**,而那正是最可能触发拆分的理由。
   - **跟着搬走**:动机保住了、工作量最小(2026-08-21 实测 20 行),但 OB 那边的历史只剩一行指路,
     翻 OB 自己的旧事得跑去另一个仓库。
   - (第三条路:**按主题劈成两份**。没人试过,劈的时候一定会有「一条记录同时讲两边」的,
     成本没量过,**别在没量之前把它当省事的选项**。)

   ⚠️ **上面那条 `STAY/MOVE` 命令默认 `TIMELINE.md` 是搬走的。所有者要是定成留下,
   把它从 `MOVE` 挪到 `STAY` 再跑一次** —— 数会从 20 跳到 50 上下。
3. **新仓库要重新接**:Claude 的 GitHub 访问权限、必要的 CI、健康检查。
4. **搬完逐条验**:每个服务各部署一次并跑它自己的验收(shim 走《部署检查单》,
   OB 走 `OPERATIONS.md` 第 6 节的五步验收),别只看 `/health`。

### 为什么现在不拆(2026-08-21 所有者拍板)

- **技术上没在咬人**:代码零跨目录依赖;07-30 收窄监控路径之后,
  改 shim / 文档**不会误触发 OB 重建**(08-21 又验证一次:**合了两个纯文档 PR(#102 / #103),OB 一次都没重建**——线上跑的仍是当天手动 redeploy 的那份)。
- **拆完只换来「看着整齐」**,却要重接线、逐个服务重新部署验收,**风险主要是漏**。
  (⚠️ 本行原文写「改上百条指路」,**已撤销** —— 那是把总提及数当工作量,实际是 20 行(2026-08-21 实测),见上面收尾第 1 条。)
- 所有者真正的痛点是「打开仓库不知道里面有什么」—— 那个由**本文这张地图**解决,成本几乎为零。

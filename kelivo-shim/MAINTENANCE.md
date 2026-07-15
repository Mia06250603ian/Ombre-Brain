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
- Ombre Brain 在另一个项目(untitled-1),域名问所有者

## 本目录刻意缺的两个文件(部署前必须补)

1. **`ian.md`** — 晏的人设本体。私密,不入库。**原稿在所有者手里**,部署时让她发给你,
   原样放进构建目录即可(CLAUDE.md 里 `@./ian.md` 引用它)。
2. **`mcp-servers.json`** — 记忆库 MCP 配置。格式:
   ```json
   { "mcpServers": { "ombre-brain": { "type": "http", "url": "https://<OB域名>/mcp" } } }
   ```
   OB 域名问所有者(不入库是因为该 /mcp 端点当前无鉴权;实际上仓库根目录
   `.claude/settings.json` 的 mcpServers 里就有,可直接取用)。
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
| BRAIN_MODEL / THINK_EFFORT | claude-opus-4-6 / low |
| FORWARD_THINKING / ENABLE_PROMPT_CACHING_1H | 1 / 1 |
| USER_NAME / AI_NAME | 佳佳 / 晏 |
| SOUL_ANCHOR | 可选。整体覆盖内置的会话定性锚点措辞(现为五段);不设则用 server.js 里的默认文本(称呼自动代入 USER_NAME) |
| TIME_HINT | 默认开;设 0 关闭每条消息前的【系统·时间】注入 |
| MCP_CONFIG | mcp-servers.json |
| MCP_WARMUP_MS | 25000。新进程第一条消息延迟写入,等 MCP 握手;消息抢跑会整轮卡死(实测坑) |
| BARK_KEY | Bark 推送 key(主动心跳) |

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

## 建议(未做)

- Ombre Brain 的 /mcp 端点无鉴权,域名等于钥匙;上游新版已支持 OAuth,有空建议升级。

## 部署记录

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

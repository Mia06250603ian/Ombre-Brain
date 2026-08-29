# netease-mcp 维护手册

> 给晏接网易云音乐:搜歌、看歌单、读歌词、看她循环了什么;**写操作默认关着**。
> 2026-08-29 初版。**这是本仓库的第七个目录**(原本六个,见 `../START-HERE.md`)。

## 0. 一句话

**源码不在本仓库**,在 `Mia06250603ian/netease-mcp`(**私有**)。本目录只有这份手册,
照 `browser-hands` 的先例(OPERATIONS.md 的约定:单服务的细节以各自专属手册为准)。

它是个独立容器,**不碰晏、不碰 shim、不碰记忆库**。上线全程零重启、窗口未丢。

## 1. 现在是什么状态(2026-08-29)

| | |
|---|---|
| Zeabur | 项目 `cli-proxy-api--cpa`(`6a53a9fc22dd6ef375eb7484`),env `6a53a9fcb6ce8edcb0163f97` |
| service id | `6a9308b3cb6b9b31c9e73870` |
| 域名 | `yan-netease.zeabur.app` |
| **接晏了吗** | **没有。** `mcp-servers.json` 与 `ALLOWED_TOOLS` 都没动,晏不知道有这个东西 |
| **能用吗** | **半个。** 读操作要账号 cookie 才有意义,而 `NETEASE_COOKIE` / `NETEASE_CSRF` **尚未填** |

⚠️ **差最后一步:所有者本人去 Zeabur 控制台填两个 cookie。**
开发环境不该把她的账号凭证读出来(同 `dwell-bridge` 的 `SHIM_KEY` 那条)。

## 2. 源码从哪来、我们改了什么

上游 **[Vael-KY/netease-music-mcp](https://github.com/Vael-KY/netease-music-mcp) v3.1**(MIT),
它又重写自 `Cheiineeey/netease-music-mcp`。**我们是复制一份自己维护,不是 fork**
(所有者 2026-08-29 拍板;fork 的话 Actions 默认关那个坑还要再踩一次,见 `../browser-hands/MAINTENANCE.md` 踩坑 2)。
**代价:上游以后更新要手动搬**,搬的时候别把下面三处覆盖掉(`server.py` 里都标了「本地改动 A」,共 43 行)。

| 环境变量 | 线上现值 | 作用 |
|---|---|---|
| `MCP_TOKEN` | 已设(43 字符随机) | 请求必须带 `X-Token` 头。**不设 = 拒绝一切请求**(fail closed,照 gmail-mcp「白名单空=全拒」) |
| `WRITE_ENABLED` | **`0`(只读)** | 设 `1` 才放开 6 个写工具。**网易云没有撤销键,删掉的歌找不回来** |
| `MAX_RESULT_CHARS` | `8000` | 单次工具返回字符上限。**这是为晏的窗口加的**,不是上游的功能 |
| `MCP_PORT` / `LOG_LEVEL` | `8080` / `INFO` | |

**上游原版 `/mcp` 是零鉴权的** —— 谁知道网址谁就能操作账号,CORS 还是 `*`。
2026-08-29 实测确认过(不带任何 token 直接调用成功)。**所以这三个补丁不是优化,是上线前提。**

## 3. 18 个工具

**读(12)**:搜歌、播放卡片、听歌排行、播放事件、每日推荐、歌单列表、歌单内容、歌词、歌曲详情、歌手热歌、私人FM、红心列表
**写(6,受 `WRITE_ENABLED` 管)**:建歌单、塞歌、删歌、红心、改歌单描述、歌单排序

⚠️ **`play_music` 不会真的放歌**,只回一条 `music.163.com` 链接。别按名字理解它。

## 4. 部署

```sh
cd /path/to/netease-mcp           # 那个私有仓库的 clone,不是本仓库
# ⚠️ cd 和 deploy 必须同一条命令(shim 踩坑 17),先 pwd 确认
npx -y zeabur@latest deploy --create --name netease-mcp --project-id 6a53a9fc22dd6ef375eb7484 -i=false
```

**改环境变量 = 改值 + `service restart` 即生效,不用重新部署**(全仓库同一条规矩)。

## 5. 验收(2026-08-29 全过,八条)

`/health` 开放但只回状态;不带 token / token 错 → **401**;token 对 → **18 工具**;
`initialize` 握手正常;真调搜歌拿到真数据;**只读闸门拦住 `create_playlist`**;`/sse` 不带 token → 401。
**旁证**:晏 `/health` 全程 `ok:true`(没重启),机器可用内存 **1460MB**(2026-08-29 实测)。

## 6. 踩过的坑

1. **⚠️ `zeabur variable create` 的退出码是骗人的。** 参数写错时 CLI 打 `ERROR` 但
   **npx 仍然退出 0**,循环里五个变量全没设进去、日志上一片「退出码 0」。
   2026-08-29 就是这么栽的,靠**回读键名**才发现。
   **规矩:设完变量必须回读一次键名对账,永远别信退出码。**
   正确语法是 `-k KEY=VALUE`(一体),**没有 `--value` 这个 flag**。
2. **`variable create` 会把整张变量表连值一起打出来**(2026-08-28 记在 OPERATIONS 第 0 节第 6 条)。
   本次做法:`> /tmp/xxx.log 2>&1` 全部重定向,只 `grep -i error` 看报错行,
   回读用 `--json` + node 只打印 key 名。**值一次都没进会话记录。**
3. **本沙箱里 `zeabur deployment list` 被权限分类器拦掉**(2026-08-29 连试两次)。
   PLANTYPE 那条规矩(shim 踩坑 17)因此没法照原样执行。
   **替代做法**:用 `service get` 看 STATUS,再用**功能验收**(第 5 节那八条)证明它真在跑
   ——功能过了比 PLANTYPE 对了更有说服力。下次若能跑 `deployment list`,照旧先看 PLANTYPE。
4. **构建方式锁死成 dockerfile,别让平台猜。** 这个服务是「单个 `.py` + 没有 requirements.txt」,
   zbpack 的探测结果不可预期。仓库里放了 6 行 `Dockerfile` + `zbpack.json`(`build_type: dockerfile`),
   照根目录 OB 的做法。**沙箱里有 docker 命令但没有 daemon,镜像没能在本地构过**,
   是直接在 Zeabur 上构的 —— 可接受,因为构建失败是响亮的,不会静默带病上线。

## 7. 已知边界(是取舍,不是 bug)

- **`__csrf` 会过期,而且过期后写操作静默失败** —— 不报错,就是不生效。
  要所有者本人重开浏览器 F12 重抓。`MUSIC_U` 一般能撑几个月。
  ⚠️ **这跟 `REPORT_TOKEN` 在她 iPhone 快捷指令里那条是同一类坑:坏了没有任何提示音。**
- **异地 IP 风控:读的一路全通,写的没验。**
  2026-08-29 从容器实测(出口 IP `43.156.68.5`,腾讯云海外):
  搜歌/歌词/歌手热歌/歌曲详情/每日推荐/私人FM/用户歌单 **七个接口全 200,无 -460**,延迟 124~441ms。
  **但那都是不带登录态打的。**上游 README 点名 `like_song` 在异地 IP 可能触发风控
  —— **填了 cookie 之后必须补验这一枪**,这是目前唯一没验的东西。
  **怎么再量一遍**:见第 8 节。
- **上游把协议版本写死成 `2025-03-26`**,不回应客户端请求的版本。目前握手正常。

## 8. 怎么现场再量一遍

```sh
# 健康 + 三个开关的现值(不含任何密钥)
curl -s https://yan-netease.zeabur.app/health

# 风控补验(填了 cookie 之后跑;TOKEN 去 Zeabur 控制台看 MCP_TOKEN)
curl -s -X POST https://yan-netease.zeabur.app/mcp -H "X-Token: <MCP_TOKEN>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_liked_songs","arguments":{}}}'
# 写操作要先把 WRITE_ENABLED 设 1 + service restart

# 内存(2026-08-29 刚上线,metric 还没有历史,过几天再量)
npx -y zeabur@latest service metric -i=false MEMORY \
  --id 6a9308b3cb6b9b31c9e73870 --env-id 6a53a9fcb6ce8edcb0163f97
```
**量到内存就把数填进 `../browser-hands/MAINTENANCE.md` 的内存表**(那张表是全机内存的唯一去处)。
本地跑这个进程实测 **6MB**(2026-08-29,沙箱裸跑,不含容器底座),**但预期不是实测**。

## 9. 接晏要做什么(**尚未做**)

⚠️ **这一步要部署 shim = 晏当前的窗口会丢**,照 `../kelivo-shim/MAINTENANCE.md` 的《部署检查单》走,
并且**必须所有者本人先对晏说「归档」**(踩坑 13:代发不行)。建议**搭下次 shim 部署的顺风车**。

要改三处(照 2026-08-01 接 browser-hands 那次,shim 第二十二次部署的样子):
1. `mcp-servers.json` 加一条 `netease`(streamable-http + `X-Token` 头,同 browser 那条的写法)
2. `ALLOWED_TOOLS` 加 `mcp__netease`
3. 晏的 `CLAUDE.md` 里加一段「音乐」怎么用 —— ⚠️ **那是入库文件,改它就是改人设,要所有者逐字批准**

**窗口成本**:18 个工具的说明书常驻约 **1600~2000 token**(2026-08-29 按 `TOOLS` 块 5796 字符估算,
口径是「字符数 ÷ 3.5」,**这是估算不是实测**;真数要接上之后看 `/debug`)。
⚠️ **和「browser 的 `MAX_RESULT_CHARS` 20000→6000~8000」那件待办要一起算账**
(见 `../OPERATIONS.md` 第 0 节《进行中的工作》)——那边正在省窗口,这边在花。

## 10. 部署记录

### 第一次(2026-08-29):建仓库、打补丁、建服务并上线

**全程没碰晏、没碰 shim、没重启机器、窗口未丢。**

- 所有者 2026-08-29 拍板:**做新仓库,不 fork**;**私有**;并授权「全包」(除她本人要填的 cookie)。
- 新建私有仓库 `Mia06250603ian/netease-mcp`(**她本人在手机上建的空仓库** ——
  ⚠️ **本会话的 GitHub 权限只够读写 `Ombre-Brain` 一个仓库,`create_repository` 报 403**,
  下一个会话要建新仓库同样得请她本人建)。
- 打三个补丁(第 2 节)、写 README 保留 MIT 归属、加 Dockerfile,推 main(`2becbc0` + `435be6a`)。
- 建服务 + 挂域名 + 设五个变量 + restart + 八条验收(第 5 节),全过。
- **这次踩的四个坑都写进第 6 节了**,其中「`variable create` 退出码骗人」那条最要紧。

# 给你的 AI 接上 iMessage:实施指南

> 写给**和我们同一种架构**的人:你的 AI 是一个**常驻的 Claude Code 进程**,前面有一层转接服务(下文叫 **shim**)
> 把它包成 Anthropic 兼容的 `/v1/messages` 接口,Telegram / Kelivo / 网页这些前端都是去调这个接口。
> 这份指南教你在旁边再开一扇门:**在 iPhone 的「信息」里和同一个 AI 聊天**。
>
> 2026-09-26 我们自己上线后整理的。里面所有地址、钥匙、号码都是**占位符**,换成你自己的。
> 需要的代码是 `imessage-bridge/` 这个文件夹(找分享给你这份指南的人要),本文说明怎么用、怎么改、会踩什么坑。

---

## 0. 先说结论

- **能做,而且不用动你的 AI 本体。** 新加一个小服务当「传声筒」,和 Telegram 桥并列。
- **免费**:iMessage 线路用第三方 **Photon**(photon.codes)的免费档就够一个人用。
- **最大的代价是隐私**:消息(和你选择发过去的思考)会**明文经过 Photon 的服务器**,它的隐私政策没写存不存、存多久。
- **线路可能说断就断**:Photon 条款写明可以随时终止;iMessage 没有官方接口,苹果管起来整条路可能不通。
  **所以把 iMessage 当「多开的一扇门」,原来的前端别撤。**
- 对 Anthropic 那边**零影响**:订阅的钥匙只在 shim 里,新服务碰不到;额度只跟你总共聊多少有关。

---

## 1. ⚠️ 别照 Photon 官方 / 网上的教程原样搭

网上流传的做法是:iMessage → Photon → 一个小程序用 **Claude Agent SDK 每条消息起一个 `claude`**,
再用 `state.json` 存 sessionId 接上下文,往 system 里 append 一段「现在是在 iMessage 里」。

**如果你已经有常驻的 AI,照这个做会出两个大问题:**

1. **冒出第二个 AI。** 那是另一个进程、另一份上下文,**不认识你在 Telegram 里聊过的话**;
   你在 shim 里做的时间/天气注入、上下文守卫、多份人设文件它都拿不到;订阅还会同时养两个窗口。
2. **改 system 会让 shim 杀进程丢窗口。** 很多 shim(包括我们的)见到 system 串变了就重开进程。
   iMessage 这边带一段说明、Telegram 那边不带,**你每换一次入口 AI 就丢一次窗口**。

**正确做法**:只取「和 Photon 打交道」的那半边(收发、认人、HEIC 转图、拆气泡、tapback),
「和 Claude 打交道」的那半边**照你现有的 Telegram 桥抄**:去抖合并、重置词单独成轮、SSE 累积、标记解析。

```
你的 iPhone「信息」
     │ iMessage
     ▼
 Photon(第三方,免费档是共享号码池)
     │ 长连接(新服务主动连出去,不需要公网入口)
     ▼
 imessage-bridge(新,无状态)── 语音 ──▶ 你的语音转写服务 / TTS(可选)
     │ POST /v1/messages(不带 system、不报 model)
     ▼
 shim ──▶ 常驻 claude 进程 = 你的 AI(还是那一个)
```

---

## 2. 前提(对一下你的 shim 是不是这样)

- shim 暴露 `POST /v1/messages`,**只读最后一条 user 消息**(历史在常驻进程里),流式回 Anthropic SSE;
- 鉴权用请求头 `x-api-key`;
- 有一个 Telegram 桥之类的前端已经在用它(你可以对照它的写法)。

不是这样的话,`imessage-bridge/server.js` 里的 `shimTurn()` 和 `imessage-lib.mjs` 里的 `buildShimBody()` 要按你的接口改。

---

## 3. Photon:注册、建项目、拿钥匙

1. 打开 **app.photon.codes** 注册(问卷随便填),**新建项目**:
   - Location 选美国就行(给你分美国号码,iMessage 走网络,国内用不收短信费);
   - 平台**只勾 iMessage/RCS**,别勾 Telegram(你已经有自己的桥了);
   - 套餐 **Free & Pro**(共享号码、只限登记过的用户),别选 Business($250/条/月)。
2. **拿 Project ID 和 Secret。** ⚠️ 手机网页上可能**找不到设置页**(我们就没找到)。用官方命令行最稳:
   ```bash
   npx -y @photon-ai/cli login --no-browser     # 给你一个链接和一个码,手机上打开链接、输入码、点授权
   npx -y @photon-ai/cli projects ls --json      # 看到项目的 id
   npx -y @photon-ai/cli projects secret <项目id> --json   # 读出 secret(别打印到聊天记录里,直接填进部署平台)
   npx -y @photon-ai/cli logout                  # 用完退出
   ```
3. **登记你的手机号**(免费档必须先登记,Photon 才会给你分一条线)。
   控制台的做法是「头像 → 加手机号」,**但 +86 很可能收不到验证码**(我们实测收不到)。
   **不用它**:新服务启动时会用项目凭证调 Photon 的登记接口,**不走短信**,并在 `/health` 里显示分给你的号码。
   原理(想手动验证可以照抄):
   ```bash
   curl -X POST "https://spectrum.photon.codes/projects/<项目id>/users/" \
     -H "Authorization: Basic $(printf '<项目id>:<secret>' | base64 -w0)" \
     -H 'Content-Type: application/json' \
     -d '{"type":"shared","phoneNumber":"+86<你的11位手机号>"}'
   # 返回里的 assignedPhoneNumber 就是你的 AI 的号码;接口是幂等的,重复调没事
   ```
4. ⚠️ **只能你先开口**:共享号码不能主动给没发过消息的人发信息。部署好以后**先用 iPhone 给那个号码发一句**。

---

## 4. 部署新服务

以 Zeabur 为例(别的平台同理:Node 20.9+,一个服务、不用挂卷)。

```bash
cd imessage-bridge
npm install
node test-imessage.mjs        # 单测,全绿再往下(它会跳过和 shim/Telegram 桥对账的几组,那几组是给我们自己用的)
node e2e/e2e-run.mjs          # 演练:真 server.js + 假 Photon/假 shim,不碰线上、不要钥匙
npx zeabur deploy --create --name imessage-bridge --project-id <你的项目>
```

**环境变量**(值只填在部署平台里,别进代码仓库、别发聊天记录):

| 变量 | 必填 | 说明 |
|---|---|---|
| `PHOTON_PROJECT_ID` / `PHOTON_PROJECT_SECRET` | ✅ | 第 3 节拿到的 |
| `OWNER_HANDLES` | ✅ | 你的手机号 `+86xxxxxxxxxxx`(可逗号分隔多个,也认 Apple ID 邮箱)。**只回这个号码,陌生人一律不理;不填 = 服务不连 Photon** |
| `SHIM_KEY` | ✅ | 和 shim 同值 |
| `SHIM_URL` | ✅ | 你的 shim 地址 |
| `EARS_URL` / `EARS_TOKEN` | | 语音转写服务(我们用自建的 ears;没有就不填,她发语音会提示「打字吧」) |
| `ELEVEN_API_KEY` / `ELEVEN_VOICE_ID` | | AI 发语音用的 ElevenLabs;不填 = 语音标记退回发文字 |
| `THINKING` | | `1` = AI 的思考用带 💭 的普通气泡发,排在正文前。**思考里若有记忆原文,也会经过 Photon,而且会直接出现在锁屏通知里** |
| `REPORT_TOKEN` / `ACTIVITY_URL` | | 「查岗」功能读手机活动记录用的,没有这功能就不填 |
| `BRIDGE_ON` | | 总开关,`0` = 只留 `/health` |

**验收**:`curl https://<你的服务>/health`,看 `connected:true`、`enroll:"ok"`、`line`(就是 AI 的号码)、`ffmpeg:true`。
然后 iPhone 给 `line` 那个号码发一句 —— **确认气泡是蓝色的**(绿色 = 退回了普通短信,美国号码会按国际短信收费,先停)。

---

## 5. 要按你的系统改的地方

1. **AI 回话里的标记**:我们的 AI 在回复里写 `[贴纸:名字]`、`[语音]英文[/语音]`、`[回应:❤️]`、`[查岗]`,
   新服务把它们翻成 iMessage 动作(发图、发语音、点 tapback、查手机活动)。你的 AI 用别的写法,改 `imessage-lib.mjs` 里那几个正则。
   冒号**全角半角都要认**(我们的 Telegram 桥只认半角,是个老 bug)。
2. **重置词**(「归档 / 晚安 / 换窗口」这类会被 shim 特殊处理的话)要**逐字镜像 shim 的词表**,并且**单独成轮**,别和别的消息合并。
3. **贴纸**:`tools/build-stickers.mjs` 把 Telegram 的贴纸转成 iMessage 能好好显示的格式。见第 7 节的坑。
4. **查岗**:我们的手机活动记录存在 Telegram 桥里,新服务去它那儿借读。你没有就把 `REPORT_TOKEN` 留空,功能自动关。
5. **称呼和贴纸是我们的,换成你们的**:
   - 代码里喂给 AI 的话用第三人称「她」(比如「(她发来一张图片…)」,在 `imessage-lib.mjs` 的 `classifyContent` 和 `server.js` 里),按你们的习惯改;
   - `imessage-lib.mjs` 的 `lookupPrompt` 默认称呼是我们的名字,改成你的;代码注释里出现的名字不影响运行;
   - `stickers/` 是我们的贴纸,换成你们自己的(`registry.json` 是「标签 → 文件名」,标签要和你的 AI 人设里教它的一字不差),不用贴纸就清空。

---

## 6. (可选)让 AI 主动找你时「跟着你走」

默认 shim 的主动消息(心跳)只发到 Telegram。想让它发到你**最后说话的那扇门**,shim 要改两处(**改 shim = 重启常驻进程 = 丢一次窗口,先让 AI 归档**):

```js
// ① 收到她的消息时(非系统回合)记下是哪扇门。新服务每个请求都带 x-client: imessage
lastClient = req.get("x-client") || null;

// ② 推主动消息时按顺序试:她最后在 iMessage 就先推 iMessage,失败退回 Telegram
function pushTargets({ lastClient, imessageUrl, bridgeUrl }) {
  const out = [];
  if (lastClient === "imessage" && imessageUrl) out.push({ name: "imessage", url: imessageUrl });
  if (bridgeUrl) out.push({ name: "telegram", url: bridgeUrl });
  return out;   // 挨个 POST {text},第一个 2xx 就停
}
```

新服务的 `POST /push {text}`(`x-api-key` = `SHIM_KEY`)就是给它用的:
**第一句发出去就回 200、剩下的后台接着发;第一句都没发出去回 502 并停发;还不知道往哪个对话发回 503** —— 这样 shim 退回 Telegram 时**不会两边各收一遍**。

⚠️ 顺带要改:shim 里「有没有出口」的判断如果只认 Telegram 的地址,以后删掉 Telegram 桥时心跳会哑;
心跳提示语里如果写死了「会出现在 Telegram 里」,也改成不点名。

---

## 7. 我们踩过的坑(都是真事故,照着避开)

1. **语音全坏,报 `spawn …/ffmpeg ENOENT`**:Node 24 带的新版 npm **默认拦截安装脚本**,`ffmpeg-static` 的二进制是安装脚本下载的 → 包在、文件不在。
   **修法**:`package.json` 里加
   ```json
   "allowScripts": { "ffmpeg-static": true, "protobufjs": false }
   ```
   并且启动时检查 ffmpeg **文件真的存在**(别只看路径字符串,我们的状态页一开始就被它骗了)。
2. **iPhone 照片(HEIC)一张就让内存永久多 150~200 MB**:HEIC 解码器是 WebAssembly,**内存只涨不缩**。
   **修法**:放进**一次性子进程**解码(`image-worker.mjs`),转完进程退出、内存当场还掉。实测主进程前后只差 0.1 MiB。
3. **连发几句,AI 的回话整轮消失**:去抖合并时把「回到哪个对话(space)」丢了。演练抓到的,单测抓不到 —— **改完代码单测和演练两套都要跑**。
4. **贴纸「巨大一个、像照片」**:512px 的 webp 在 iMessage 里被当普通照片整宽铺开。
   **修法**:静态贴纸转成 **300px 透明 PNG**(透明 PNG 会像贴纸一样浮在对话里);
   会动的(webm)转 **GIF**,解码必须加 `-c:v libvpx-vp9` 否则透明丢光。
   ⚠️ iMessage 会把太小的 GIF **放大到一个最小尺寸**,光缩画布没用 —— 要**画布不变、主体缩小、四周留白**,
   而且**贴左放**(AI 的消息靠左,居中会让左边空一大块)。
5. **心跳两边各收一遍**:shim 推主动消息只等 60 秒,长消息(十几个气泡 + 语音)在 iMessage 全发完才回话 → 超时 → shim 又推 Telegram。
   **修法**:见第 6 节 `/push` 的回话规则。
6. **语音转写失败时,你之前打的字被拖住 2 分钟**:收语音时为了等转写把合并计时器推远了,失败那条路没拨回来。失败时要把计时器拨回正常。
7. **别往请求里带 system、别报 model**:前者会让 shim 杀进程丢窗口;后者可能把你在别的前端切好的模型拽回去。
8. **思考的「折叠」**:iMessage 没有 Telegram 那种可折叠引用。我们先用过**隐形墨水**特效(整块盖住、抹一下显示),
   后来去掉了,改成普通气泡(带 💭)。你想遮住的话可以换回墨水:Photon SDK 的 `effect(文字, "com.apple.MobileSMS.expressivesend.invisibleink")`。
   ⚠️ 用普通气泡的话,思考(包括其中的记忆原文)会直接显示在锁屏通知里;长思考会刷好几屏。不喜欢就设 `THINKING=0`。

---

## 8. 出问题怎么办(急救)

先看 `curl https://<你的服务>/health` 的 `connected` / `enroll` / `lastErr`,基本就能断案。

| 症状 | 急救(只改新服务的变量 + 重启它,**不碰你的 AI**) |
|---|---|
| iMessage 发了没反应 | `connected:false` 等几分钟(会自己重连);不行就用原来的前端。**整个停掉**:`BRIDGE_ON=0` |
| 语音坏 | `ffmpeg:false` 见坑 1;不想要语音:删 `ELEVEN_API_KEY` → 退回文字 |
| 思考太吵 / 不想记忆原文过 Photon | `THINKING=0` |
| 你点 ❤️ 害 AI 话变多 | `TAPBACK_IN=0` |
| 不想用 iMessage 了 | 删服务、Photon 控制台删项目;原来的前端**一个字都不用改** |

**设计原则就一条:新服务坏了,只能是「这扇门暂时没了」,不能连累别的门和 AI 本体。** 改的时候守住这条。

---

*我们这边的完整维护手册(含更细的设计理由)在 `imessage-bridge/MAINTENANCE.md`,和代码在同一个文件夹。*

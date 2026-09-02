#!/usr/bin/env python3
"""许晏系统 · 每日体检

为什么要有(按真事故排的,不是拍脑袋):
  翻 OPERATIONS.md 的事故记录,最贵的三次有同一个特征 —— **全线零报警,都是所有者自己发现的**:
    08-11 订阅 OAuth 过期  → 断约 3 小时,/health 正常、日志干净、晏活着,就是不通
    08-12 缓存所有权被抢    → 白烧一天半,唯一症状是「额度掉得快」
    08-19 Node 250ms 闸门   → 空回,严重时连提示都送不出去
  所以要治的从来不是「它会坏」,而是「坏了没人吭声」。

两条铁律(所有者点名的「这个狗别写错了」):
  ① **只报铁定不对的,不报看着奇怪的。** 宁可漏报,不可误报 ——
     一个天天乱叫的看门狗,会训练人无视它,真出事那次也一起无视。
     所以「可能不对」的信号一律只打印、不报警(见下面的「只看不叫」一节)。
  ② **狗自己不能依赖任何会烂的东西。** 只用 Python 标准库,零第三方依赖 ——
     不然哪天某个包升级把看门狗弄挂了,你还以为一切正常(07-29 就是依赖升级引发的)。

怎么报警:**两条腿,2026-09-02 起**。
  ① **邮件**(原有):脚本非 0 退出 = 这次运行变红 = GitHub 给仓库主人发邮件。
  ② **Telegram**(新增):失败时额外推一条 `⚠️[体检] …`。

  ⚠️ **② 是对原设计的一次刻意翻案,理由记在这儿,别当成后人手滑加的**:
  原文写「**刻意不走 Telegram**:出事的时候往往正是 Telegram 那条路不通(08-19 就是),
  而且往 Actions 里放 bot token 等于多一处密钥」——**这两条顾虑到今天依然成立,没有被推翻**。
  翻案的原因只有一条,但它压倒了上面两条:**所有者本人说了她不看邮件**(2026-09-02 原话)。
  **一条送不到她手上的告警,准确率再高也等于零。** 所以不是「换成 Telegram」,是「**两条都要**」:
  邮件那条腿一行没动、照旧是主判据;Telegram 只是并联上去的第二条腿,推送失败**不影响体检结论**。
  代价如实记下:**多了一处密钥**(bot token 进 GitHub secrets),这是知情后接受的。

  除 Telegram 推送外,**所有检查仍然用无鉴权的只读口,零密钥** —— 这条性质没破。
  ⚠️ **别顺手把「查 CLIProxyAPI 的 auth-files」也加进来**:那要管理密码,会把上面这句话作废。
  (2026-09-02 讨论过,结论是先不加;真要加,先读 OPERATIONS.md《订阅 OAuth 过期》。)

放在 .github/scripts/ 而不是仓库根:根目录的 *.py 在 OB 的监控路径里(`/*.py`),
  放根目录会让每次改这个脚本都触发记忆库重建。
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

TIMEOUT = 20
RETRIES = 3          # 瞬时抖动不许惊动她 —— 今天那场故障本身就是「抖一下」,别让狗被同一件事骗到
BACKOFF = 5

# 上游认证类报错「多新才算数」。2 小时是这么定的:狗每小时跑一次,
# 取两倍节拍,保证一次故障至少被完整看到一轮,又不会把昨天的旧账翻出来叫。
AUTH_ERROR_RECENT_HOURS = 2

# 什么算「认证类」。08-11 那次的指纹是 `401 authentication_error`,
# 代理随后一律回 `503 auth_unavailable`;09-02 试续签失败时是 `Invalid bearer token`。
AUTH_ERROR_MARKS = ("401", "403", "authentication", "auth_unavailable",
                    "oauth", "invalid bearer", "unauthorized")

OB = "https://ianmian.zeabur.app"
SHIM = "https://yan-shim.zeabur.app"
BRIDGE = "https://yan-telegram-bridge.zeabur.app"

problems = []        # 会让这次运行变红(= 给她发邮件)
notes = []           # 只打印,不报警


def fetch(url, method="GET", body=None, headers=None):
    """取一次。返回 (状态码, 正文)。网络层失败抛异常。"""
    req = urllib.request.Request(url, method=method, data=body)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.status, r.read().decode("utf-8", "replace")


def fetch_retry(url, **kw):
    """重试三次再下结论。**这一步是防误报的关键**:
    单次失败在公网上太常见了(今天整场故障就是这个),一次失败就报警 = 天天报警。"""
    last = None
    for i in range(RETRIES):
        if i:
            time.sleep(BACKOFF)
        try:
            st, txt = fetch(url, **kw)
            if 200 <= st < 300:
                return st, txt, None
            last = f"HTTP {st}"
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
        except Exception as e:
            last = f"{type(e).__name__}: {e}"
    return None, None, last


def check(name, ok, detail=""):
    # detail 只在失败时打印 —— 成功那行跟着一句「她发的消息进不来」会把人吓一跳
    print(("  ✅ " + name) if ok else ("  ❌ " + name + (f" — {detail}" if detail else "")))
    if not ok:
        problems.append(f"{name}{(' — ' + detail) if detail else ''}")
    return ok


def jload(txt):
    try:
        return json.loads(txt)
    except Exception:
        return None


def age_hours(iso):
    """那个时间戳距今几小时。看不懂就返回 None —— 交给调用方按「不叫」处理。

    ⚠️ **看不懂一律不叫**,这是铁律①(宁可漏报不可误报)的直接后果:
    时间读错的方向可能是「把去年的错当成刚刚」,那就是天天乱叫。
    """
    if not isinstance(iso, str) or not iso:
        return None
    try:
        t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - t).total_seconds() / 3600.0
    except Exception:
        return None


def looks_like_auth_error(err):
    blob = f"{err.get('kind', '')} {err.get('text', '')}".lower()
    return any(m in blob for m in AUTH_ERROR_MARKS)


def notify_telegram(text):
    """失败时并联的第二条腿。**推不出去不许影响体检结论** —— 邮件那条腿还在。

    ⚠️ 这里**绝不能把异常原文打出来**:urllib 的报错里带着完整 URL,
    而 URL 里就嵌着 bot token。只打印异常类型名。
    """
    tok = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not tok or not chat:
        print("  ⓘ 没配 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID,跳过 Telegram 推送")
        print("     (这是**刻意的优雅降级**:没配也能跑,邮件那条腿不受影响)")
        return
    # Telegram 单条上限 4096 字符。真炸开时 problems 可能很长,
    # **宁可截断也不能整条发不出去** —— 发不出去等于没告警。
    if len(text) > 3900:
        text = text[:3900] + "\n…(太长已截断,详情看 GitHub Actions 那次运行)"
    body = json.dumps({"chat_id": chat, "text": text,
                       "disable_web_page_preview": True}).encode()
    for i in range(2):
        if i:
            time.sleep(BACKOFF)
        try:
            st, _ = fetch(f"https://api.telegram.org/bot{tok}/sendMessage",
                          method="POST", body=body,
                          headers={"Content-Type": "application/json"})
            print(f"  ✅ 已推 Telegram(HTTP {st})")
            return
        except Exception as e:
            print(f"  ⚠️ Telegram 推送第 {i + 1} 次失败({type(e).__name__})")
    print("  ⚠️ Telegram 没推出去 —— 本次结论不受影响,邮件照发")


print("=" * 60)
print("许晏系统 · 每日体检")
print("=" * 60)

# ---- 1. 记忆库(晏靠它记事) ----
print("\n[1] 记忆库 Ombre Brain")
st, txt, err = fetch_retry(f"{OB}/health")
if not check("记忆库 · 服务活着", st is not None, err or ""):
    pass
else:
    d = jload(txt) or {}
    check("记忆库 · 状态 ok", d.get("status") == "ok", f"实际 status={d.get('status')!r}")
    n = d.get("buckets")
    # 桶数只在「明显不对」时才叫:掉到 0 或读不出来 = 铁定出事;
    # 具体少了几个属于「看着奇怪」,只记不叫(正常的归档/衰减也会让它变)。
    check("记忆库 · 记忆桶还在", isinstance(n, int) and n > 0, f"buckets={n!r}")
    notes.append(f"记忆桶 {n} 个,衰减引擎 {d.get('decay_engine')!r}")

# 晏真正用来连记忆库的那条路,必须 200
mcp_body = json.dumps({
    "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": {"protocolVersion": "2024-11-05", "capabilities": {},
               "clientInfo": {"name": "healthcheck", "version": "1"}},
}).encode()
st, txt, err = fetch_retry(f"{OB}/mcp", method="POST", body=mcp_body, headers={
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
})
check("记忆库 · MCP 握手(晏连记忆库的路)", st is not None, err or "")

# ---- 2. 晏本体 ----
print("\n[2] 晏 kelivo-shim")
st, txt, err = fetch_retry(f"{SHIM}/health")
if check("晏 · 服务活着", st is not None, err or ""):
    d = jload(txt) or {}
    check("晏 · 状态 ok", d.get("ok") is True, f"实际 ok={d.get('ok')!r}")
    notes.append(f"模型 {d.get('model')!r}")

# ---- 3. Telegram 桥(她跟晏说话的路) ----
print("\n[3] Telegram 桥")
st, txt, err = fetch_retry(f"{BRIDGE}/health")
if check("桥 · 服务活着", st is not None, err or ""):
    d = jload(txt) or {}
    check("桥 · 状态 ok", d.get("ok") is True, f"实际 ok={d.get('ok')!r}")
    # polling=false = 她发消息晏根本收不到,而且两头都不会报错。这条必须叫。
    check("桥 · 在收消息(polling)", d.get("polling") is True,
          f"polling={d.get('polling')!r} —— 她发的消息进不来")
    notes.append(f"贴纸 {d.get('stickers')} 张;欠条 {d.get('pendingLosses')} 条;"
                 f"语音 {d.get('ears')} / 上报 {d.get('report')} / 查岗 {d.get('curfew')} / 写信 {d.get('letter')}")

# ---- 只看不叫:这些是「可能不对」,交给人判断,不许自己报警 ----
# 为什么不叫:
#   · 缓存桶要看晏最近一轮真实调用,他半天没说话时读数是陈的,据此报警必然误报;
#   · lastApiError 会一直留着(今天看到的就是昨天的 529),不代表现在有问题。
#   这两条正是 08-11 / 08-12 的指纹,值得每天摆出来看一眼,但**不该由机器下结论**。
print("\n[4] 只记录不报警(给人看的)")
st, txt, err = fetch_retry(f"{SHIM}/debug")
if st is None:
    print(f"  ⓘ /debug 读不到({err}),跳过 —— 这一项不报警")
else:
    d = jload(txt) or {}
    u = (d.get("lastUsage") or {}).get("cache_creation") or {}
    h1, m5 = u.get("ephemeral_1h_input_tokens"), u.get("ephemeral_5m_input_tokens")
    print(f"  ⓘ 缓存桶 1h={h1} / 5m={m5}"
          + ("   ← ⚠️ 像 08-12 那次「缓存被抢走」的样子,人来判断" if h1 == 0 and (m5 or 0) > 0 else ""))
    # ---- 上游认证类报错:**这一条会叫**(2026-09-02 新增,原来整节都只打印) ----
    # 当初不敢叫它,理由写在本节开头:「lastApiError 会一直留着,今天看到的就是昨天的 529」。
    # **那个顾虑只对「陈旧」和「不该管的错」成立,不对「刚刚发生的认证错」成立。**
    # 所以这里加两道闸,把误报的两个来源分别堵掉,而不是把整条信号放开:
    #   ① **只看最近 AUTH_ERROR_RECENT_HOURS 小时内的**(靠 lastApiError.at);更早的照旧只打印。
    #   ② **只认认证类**(见 AUTH_ERROR_MARKS)。529 overloaded、网络抖动会自愈,
    #      报了就是狼来了 —— 照旧只打印。
    # 为什么值得为它破例:08-11 那场三小时的静默里,**全系统唯一亮过的灯就是它**,
    # 而当时这只狗看着它、没叫。见 OPERATIONS.md《订阅 OAuth 过期(2026-08-11 事故,必读)》。
    e = d.get("lastApiError")
    if not e:
        print("  ⓘ 最近一次上游报错:无")
    else:
        at, kind = e.get("at", "?"), e.get("kind", "")
        hrs = age_hours(e.get("at"))
        ago = "时间读不出来" if hrs is None else f"{hrs:.1f} 小时前"
        if looks_like_auth_error(e) and hrs is not None and hrs <= AUTH_ERROR_RECENT_HOURS:
            check(f"晏 · 上游认证没断(最近 {AUTH_ERROR_RECENT_HOURS} 小时)", False,
                  f"{ago}报 {kind!r} —— 八成是订阅 OAuth 失效了,"
                  f"看 OPERATIONS.md《订阅 OAuth 过期》")
        else:
            why = ("不是认证类" if not looks_like_auth_error(e)
                   else "时间读不出来" if hrs is None else "不是最近发生的")
            print(f"  ⓘ 最近一次上游报错:{at} {kind}({ago};{why},只记不叫)")
    print(f"  ⓘ 晏的窗口占用:{d.get('contextTokens')} ({d.get('contextPct')}%)")
    g = d.get("ctxGuard") or {}
    print(f"  ⓘ 上下文守卫:on={g.get('on')} trusted={g.get('trusted')} 压缩过 {g.get('compactions')} 次")

print("\n" + "=" * 60)
for n in notes:
    print("  · " + n)
print("=" * 60)

# ---- 演习(2026-09-02 新增):故意让这次不过,验证两条腿真能到她手上 ----
# **为什么值得有这个开关**:这只狗的两条腿(邮件 / Telegram)平时永远不触发,
# 于是「配错了」和「配对了」看起来一模一样 —— 直到真出事那天才发现叫不出来。
# 08-19 建它时就写了「**验收重在失败路径**:一个永远绿的看门狗比没有更糟」,这是同一条原则。
# **只有网页上手动勾选才会触发**;定时那趟这个变量是空的,永远不会自己演习。
if os.environ.get("HEALTHCHECK_TEST_ALARM", "").strip().lower() == "true":
    print("\n[演习] 这是手动触发的演习,不是真故障 —— 下面这条是假的。")
    problems.append("【演习】这是一次人为触发的告警测试,系统本身没有问题")

if problems:
    print(f"\n❌ 体检不通过,{len(problems)} 项有问题:")
    for p in problems:
        print("   · " + p)
    print("\n排查从 OPERATIONS.md 的《常见故障 → 解法》一节按症状对号。")
    # 第二条腿。前缀 `⚠️[体检]` 是刻意和 `⚠️[bridge]` / `⚠️[shim]` 区分开的:
    # 看见这个前缀就知道**是看门狗在说话,不是晏、也不是桥**。
    print("\n[5] Telegram 推送")
    notify_telegram(
        f"⚠️[体检] 许晏系统体检没过,{len(problems)} 项有问题:\n"
        + "\n".join("· " + p for p in problems)
        + "\n\n排查:OPERATIONS.md《常见故障 → 解法》按症状对号。"
    )
    sys.exit(1)

print("\n✅ 全部正常")

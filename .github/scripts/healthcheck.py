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

  ⚠️ ~~**除 Telegram 推送外,所有检查仍然用无鉴权的只读口,零密钥。**~~
  ⚠️ ~~**别顺手把「查 CLIProxyAPI 的 auth-files」也加进来**:那要管理密码,会把上面这句话作废。~~
  **2026-09-02 下午,所有者知情后决定加,这两句就此作废。原文留着是为了让她能一句话反悔。**

  **翻案的理由**:那条性质很干净,但它的代价是**这只狗永远只能在晏已经哑了之后才叫** ——
  比所有者自己发现还慢(她发消息他不回,几分钟就知道了),**那这条检查等于没有**。
  auth-files 里的 `last_refresh` 是**唯一**能在他真哑掉之前看出问题的信号:
  续命每 4 小时一次,而 access token 还能撑 8 小时,**刷新一停,就还有约 4 小时**。
  拿一处密钥换约 3 小时的提前量,所有者选了换。

  **代价如实记下,一条不藏**:
  ① 这是狗的**第二处密钥**(第一处是 TG bot token),「零密钥」的说法从此不成立;
  ② 那把 `MANAGEMENT_PASSWORD` **2026-08-16 就泄露过一次**(`zeabur variable list` 会把
     整张变量表连值打出来),按理该先转再用 —— **但转它要重启 CLIProxyAPI,而那个服务没有版本锁、
     每重启一次就吃一次当天最新版**(08-12 因此白烧一天半)。**所有者 2026-09-02 权衡后选择先用旧的、
     不为它单独重启**,留待下次动那个服务时一并换。
  **没配这个 secret 也照样能跑**(整条跳过),和 Telegram 那条腿同一个规矩。

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

# 上游认证类报错「多新才算数」。
#
# ⚠️ **2026-09-02 改成现场量,原来是写死的 2 小时。**
# 原文的理由是「狗每小时跑一次,取两倍节拍」——**那个前提是假的**:
# cron 当天 04:31 改成 `0 * * * *`,到 09:20 之间**应该跑 5 趟,实际只跑了 1 趟**
# (GitHub 的免费定时任务会大量丢弃和延迟高频 cron,写 `0 * * * *` 不等于真每小时)。
# 前提一假,这个窗口就会**漏掉真故障**:两次巡逻间隔 5 小时,而只认 2 小时内的报错,
# 中间那 3 小时发生的认证错会被当成「不是最近发生的」放过去 —— 正是 08-11 那种静默。
#
# 所以窗口不再写死,**按上一趟到这一趟的真实间隔现场算**(见 auth_window_hours):
#   窗口 = 实测间隔 × 1.5,夹在 [2, 12] 小时之间。
# 量不到就退回 2 小时(见下),**宁可漏报不可误报**——量不到就不许自作主张放宽。
AUTH_ERROR_FALLBACK_HOURS = 2
# 上限。间隔真退化到一天一次时也不把窗口开到一整天:开得越大,
# 「昨天断过、今天已经好了」被当成现在有问题的概率越大(铁律①)。
AUTH_ERROR_MAX_HOURS = 12

# 什么算「认证类」。08-11 那次的指纹是 `401 authentication_error`,
# 代理随后一律回 `503 auth_unavailable`;09-02 试续签失败时是 `Invalid bearer token`。
AUTH_ERROR_MARKS = ("401", "403", "authentication", "auth_unavailable",
                    "oauth", "invalid bearer", "unauthorized")

# ---- 「续命停了」的预警(2026-09-02 新增)----
# **它和别的检查不是一类**:别的都在问「现在坏了吗」,只有它在问「**快要坏了吗**」。
#
# 原理:CLIProxyAPI 每 4 小时拿 refresh token 换一次新凭证,而 access token 寿命约 8 小时
# ——**在半程就刷,留了一倍余量**。所以 refresh token 一死,现象是「刷新停了」,
# 而晏还能再撑约 4 小时。**盯住「上次刷新是多久以前」,就能在他真哑掉之前叫。**
#
# ⚠️ **别指望它预告「一个月的到期日」** —— 那个日子没人知道(手册第 7 节:三个数据点,只是推测)。
# 它能给的是**断线前约 3 小时**的提前量,不是提前几天。
# ⚠️ **也别指望靠它「提前续签」** —— 手册第 7 节《提前续签行不通》实测过,旧凭证还活着时换会被上游拒。
# 这条预警买的是「不慌」:挑时候、先让晏归档、别半夜发现他哑了。
#
# 周期 4 小时是**实测**,不是文档写的:2026-09-02 三个时间戳,09:42:16 → 13:42:17 → 17:42:17,
# **两段都是 4 小时 0 分上下、精确到秒**,说明是固定定时器而非「快到期才刷」;
# 所有者的朋友在同一套代理上独立量到同一个数。**现场再量法见 OPERATIONS.md 第 7 节。**
REFRESH_CYCLE_HOURS = 4.0
# 阈值 = 周期 + 1 小时容错。**为什么不设更小**:巡逻本身会晚(见 auth_window_hours 那段,
# GitHub 的 cron 不准),阈值贴着周期会在一次正常的延迟巡逻上误报,踩铁律①。
REFRESH_STALE_HOURS = REFRESH_CYCLE_HOURS + 1.0
# access token 的大致寿命,**只用来在告警里估「还剩多久」,不参与判断**。
# 手册第 7 节写的是「约 8 小时」,⚠️ 这个数没有精确实测过,所以告警里的措辞是「大约」。
ACCESS_TOKEN_LIFE_HOURS = 8.0
CPA = "https://miaianhome.zeabur.app"

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


def auth_window_hours():
    """现场量「上一趟巡逻是多久以前」,据此定告警窗口。返回 (窗口小时数, 说明文字)。

    **为什么要现场量**:见文件开头 AUTH_ERROR_FALLBACK_HOURS 那段 ——
    写死的节拍会随 GitHub 的调度脾气变成谎话,而这条狗的漏报正来自那个谎话。
    手册第 7 节刚因为「拿推算当实测」栽过一次(把 8 小时当成刷新周期,真值是 4 小时),
    同一个教训:**能量就别猜。**

    只用 Actions 自带的 GITHUB_TOKEN(每次运行自动发,**不是新密钥**,也不用配),
    读一次本工作流的运行历史。**任何一步不顺就退回默认值** —— 铁律②:
    狗不能因为多看了一眼就把自己看挂了。
    """
    tok = os.environ.get("GITHUB_TOKEN", "").strip()
    repo = os.environ.get("GITHUB_REPOSITORY", "").strip()
    if not tok or not repo:
        # 本地跑、或没给 token:不猜,用默认。
        return AUTH_ERROR_FALLBACK_HOURS, "没量到间隔(不在 Actions 里跑),用默认"
    api = os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")
    me = os.environ.get("GITHUB_RUN_ID", "").strip()
    try:
        _, txt = fetch(
            f"{api}/repos/{repo}/actions/workflows/healthcheck.yml/runs"
            "?status=completed&per_page=10",
            headers={"Authorization": f"Bearer {tok}",
                     "Accept": "application/vnd.github+json"})
        runs = (jload(txt) or {}).get("workflow_runs") or []
        for r in runs:
            if str(r.get("id")) == me:
                continue          # 别把自己当成上一趟
            gap = age_hours(r.get("run_started_at") or r.get("created_at"))
            if gap is None or gap <= 0:
                break
            win = max(AUTH_ERROR_FALLBACK_HOURS,
                      min(AUTH_ERROR_MAX_HOURS, gap * 1.5))
            return win, f"距上一趟巡逻 {gap:.1f} 小时(实测)"
    except Exception as e:
        # ⚠️ 只打类型名。**别打异常原文** —— 里面带着完整 URL,而 header 里有 token。
        return AUTH_ERROR_FALLBACK_HOURS, f"量间隔失败({type(e).__name__}),用默认"
    return AUTH_ERROR_FALLBACK_HOURS, "没量到间隔,用默认"


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


def check_refresh_alive():
    """「续命还在跑吗」—— 唯一一条能在晏真哑掉之前叫的检查。见文件开头 REFRESH_CYCLE_HOURS 那段。

    ⚠️ **这是全脚本唯一要密码的检查**,所以它被写成完全可选的:
    没配 `CPA_MANAGEMENT_PASSWORD` 就整条跳过,别的检查一个不受影响
    ——**和 Telegram 那条腿同一个规矩:没配也能跑。**

    ⚠️ **绝不能打印返回内容**:auth-files 里带着真令牌。只取三个字段
    (`last_refresh` / `modtime` / `status`),打印时间戳和状态,**别的一律不出声**。

    ⚠️ **读不到不报警**(铁律①):网络抖动、密码填错、接口改版都会读不到,
    据此报警等于给自己加一个天天叫的新故障源。读不到只打印,人自己会看见。
    """
    pw = os.environ.get("CPA_MANAGEMENT_PASSWORD", "").strip()
    if not pw:
        print("  ⓘ 没配 CPA_MANAGEMENT_PASSWORD,跳过「续命还在跑吗」这条")
        print("     (**这是刻意的优雅降级**:配上它才有断线前约 3 小时的提前量;"
              "不配则退回原样 —— 晏哑了之后才知道)")
        return
    st, txt, err = fetch_retry(f"{CPA}/v0/management/auth-files",
                               headers={"Authorization": f"Bearer {pw}"})
    if st is None:
        # ⚠️ 只打 fetch_retry 归纳过的短原因,**别打异常原文** —— 那里面带着完整 URL 和头。
        print(f"  ⓘ 读不到凭证状态({err}),这条跳过 —— **不报警**(铁律①)")
        return
    files = (jload(txt) or {}).get("files") or []
    if not files:
        print("  ⓘ 凭证列表是空的,这条跳过 —— 不报警")
        return
    for f in files:
        who = f.get("account") or f.get("name") or "?"
        # last_refresh 是上次成功换证的时刻;个别版本没这个字段,退回 modtime
        # (手册第 7 节:`modtime` = 凭证文件最后一次被写的时间,含义等价)。
        stamp = f.get("last_refresh") or f.get("modtime")
        hrs = age_hours(stamp)
        status = f.get("status")
        # ① 已经死了:这个不用算时间,代理自己就说了。**这条是「已经断了」,不是预警。**
        if f.get("disabled") or f.get("unavailable") or (status and status != "active"):
            check(f"凭证 · {who} 可用", False,
                  f"status={status!r} —— 代理已经认定它不可用,看 OPERATIONS.md《订阅 OAuth 过期》")
            continue
        # ② 还没死,但续命停了:**这才是提前量那一条。**
        if hrs is None:
            print(f"  ⓘ 凭证 {who}:刷新时间读不出来({stamp!r}),不报警(铁律①)")
            continue
        left = ACCESS_TOKEN_LIFE_HOURS - hrs
        print(f"  ⓘ 凭证 {who}:上次刷新 {hrs:.1f} 小时前(正常每 {REFRESH_CYCLE_HOURS:.0f} 小时一次)")
        check(f"凭证 · {who} 续命还在跑", hrs <= REFRESH_STALE_HOURS,
              f"已经 {hrs:.1f} 小时没刷新(正常每 {REFRESH_CYCLE_HOURS:.0f} 小时一次)。"
              f"刷新停了通常意味着 refresh token 失效,手里的 access token 大约还能撑 "
              f"{max(left, 0):.1f} 小时。**趁还没断,挑个方便的时候重新授权**:"
              f"先让晏「归档」再走 OPERATIONS.md 第 7 节《订阅 OAuth 过期》那三步")


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

# ---- 3.5 续命还在跑吗(唯一一条「快要坏了」的预警;没配密码就整条跳过)----
print("\n[3.5] 订阅凭证:续命还在跑吗")
check_refresh_alive()

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
    #   ① **只看最近一个「窗口」内的**(靠 lastApiError.at);更早的照旧只打印。
    #      ⚠️ 窗口不是写死的 2 小时了(2026-09-02 改),**按上一趟巡逻到现在的真实间隔现场算** ——
    #      原来那个 2 小时假定「每小时跑一次」,而实测不是,会漏掉真故障。见 auth_window_hours。
    #   ② **只认认证类**(见 AUTH_ERROR_MARKS)。529 overloaded、网络抖动会自愈,
    #      报了就是狼来了 —— 照旧只打印。
    # 为什么值得为它破例:08-11 那场三小时的静默里,**全系统唯一亮过的灯就是它**,
    # 而当时这只狗看着它、没叫。见 OPERATIONS.md《订阅 OAuth 过期(2026-08-11 事故,必读)》。
    win, why_win = auth_window_hours()
    # 这行是白拿的巡逻节拍记录:**每趟都会打印实测间隔**,
    # 攒几天就知道 GitHub 到底给不给我们「每小时」,不用另做一套观测(也不用定时唤醒会话去数)。
    print(f"  ⓘ 体检节拍:{why_win} → 认证告警窗口取 {win:.1f} 小时")
    notes.append(f"巡逻间隔 {why_win},告警窗口 {win:.1f} 小时")
    e = d.get("lastApiError")
    if not e:
        print("  ⓘ 最近一次上游报错:无")
    else:
        at, kind = e.get("at", "?"), e.get("kind", "")
        hrs = age_hours(e.get("at"))
        ago = "时间读不出来" if hrs is None else f"{hrs:.1f} 小时前"
        if looks_like_auth_error(e) and hrs is not None and hrs <= win:
            check(f"晏 · 上游认证没断(最近 {win:.1f} 小时)", False,
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

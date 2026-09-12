#!/usr/bin/env python3
"""离线验证新加的那条告警:喂假的 /debug,看它该叫时叫、不该叫时闭嘴。
不联网(urlopen 全被替换掉),不碰线上。"""
import io, json, os, runpy, sys, urllib.request
from datetime import datetime, timedelta, timezone

# ⚠️ **必须相对本文件定位,不能写死绝对路径。**
# 2026-09-02 就是这么翻的车:原来写的是开发机上的 `/home/user/Ombre-Brain/...`,
# 本地跑得好好的,一进 GitHub 的机器就 FileNotFoundError(那边的工作目录是
# `/home/runner/work/...`)。**本地能跑不等于 CI 能跑。**
SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "healthcheck.py")


def iso(hours_ago):
    return (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).isoformat().replace("+00:00", "Z")


def authfiles(hours_ago, status="active", **extra):
    """伪造一条 auth-files 记录。字段名照 2026-09-02 线上真实返回抄的(只留用到的几个)。"""
    f = {"account": "a@b.c", "last_refresh": iso(hours_ago), "modtime": iso(hours_ago),
         "status": status, "disabled": False, "unavailable": False}
    f.update(extra)
    return {"files": [f]}


def run(debug_payload, prev_run_hours=None, auth_files=None, cpa_pw=None,
        shim_auth=None, token_expires=None):
    """把所有 HTTP 请求换成假的;只有 /debug 用传进来的内容,其余一律健康。

    `prev_run_hours`:假装上一趟巡逻是几小时前(给告警窗口那段用)。
    传 None = 不在 Actions 里跑,脚本该退回默认的 2 小时。

    `shim_auth`(2026-09-12):假装 shim 的 /health 报的上游走法。
    传 None = **那个字段根本不存在**,也就是线上老代码的样子 —— 这一路必须行为照旧。
    `token_expires`:假装仓库变量 `CLAUDE_TOKEN_EXPIRES` 配的是什么。传 None = 没配。
    """
    class FakeResp:
        def __init__(self, body): self.status, self._b = 200, body.encode()
        def read(self): return self._b
        def __enter__(self): return self
        def __exit__(self, *a): return False

    if cpa_pw:
        os.environ["CPA_MANAGEMENT_PASSWORD"] = cpa_pw
    else:
        os.environ.pop("CPA_MANAGEMENT_PASSWORD", None)

    if token_expires is None:
        os.environ.pop("CLAUDE_TOKEN_EXPIRES", None)
    else:
        os.environ["CLAUDE_TOKEN_EXPIRES"] = token_expires

    if prev_run_hours is None:
        for k in ("GITHUB_TOKEN", "GITHUB_REPOSITORY", "GITHUB_RUN_ID"):
            os.environ.pop(k, None)
    else:
        os.environ["GITHUB_TOKEN"] = "fake"
        os.environ["GITHUB_REPOSITORY"] = "o/r"
        os.environ["GITHUB_RUN_ID"] = "999"

    def fake_urlopen(req, timeout=None):
        url = req.full_url
        if "/actions/workflows/" in url:
            # 第一条是本次运行(id 999),脚本必须跳过它、认第二条才算对
            return FakeResp(json.dumps({"workflow_runs": [
                {"id": 999, "run_started_at": iso(0)},
                {"id": 998, "run_started_at": iso(prev_run_hours or 0)},
            ]}))
        if "auth-files" in url:
            if auth_files == "炸":       # 模拟读不到(网络/密码错/接口改版)
                raise OSError("boom")
            return FakeResp(json.dumps(auth_files or {"files": []}))
        if url.endswith("/debug"):
            return FakeResp(json.dumps(debug_payload))
        if "/mcp" in url:
            return FakeResp("{}")
        if "yan-telegram-bridge" in url:
            return FakeResp(json.dumps({"ok": True, "polling": True}))
        if "ianmian" in url:
            return FakeResp(json.dumps({"status": "ok", "buckets": 376}))
        # 剩下的就是 shim 的 /health。⚠️ `auth` 字段**只有新代码才有**,
        # 所以 shim_auth=None 时这里刻意不放这个键,复现线上老代码的样子。
        health = {"ok": True, "model": "m"}
        if shim_auth is not None:
            health["auth"] = shim_auth
        return FakeResp(json.dumps(health))

    urllib.request.urlopen = fake_urlopen
    buf, old = io.StringIO(), sys.stdout
    sys.stdout = buf
    code = 0
    try:
        runpy.run_path(SCRIPT, run_name="__main__")
    except SystemExit as e:
        code = e.code or 0
    finally:
        sys.stdout = old
    return code, buf.getvalue()


CASES = [
    ("刚刚的 401 认证错 → 必须叫",
     {"lastApiError": {"at": iso(0.5), "kind": "401 authentication_error", "text": "OAuth access token has expired"}},
     1, "上游认证没断"),
    ("刚刚的 503 auth_unavailable → 必须叫",
     {"lastApiError": {"at": iso(1.0), "kind": "503 auth_unavailable", "text": "no auth available"}},
     1, "上游认证没断"),
    ("三天前的 401(陈年旧账)→ 不许叫",
     {"lastApiError": {"at": iso(72), "kind": "401 authentication_error", "text": "x"}},
     0, "不是最近发生的"),
    ("刚刚的 529 过载(会自愈)→ 不许叫",
     {"lastApiError": {"at": iso(0.2), "kind": "529 overloaded_error", "text": "overloaded"}},
     0, "不是认证类"),
    ("时间戳读不出来 → 不许叫(宁可漏报)",
     {"lastApiError": {"at": "看不懂", "kind": "401 authentication_error", "text": "x"}},
     0, "时间读不出来"),
    ("根本没报过错 → 不许叫",
     {"lastApiError": None}, 0, "最近一次上游报错:无"),
]

# 告警窗口按实测间隔伸缩(2026-09-02 新增)。
# **第一条就是这次改动要治的那个漏报**:巡逻间隔 5 小时、故障发生在 4 小时前,
# 旧代码的窗口写死 2 小时,会把它当成「不是最近发生的」放过去 —— 正是 08-11 那种静默。
WINDOW_CASES = [
    ("间隔 5 小时 → 窗口 7.5 小时,4 小时前的 401 必须叫(旧代码会漏)",
     {"lastApiError": {"at": iso(4), "kind": "401 authentication_error", "text": "x"}},
     5, 1, "上游认证没断"),
    ("同样 4 小时前的 401,但间隔量不到 → 退回 2 小时,不许叫(宁可漏报)",
     {"lastApiError": {"at": iso(4), "kind": "401 authentication_error", "text": "x"}},
     None, 0, "不是最近发生的"),
    ("间隔退化到 48 小时 → 窗口封顶 12 小时,20 小时前的 401 不许叫",
     {"lastApiError": {"at": iso(20), "kind": "401 authentication_error", "text": "x"}},
     48, 0, "不是最近发生的"),
    ("间隔 5 小时,但 4 小时前是 529 过载 → 照旧不许叫(窗口放宽不等于什么都叫)",
     {"lastApiError": {"at": iso(4), "kind": "529 overloaded_error", "text": "x"}},
     5, 0, "不是认证类"),
]

# 「续命还在跑吗」(2026-09-02 新增)。**这是唯一一条会在晏还活着的时候叫的检查**,
# 所以它的两个方向都要钉死:该叫的时候真叫,不该叫的时候一声都不能出。
REFRESH_CASES = [
    ("刚刷过 2 小时 → 正常,不许叫",
     authfiles(2), "pw", 0, "上次刷新 2.0 小时前"),
    ("6 小时没刷(>5 小时阈值)→ 必须叫,且要说还剩多久",
     authfiles(6), "pw", 1, "大约还能撑 2.0 小时"),
    ("4.9 小时 → 卡在阈值内侧,不许叫(别贴着周期误报)",
     authfiles(4.9), "pw", 0, "上次刷新 4.9 小时前"),
    ("代理自己说 status=error → 必须叫(这条是「已经断了」不是预警)",
     authfiles(1, status="error"), "pw", 1, "代理已经认定它不可用"),
    ("没配密码 → 整条跳过,不许叫",
     authfiles(99), None, 0, "跳过「续命还在跑吗」"),
    ("配了密码但读不到 → 只打印不许叫(铁律①)",
     "炸", "pw", 0, "读不到凭证状态"),
    ("时间戳读不出来 → 不许叫(铁律①)",
     {"files": [{"account": "a@b.c", "last_refresh": "看不懂", "status": "active"}]},
     "pw", 0, "刷新时间读不出来"),
]

# 长期令牌的到期提醒(2026-09-12 新增,配合「直连」那次改动)。
# **它和上面那组是互补的,不是重复**:上面盯「刷新停没停」(小时级),这组盯「哪天到期」(天级)。
# 长期令牌**一年之内毫无异常、到期前一秒都完全正常**,唯一能提前发出的信号就是日期。
def day(n):
    return (datetime.now(timezone.utc) + timedelta(days=n)).strftime("%Y-%m-%d")


TOKEN_CASES = [
    # (名字, shim 报的走法, 变量里写的日子, 期望退出码, 输出里必须有这句)
    ("走代理 + 没配到期日 → 静悄悄跳过(现在的线上就是这样)",
     "proxy", None, 0, "跳过「长期令牌到期」"),
    ("/health 没有 auth 字段(老代码)+ 没配 → 也跳过,行为照旧",
     None, None, 0, "跳过「长期令牌到期」"),
    ("**已经直连却没配到期日 → 必须叫**(保护根本没装上)",
     "direct", None, 1, "没有任何人盯着"),
    ("到期日写成一句话 → 必须叫(日期写错不能静默)",
     "direct", "下个月吧", 1, "没在工作"),
    ("到期日写成 09/12/2027 这种格式 → 也必须叫",
     "direct", "09/12/2027", 1, "没在工作"),
    ("还有 200 天 → 一声不出",
     "direct", day(200), 0, "长期令牌 · 到期还早"),
    ("还有 20 天 → 叫,且说明是 30 天档",
     "direct", day(20), 1, "这是 30 天档的提醒"),
    ("还有 5 天 → 叫,且必须是 **7 天档**(不是 30 天档)",
     "direct", day(5), 1, "这是 7 天档的提醒"),
    ("还有 2 天 → 叫,且必须是 **3 天档**",
     "direct", day(2), 1, "这是 3 天档的提醒"),
    ("已经过期 → 叫,并给出退回代理的应急路",
     "direct", day(-3), 1, "应急退路"),
    ("告警里必须写清怎么换(收到的人可能是半年后的她或一个全新会话)",
     "direct", day(5), 1, "setup-token"),
    ("告警里必须提醒「换完把新到期日填回来」(最容易漏的一步)",
     "direct", day(5), 1, "把新的到期日填回"),
    ("走代理时也照样盯日期 —— 两条互不打架",
     "proxy", day(5), 1, "这是 7 天档的提醒"),
]

# ⚠️ **这一条是这次改动的重点之一**:直连之后代理不在链路上,它的凭证从此不再刷新,
# 「刷新停了」那条会**永远成立** → 不跳过就变成每小时一条假警报。
# 假警报比没警报更糟:收几次之后人就不看了,真出事那条也一起被忽略。
SKIP_REFRESH_CASES = [
    ("直连 + 配了密码 + 凭证 99 小时没刷 → 这条必须整条跳过,一声不出",
     "direct", authfiles(99), "pw", 0, "这条整条跳过"),
    ("还走代理时 + 同样 99 小时没刷 → 照旧必须叫(别把这条一起跳没了)",
     "proxy", authfiles(99), "pw", 1, "没刷新"),
    ("/health 读不到 auth(老代码)+ 99 小时没刷 → 也照旧必须叫",
     None, authfiles(99), "pw", 1, "没刷新"),
]

fail = 0
for name, sauth, texp, want_code, want_text in TOKEN_CASES:
    code, out = run({"lastApiError": None}, shim_auth=sauth, token_expires=texp)
    ok = (code == want_code) and (want_text in out)
    print(("  ✅ " if ok else "  ❌ ") + name + (f"   [退出码 {code},期望 {want_code}]" if not ok else ""))
    if not ok:
        fail += 1
        print("     ---- 实际输出 ----")
        print("     " + "\n     ".join(out.strip().splitlines()[-14:]))

for name, sauth, af, pw, want_code, want_text in SKIP_REFRESH_CASES:
    # 到期日配一个很远的日子,免得「令牌到期」那条插进来干扰这组的退出码
    code, out = run({"lastApiError": None}, shim_auth=sauth, auth_files=af, cpa_pw=pw,
                    token_expires=day(300))
    ok = (code == want_code) and (want_text in out)
    print(("  ✅ " if ok else "  ❌ ") + name + (f"   [退出码 {code},期望 {want_code}]" if not ok else ""))
    if not ok:
        fail += 1
        print("     ---- 实际输出 ----")
        print("     " + "\n     ".join(out.strip().splitlines()[-14:]))

for name, af, pw, want_code, want_text in REFRESH_CASES:
    code, out = run({"lastApiError": None}, auth_files=af, cpa_pw=pw)
    ok = (code == want_code) and (want_text in out)
    print(("  ✅ " if ok else "  ❌ ") + name + (f"   [退出码 {code},期望 {want_code}]" if not ok else ""))
    if not ok:
        fail += 1
        print("     ---- 实际输出 ----")
        print("     " + "\n     ".join(out.strip().splitlines()[-14:]))

# 返回内容里带真令牌,**任何情况下都不许把它打出来**。这条是防泄露的硬闸。
code, out = run({"lastApiError": None},
                auth_files={"files": [{"account": "a@b.c", "last_refresh": iso(9),
                                       "status": "active",
                                       "refresh_token": "SUPERSECRET-REFRESH-TOKEN"}]},
                cpa_pw="PW-MUST-NOT-LEAK")
ok = "SUPERSECRET" not in out and "PW-MUST-NOT-LEAK" not in out
print(("  ✅ " if ok else "  ❌ ") + "令牌和密码一个字都没打进日志")
fail += 0 if ok else 1

for name, payload, prev, want_code, want_text in WINDOW_CASES:
    code, out = run(payload, prev_run_hours=prev)
    ok = (code == want_code) and (want_text in out)
    print(("  ✅ " if ok else "  ❌ ") + name + (f"   [退出码 {code},期望 {want_code}]" if not ok else ""))
    if not ok:
        fail += 1
        print("     ---- 实际输出 ----")
        print("     " + "\n     ".join(out.strip().splitlines()[-14:]))

for name, payload, want_code, want_text in CASES:
    code, out = run(payload)
    ok = (code == want_code) and (want_text in out)
    print(("  ✅ " if ok else "  ❌ ") + name + (f"   [退出码 {code},期望 {want_code}]" if not ok else ""))
    if not ok:
        fail += 1
        print("     ---- 实际输出 ----")
        print("     " + "\n     ".join(out.strip().splitlines()[-14:]))

# 演习开关:勾了必须变红(否则「验证告警能不能到手」这件事本身就是假的);
# 不勾则必须一点影响都没有(否则定时那趟会天天演习)。
os.environ["HEALTHCHECK_TEST_ALARM"] = "true"
code, out = run({"lastApiError": None})
ok = code == 1 and "【演习】" in out
print(("  ✅ " if ok else "  ❌ ") + "演习开关打开时:全绿也照样报警")
fail += 0 if ok else 1

os.environ["HEALTHCHECK_TEST_ALARM"] = "false"
code, out = run({"lastApiError": None})
ok = code == 0 and "【演习】" not in out
print(("  ✅ " if ok else "  ❌ ") + "演习开关关着时:一点影响都没有")
fail += 0 if ok else 1
os.environ.pop("HEALTHCHECK_TEST_ALARM", None)

# 顺带确认:失败时会走 Telegram 那一步,且没配 secret 时是优雅跳过、不炸
code, out = run({"lastApiError": {"at": iso(0.1), "kind": "401 authentication_error", "text": "x"}})
ok = "[5] Telegram 推送" in out and "跳过 Telegram 推送" in out
print(("  ✅ " if ok else "  ❌ ") + "没配 secret 时优雅跳过 Telegram,不影响结论")
fail += 0 if ok else 1

print(f"\n{'全部通过' if not fail else str(fail) + ' 项没过'}")
sys.exit(1 if fail else 0)

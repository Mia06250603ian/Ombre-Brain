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


def run(debug_payload, prev_run_hours=None):
    """把所有 HTTP 请求换成假的;只有 /debug 用传进来的内容,其余一律健康。

    `prev_run_hours`:假装上一趟巡逻是几小时前(给告警窗口那段用)。
    传 None = 不在 Actions 里跑,脚本该退回默认的 2 小时。
    """
    class FakeResp:
        def __init__(self, body): self.status, self._b = 200, body.encode()
        def read(self): return self._b
        def __enter__(self): return self
        def __exit__(self, *a): return False

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
        if url.endswith("/debug"):
            return FakeResp(json.dumps(debug_payload))
        if "/mcp" in url:
            return FakeResp("{}")
        if "yan-telegram-bridge" in url:
            return FakeResp(json.dumps({"ok": True, "polling": True}))
        if "ianmian" in url:
            return FakeResp(json.dumps({"status": "ok", "buckets": 376}))
        return FakeResp(json.dumps({"ok": True, "model": "m"}))

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

fail = 0
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

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

怎么报警:这个脚本以非 0 退出 = GitHub Actions 那次运行变红 = GitHub 给仓库主人发邮件。
  **刻意不走 Telegram**:出事的时候往往正是 Telegram 那条路不通(今天就是),
  而且往 Actions 里放 bot token 等于多一处密钥。所有检查都用**无鉴权的只读口**,零密钥。

放在 .github/scripts/ 而不是仓库根:根目录的 *.py 在 OB 的监控路径里(`/*.py`),
  放根目录会让每次改这个脚本都触发记忆库重建。
"""
import json
import sys
import time
import urllib.request
import urllib.error

TIMEOUT = 20
RETRIES = 3          # 瞬时抖动不许惊动她 —— 今天那场故障本身就是「抖一下」,别让狗被同一件事骗到
BACKOFF = 5

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
    e = d.get("lastApiError")
    print(f"  ⓘ 最近一次上游报错:{(e or {}).get('at', '无')} {(e or {}).get('kind', '')}")
    print(f"  ⓘ 晏的窗口占用:{d.get('contextTokens')} ({d.get('contextPct')}%)")
    g = d.get("ctxGuard") or {}
    print(f"  ⓘ 上下文守卫:on={g.get('on')} trusted={g.get('trusted')} 压缩过 {g.get('compactions')} 次")

print("\n" + "=" * 60)
for n in notes:
    print("  · " + n)
print("=" * 60)

if problems:
    print(f"\n❌ 体检不通过,{len(problems)} 项有问题:")
    for p in problems:
        print("   · " + p)
    print("\n排查从 OPERATIONS.md 的《常见故障 → 解法》一节按症状对号。")
    sys.exit(1)

print("\n✅ 全部正常")

# ============================================================
# fishing-mcp 部署前测试:起真服务,走真 MCP streamable-http 协议
# 跑法: python test_server.py   (全部 ✅ 才可部署)
# 不碰外网;在临时目录跑,不污染本目录存档。
# ============================================================

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 18432
BASE = f"http://127.0.0.1:{PORT}"

passed = 0


def ok(name, cond, detail=""):
    global passed
    if not cond:
        print(f"❌ {name} {detail}")
        sys.exit(1)
    passed += 1
    print(f"✅ {name}")


def http(path, data=None, headers=None, method=None):
    req = urllib.request.Request(
        BASE + path,
        data=data.encode("utf-8") if isinstance(data, str) else data,
        headers=headers or {},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, dict(r.headers), r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode("utf-8")


def sse_json(body):
    """streamable-http 响应可能是 SSE(data: 行)或纯 JSON,都解出 JSON。"""
    for line in body.splitlines():
        if line.startswith("data:"):
            return json.loads(line[5:].strip())
    return json.loads(body)


MCP_HDR = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
}


def mcp_call(payload, session=None):
    h = dict(MCP_HDR)
    if session:
        h["mcp-session-id"] = session
    return http("/mcp", json.dumps(payload), h)


def start_server(env_extra, cwd):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "ANTHROPIC"))}
    env.update({"PORT": str(PORT), "PYTHONUNBUFFERED": "1", **env_extra})
    p = subprocess.Popen(
        [sys.executable, os.path.join(HERE, "server.py")],
        env=env, cwd=cwd,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    for _ in range(50):
        time.sleep(0.2)
        try:
            s, _, b = http("/health")
            if s == 200:
                return p
        except Exception:
            pass
    p.kill()
    print(p.stdout.read().decode())
    print("❌ 服务没起来")
    sys.exit(1)


def mcp_session():
    """initialize + notifications/initialized,返回 session id。"""
    s, h, b = mcp_call({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                   "clientInfo": {"name": "test", "version": "0"}},
    })
    ok("initialize 200", s == 200, f"got {s}: {b[:200]}")
    sid = h.get("mcp-session-id") or h.get("Mcp-Session-Id")
    ok("有 session id", bool(sid))
    r = sse_json(b)
    ok("initialize 返回 serverInfo", r["result"]["serverInfo"]["name"] == "fishing", str(r)[:200])
    s, _, _ = mcp_call({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
    ok("initialized 通知", s in (200, 202), f"got {s}")
    return sid


def tool_call(sid, rid, name, args):
    s, _, b = mcp_call({"jsonrpc": "2.0", "id": rid, "method": "tools/call",
                        "params": {"name": name, "arguments": args}}, sid)
    ok(f"tools/call {name} 200", s == 200, f"got {s}: {b[:200]}")
    r = sse_json(b)
    ok(f"{name} 无协议错误", "result" in r, str(r)[:300])
    ok(f"{name} 非 isError", not r["result"].get("isError"), str(r)[:300])
    return r["result"]["content"][0]["text"]


def turn_of(text):
    m = re.search(r"📊 (\{.*\})", text)
    ok("返回带 📊 状态栏", m is not None, text[-200:])
    return json.loads(m.group(1))["turn"]


with tempfile.TemporaryDirectory() as tmp:
    save_path = os.path.join(tmp, "fishing_save.json")
    envx = {"FISHING_DATA_DIR": tmp, "FISHING_KEY": "testkey"}

    p = start_server(envx, tmp)
    try:
        # --- health ---
        s, _, b = http("/health")
        ok("/health 200", s == 200)
        ok("/health 初始无存档", json.loads(b)["save_exists"] is False, b)

        # --- MCP 握手 ---
        sid = mcp_session()

        # --- tools/list ---
        s, _, b = mcp_call({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, sid)
        tools = {t["name"] for t in sse_json(b)["result"]["tools"]}
        ok("tools/list 有 play + new_game", tools == {"play", "new_game"}, str(tools))

        # --- 玩起来 ---
        out = tool_call(sid, 3, "play", {"command": "status"})
        t0 = turn_of(out)
        out = tool_call(sid, 4, "play", {"command": "cast 3"})
        t1 = turn_of(out)
        ok("cast 3 推进回合", t1 > t0, f"{t0} -> {t1}")
        ok("存档已落盘", os.path.exists(save_path))

        # --- /save 备份(在 t1 时间点拍快照) ---
        s, _, _ = http("/save")
        ok("/save 无 key 401", s == 401)
        s, _, backup = http("/save?key=testkey")
        ok("/save GET 200", s == 200)
        json.loads(backup)
        ok("备份是合法 JSON", True)
        s, _, _ = http("/save?key=testkey", data="not json", method="POST")
        ok("/save POST 坏档 400", s == 400)

        # --- 批量指令 ---
        out = tool_call(sid, 5, "play", {"command": "buy basic_worm 2; cast 2"})
        t2 = turn_of(out)
        ok("batch 指令推进回合", t2 > t1, f"{t1} -> {t2}")
    finally:
        p.kill()
        p.wait()

    # --- 重启后进度还在(FISHING_DATA_DIR 持久化) ---
    p = start_server(envx, tmp)
    try:
        sid = mcp_session()
        out = tool_call(sid, 6, "play", {"command": "status"})
        ok("重启后回合数保留", turn_of(out) == t2, out[-200:])

        # --- /save POST 恢复(灌回 t1 时间点的备份,回合应回退到 t1) ---
        s, _, _ = http("/save?key=testkey", data=backup, method="POST")
        ok("/save POST 200", s == 200)
        out = tool_call(sid, 7, "play", {"command": "status"})
        ok("恢复备份后回合回退到 t1", turn_of(out) == t1, out[-200:])
    finally:
        p.kill()
        p.wait()

print(f"\n🎉 全部 {passed} 项通过")

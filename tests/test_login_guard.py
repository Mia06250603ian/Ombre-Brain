# ============================================================
# Test: 记忆库后台登录防猜密码(2026-10-28,login_guard.py)
#   1. 同一个 IP 错 5 次锁 15 分钟,别的 IP 不受连累,登对一次清零
#   2. 换着 IP 猜,一小时错 50 次全部锁
#   3. IP 取 X-Forwarded-For 最右边(Caddy 写的),访客自带的不信
#   4. 真接口:错 5 次后第 6 次回 429,锁着时密码对了也进不去
# ============================================================
import os
import sys
import tempfile

import pytest

from login_guard import LoginGuard, client_ip

M = 60


def test_ip_lock_and_unlock():
    g = LoginGuard()
    for i in range(4):
        g.fail("1.1.1.1", i * M)
    assert g.check("1.1.1.1", 4 * M)[0]
    g.fail("1.1.1.1", 4 * M)
    ok, wait, scope = g.check("1.1.1.1", 5 * M)
    assert not ok and scope == "ip" and wait == 14 * M
    assert g.check("2.2.2.2", 5 * M)[0]
    assert g.check("1.1.1.1", 19 * M + 1)[0]


def test_success_clears_and_old_fails_expire():
    g = LoginGuard()
    for _ in range(4):
        g.fail("3.3.3.3", 0)
    g.ok("3.3.3.3")
    g.fail("3.3.3.3", 0)
    assert g.check("3.3.3.3", 0)[0]
    g2 = LoginGuard()
    for _ in range(4):
        g2.fail("4.4.4.4", 0)
    g2.fail("4.4.4.4", 16 * M)
    assert g2.check("4.4.4.4", 16 * M)[0]


def test_global_lock():
    g = LoginGuard()
    for i in range(50):
        g.fail(f"10.0.0.{i}", i)
    ok, _, scope = g.check("9.9.9.9", 50)
    assert not ok and scope == "all"


def test_client_ip():
    assert client_ip({"x-forwarded-for": "6.6.6.6, 5.5.5.5"}, "172.18.0.2") == "5.5.5.5"
    assert client_ip({}, "172.18.0.2") == "172.18.0.2"


def test_login_endpoint_locks():
    pytest.importorskip("starlette.testclient")
    from starlette.testclient import TestClient
    bd = tempfile.mkdtemp()
    for sub in ("permanent", "dynamic", "archive", "feel"):
        os.makedirs(os.path.join(bd, sub), exist_ok=True)
    os.environ["OMBRE_BUCKETS_DIR"] = bd
    os.environ["OMBRE_DASHBOARD_PASSWORD"] = "dashboard-test-pw"
    os.environ.setdefault("OMBRE_SEAL_WORD", "test-seal")
    os.environ["OMBRE_HOOK_SKIP"] = "1"
    sys.modules.pop("server", None)
    import server  # noqa: WPS433
    server._login_guard = LoginGuard()
    c = TestClient(server.mcp.streamable_http_app())
    h = {"x-forwarded-for": "7.7.7.7"}
    codes = [c.post("/auth/login", json={"password": "nope"}, headers=h).status_code for _ in range(6)]
    assert codes == [401] * 5 + [429]
    r = c.post("/auth/login", json={"password": "dashboard-test-pw"}, headers=h)
    assert r.status_code == 429 and "分钟后再试" in r.json()["error"]
    assert c.post("/auth/login", json={"password": "dashboard-test-pw"}, headers={"x-forwarded-for": "8.8.8.8"}).status_code == 200

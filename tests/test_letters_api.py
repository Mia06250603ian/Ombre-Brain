# ============================================================
# Test: 信箱的改 / 删接口(2026-08-24)
#
# 存取层的行为在 test_letters_edit.py 里测;这份只盯 **HTTP 这一层**:
#   1. 没登录一律 401(改删不能是裸奔的口子)
#   2. 改信:200、正文变了、**写信时间不变**、留 edited 戳
#   3. 拿过期的原文再改 → 409(time + 原文双条件匹配,防止改错那一封)
#   4. 空正文 → 400(要清空得走删除)
#   5. 删信 = **软删**:读不到了,但文件里那行还在
#   6. GET /api/letters 仍然能用
# ============================================================

import os
import sys
import tempfile

import pytest

pytest.importorskip("starlette.testclient")
from starlette.testclient import TestClient  # noqa: E402


@pytest.fixture(scope="module")
def client_and_server():
    bd = tempfile.mkdtemp()
    for sub in ("permanent", "dynamic", "archive", "feel"):
        os.makedirs(os.path.join(bd, sub), exist_ok=True)
    os.environ["OMBRE_BUCKETS_DIR"] = bd
    os.environ["OMBRE_DASHBOARD_PASSWORD"] = "dashboard-test-pw"
    os.environ.setdefault("OMBRE_SEAL_WORD", "test-seal")
    os.environ["OMBRE_HOOK_SKIP"] = "1"

    sys.modules.pop("server", None)
    import server  # noqa: WPS433

    client = TestClient(server.mcp.streamable_http_app())
    resp = client.post("/auth/login", json={"password": "dashboard-test-pw"})
    assert resp.status_code == 200
    return client, server


@pytest.fixture
def letter(client_and_server):
    """每个用例一封新信,返回 (time, text)。

    ⚠️ 正文必须**每个用例都不一样**:`time` 只精确到秒,同一秒里建的几封信时间戳相同,
    正文再一样的话连测试自己都分不清是哪一封(第一版就是这么互相干扰的)。
    真实使用里不会撞 —— 信是归档时一封一封写的。
    """
    import uuid
    _, server = client_and_server
    text = "测试信-" + uuid.uuid4().hex[:8]
    server._save_letter(text)
    entry = [e for e in server._read_letters_raw() if e.get("text") == text][-1]
    return entry["time"], text


class TestAuth:
    def test_update_requires_login(self, client_and_server, letter):
        client, server = client_and_server
        t, x = letter
        client.cookies.clear()
        try:
            resp = client.post("/api/letters/update",
                               json={"time": t, "text": x, "new_text": "偷改"})
            assert resp.status_code == 401
            assert any(e.get("text") == x for e in server._read_letters_raw()), "被拒之后不该动过信"
        finally:
            client.post("/auth/login", json={"password": "dashboard-test-pw"})

    def test_delete_requires_login(self, client_and_server, letter):
        client, _ = client_and_server
        t, x = letter
        client.cookies.clear()
        try:
            resp = client.post("/api/letters/delete", json={"time": t, "text": x})
            assert resp.status_code == 401
        finally:
            client.post("/auth/login", json={"password": "dashboard-test-pw"})


class TestUpdate:
    def test_edits_text_and_keeps_written_time(self, client_and_server, letter):
        client, server = client_and_server
        t, x = letter
        newtext = x + "-改好了"
        resp = client.post("/api/letters/update",
                           json={"time": t, "text": x, "new_text": newtext})
        assert resp.status_code == 200, resp.text

        hit = [e for e in server._read_letters_raw() if e["text"] == newtext][-1]
        assert hit["time"] == t, "改正文不该动写信时间(那是他什么时候写的)"
        assert hit.get("edited"), "改过要留 edited 时间戳"
        assert not hit.get("deleted")

    def test_stale_original_text_is_rejected(self, client_and_server, letter):
        """页面上那份过期了就该 409,而不是猜着改 —— 这是防改错那一封的锁。"""
        client, server = client_and_server
        t, x = letter
        first = x + "-改过"
        assert client.post("/api/letters/update",
                           json={"time": t, "text": x, "new_text": first}).status_code == 200
        resp = client.post("/api/letters/update",
                           json={"time": t, "text": x, "new_text": "拿旧原文再改"})
        assert resp.status_code == 409
        assert not any(e.get("text") == "拿旧原文再改" for e in server._read_letters_raw())

    def test_empty_new_text_rejected(self, client_and_server, letter):
        client, _ = client_and_server
        t, x = letter
        resp = client.post("/api/letters/update",
                           json={"time": t, "text": x, "new_text": "   "})
        assert resp.status_code == 400

    def test_missing_time_rejected(self, client_and_server, letter):
        client, _ = client_and_server
        _, x = letter
        resp = client.post("/api/letters/update",
                           json={"time": "", "text": x, "new_text": "无 time"})
        assert resp.status_code == 400


class TestDelete:
    def test_soft_delete_hides_but_keeps_the_line(self, client_and_server, letter):
        client, server = client_and_server
        t, x = letter
        before = len(server._read_letters_raw())

        resp = client.post("/api/letters/delete", json={"time": t, "text": x})
        assert resp.status_code == 200, resp.text

        assert not any(g["text"] == x for g in server._load_letters(50)), "删掉的不该再被读到"
        raw = server._read_letters_raw()
        assert len(raw) == before, "软删不该真的把行删掉"
        hit = [e for e in raw if e["text"] == x][-1]
        assert hit.get("deleted") is True and hit.get("deleted_at")

    def test_deleting_twice_is_rejected(self, client_and_server, letter):
        client, _ = client_and_server
        t, x = letter
        assert client.post("/api/letters/delete", json={"time": t, "text": x}).status_code == 200
        resp = client.post("/api/letters/delete", json={"time": t, "text": x})
        assert resp.status_code == 409, "已经删过的不该能再删一次"


class TestListStillWorks:
    def test_get_letters_reflects_edit(self, client_and_server, letter):
        client, _ = client_and_server
        t, x = letter
        edited = x + "-列表要看到这句"
        assert client.post("/api/letters/update",
                           json={"time": t, "text": x, "new_text": edited}).status_code == 200
        resp = client.get("/api/letters")
        assert resp.status_code == 200
        texts = [i["text"] for i in resp.json()["letters"]]
        assert edited in texts
        assert x not in texts

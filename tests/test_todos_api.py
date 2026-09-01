# ============================================================
# Test: 便利贴的后台接口 /api/todos(2026-09-01 新增)
#
# 这块便利贴是**晏的**(存储与写法全部复用他那套 _load/_save_todos_list)。
# 后台入口是所有者 2026-09-01 要的:「便利贴是他的,只给他用,但是我想能看到,
# 修改权可以有,但是我不一定用」。
#
# 所以这个文件钉三件事:
#   1. 读:她看得见,且不改任何东西
#   2. 写:她贴的条子必须标成她的(by=owner → 晏那边显示「(她留的)」)
#   3. 边界:空/超长/不存在的编号/未登录,一个都不许放过去
# ============================================================

import os
import sys
import tempfile

import pytest

pytest.importorskip("starlette.testclient")
from starlette.testclient import TestClient  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture()
def client_and_server():
    """起一个跑在临时目录上的 server,登录好。每个用例一份干净的便利贴。"""
    bd = tempfile.mkdtemp()
    for sub in ("permanent", "dynamic", "archive", "feel"):
        os.makedirs(os.path.join(bd, sub), exist_ok=True)
    os.environ["OMBRE_BUCKETS_DIR"] = bd
    os.environ["OMBRE_DASHBOARD_PASSWORD"] = "dashboard-test-pw"
    os.environ.setdefault("OMBRE_SEAL_WORD", "test-seal")
    os.environ["OMBRE_HOOK_SKIP"] = "1"

    sys.modules.pop("server", None)
    import server  # noqa: WPS433 — 晚导入,让上面的环境变量生效

    client = TestClient(server.mcp.streamable_http_app())
    assert client.post("/auth/login", json={"password": "dashboard-test-pw"}).status_code == 200
    return client, server


def items_of(resp):
    return resp.json()["items"]


class Test读:
    def test_空便利贴也能正常读(self, client_and_server):
        client, _ = client_and_server
        resp = client.get("/api/todos")
        assert resp.status_code == 200
        assert resp.json() == {"items": [], "open": 0, "done": 0}

    def test_读得到晏自己记的条目(self, client_and_server):
        client, server = client_and_server
        import anyio
        anyio.run(lambda: server._todos_impl(add="给她带一杯"))
        data = client.get("/api/todos").json()
        assert [it["text"] for it in data["items"]] == ["给她带一杯"]
        assert data["open"] == 1 and data["done"] == 0
        # 晏自己记的没有 by 字段 —— 这是「他写的」的判据,别加上去
        assert "by" not in data["items"][0]

    def test_读不改任何东西(self, client_and_server):
        client, server = client_and_server
        import anyio
        anyio.run(lambda: server._todos_impl(add="别动我"))
        before = open(server._todos_path(), "rb").read()
        client.get("/api/todos")
        client.get("/api/todos")
        assert open(server._todos_path(), "rb").read() == before

    def test_未登录读不到(self, client_and_server):
        _, server = client_and_server
        anon = TestClient(server.mcp.streamable_http_app())
        assert anon.get("/api/todos").status_code == 401


class Test她贴的条子:
    def test_贴一张会标成她的(self, client_and_server):
        client, _ = client_and_server
        resp = client.post("/api/todos/add", json={"text": "记得吃药"})
        assert resp.status_code == 200
        hit = items_of(resp)[-1]
        assert hit["text"] == "记得吃药"
        assert hit["by"] == "owner"       # ← 这条是这一整个功能的重点
        assert hit["done"] is False
        assert hit["id"] and len(hit["id"]) == 4

    def test_晏那边会看到是她留的(self, client_and_server):
        client, server = client_and_server
        import anyio
        anyio.run(lambda: server._todos_impl(add="他自己记的"))
        client.post("/api/todos/add", json={"text": "她留的"})

        out = anyio.run(lambda: server._todos_impl())
        assert "她留的  (她留的)" in out
        assert "他自己记的  (她留的)" not in out   # 他自己的不许被标

        # 开机那份(只列没做的)同样要标
        boot = anyio.run(lambda: server._todos_impl(only_open=True))
        assert "(她留的)" in boot

    def test_旧条目没有by字段也不会被标(self, client_and_server):
        client, server = client_and_server
        # 手写一条 08-14 那个版本格式的旧数据(没有 by,也没有 created)
        server._save_todos_list([{"id": "ab12", "text": "老条目", "done": False}])
        import anyio
        out = anyio.run(lambda: server._todos_impl())
        assert "老条目" in out and "(她留的)" not in out
        assert client.get("/api/todos").json()["open"] == 1

    def test_首尾空白会去掉(self, client_and_server):
        client, _ = client_and_server
        resp = client.post("/api/todos/add", json={"text": "  两边有空格  "})
        assert items_of(resp)[-1]["text"] == "两边有空格"

    def test_空内容不许贴(self, client_and_server):
        client, _ = client_and_server
        for bad in ("", "   ", "\n"):
            assert client.post("/api/todos/add", json={"text": bad}).status_code == 400
        assert client.get("/api/todos").json()["items"] == []

    def test_太长不许贴(self, client_and_server):
        client, _ = client_and_server
        assert client.post("/api/todos/add", json={"text": "字" * 501}).status_code == 400
        assert client.post("/api/todos/add", json={"text": "字" * 500}).status_code == 200

    def test_未登录贴不上(self, client_and_server):
        _, server = client_and_server
        anon = TestClient(server.mcp.streamable_http_app())
        assert anon.post("/api/todos/add", json={"text": "偷贴"}).status_code == 401
        assert server._load_todos_list() == []


class Test勾掉和撕掉:
    def test_勾掉再改回来(self, client_and_server):
        client, _ = client_and_server
        tid = items_of(client.post("/api/todos/add", json={"text": "待办"}))[-1]["id"]

        resp = client.post("/api/todos/toggle", json={"id": tid, "done": True})
        assert resp.status_code == 200
        assert items_of(resp)[0]["done"] is True
        assert client.get("/api/todos").json() == {
            "items": items_of(resp), "open": 0, "done": 1,
        }

        resp = client.post("/api/todos/toggle", json={"id": tid, "done": False})
        assert items_of(resp)[0]["done"] is False

    def test_勾掉的是晏自己记的也可以(self, client_and_server):
        client, server = client_and_server
        import anyio
        anyio.run(lambda: server._todos_impl(add="他记的"))
        tid = client.get("/api/todos").json()["items"][0]["id"]
        assert client.post("/api/todos/toggle", json={"id": tid, "done": True}).status_code == 200

    def test_编号带井号也认(self, client_and_server):
        client, _ = client_and_server
        tid = items_of(client.post("/api/todos/add", json={"text": "x"}))[-1]["id"]
        assert client.post("/api/todos/toggle", json={"id": "#" + tid.upper(), "done": True}).status_code == 200

    def test_撕掉就真没了(self, client_and_server):
        client, _ = client_and_server
        tid = items_of(client.post("/api/todos/add", json={"text": "撕我"}))[-1]["id"]
        resp = client.post("/api/todos/delete", json={"id": tid})
        assert resp.status_code == 200
        assert items_of(resp) == []
        assert client.get("/api/todos").json()["items"] == []

    def test_撕掉一张不影响别的(self, client_and_server):
        client, _ = client_and_server
        first = items_of(client.post("/api/todos/add", json={"text": "留着"}))[-1]["id"]
        second = items_of(client.post("/api/todos/add", json={"text": "撕掉"}))[-1]["id"]
        client.post("/api/todos/delete", json={"id": second})
        remain = client.get("/api/todos").json()["items"]
        assert [it["id"] for it in remain] == [first]

    def test_编号不存在回404(self, client_and_server):
        client, _ = client_and_server
        assert client.post("/api/todos/toggle", json={"id": "ffff", "done": True}).status_code == 404
        assert client.post("/api/todos/delete", json={"id": "ffff"}).status_code == 404

    def test_没给编号回400(self, client_and_server):
        client, _ = client_and_server
        assert client.post("/api/todos/toggle", json={"done": True}).status_code == 400
        assert client.post("/api/todos/delete", json={}).status_code == 400

    def test_请求体不是json回400(self, client_and_server):
        client, _ = client_and_server
        for path in ("/api/todos/add", "/api/todos/toggle", "/api/todos/delete"):
            resp = client.post(path, content=b"not json", headers={"Content-Type": "application/json"})
            assert resp.status_code == 400, path

    def test_未登录改不了删不了(self, client_and_server):
        client, server = client_and_server
        tid = items_of(client.post("/api/todos/add", json={"text": "锁着"}))[-1]["id"]
        anon = TestClient(server.mcp.streamable_http_app())
        assert anon.post("/api/todos/toggle", json={"id": tid, "done": True}).status_code == 401
        assert anon.post("/api/todos/delete", json={"id": tid}).status_code == 401
        assert server._load_todos_list()[0]["done"] is False


class Test和晏共用同一块便利贴:
    def test_她贴的他看得见_他记的她看得见(self, client_and_server):
        client, server = client_and_server
        import anyio
        anyio.run(lambda: server._todos_impl(add="他记的"))
        client.post("/api/todos/add", json={"text": "她贴的"})

        # 他那边(MCP 工具)
        out = anyio.run(lambda: server._todos_impl())
        assert "他记的" in out and "她贴的" in out
        # 她那边(面板)
        texts = [it["text"] for it in client.get("/api/todos").json()["items"]]
        assert texts == ["他记的", "她贴的"]

    def test_他勾掉之后她那边也是勾掉的(self, client_and_server):
        client, server = client_and_server
        import anyio
        anyio.run(lambda: server._todos_impl(add="共用一块"))
        tid = client.get("/api/todos").json()["items"][0]["id"]
        anyio.run(lambda: server._todos_impl(done=tid))
        data = client.get("/api/todos").json()
        assert data["items"][0]["done"] is True
        assert data["done"] == 1

    def test_晏写便利贴时也会拿锁(self, client_and_server):
        """⚠️ 锁只有一边拿等于没锁。

        自从面板也能写,这个文件就有两个写入方(晏走 MCP、她走 /api/todos/*),
        两边都是「读整本 → 改 → 整本重写」—— 先写的那次会被后写的整个顶掉且不报错。
        所以晏那条路径也必须拿同一把锁。
        """
        client, server = client_and_server
        import anyio
        from contextlib import contextmanager

        taken = []

        @contextmanager
        def counting_lock():
            taken.append(1)
            yield

        real = server._todos_lock
        server._todos_lock = counting_lock
        try:
            anyio.run(lambda: server._todos_impl(add="他记的"))
            assert len(taken) == 1, "晏加一条待办时没拿锁"
            tid = server._load_todos_list()[0]["id"]
            for call in (lambda: server._todos_impl(done=tid),
                         lambda: server._todos_impl(undone=tid),
                         lambda: server._todos_impl(clear_done=True),
                         lambda: server._todos_impl(remove=tid)):
                before = len(taken)
                anyio.run(call)
                assert len(taken) == before + 1, "有一条写路径没拿锁"
            # 只读的两条路径不该拿锁(和以前一样)
            before = len(taken)
            anyio.run(lambda: server._todos_impl())
            anyio.run(lambda: server._todos_impl(only_open=True))
            assert len(taken) == before, "只读也拿锁了,白挡住写"
        finally:
            server._todos_lock = real

    def test_写入口用的是他那套原子写(self, client_and_server):
        """别在面板这边另造一份写法:两套写法迟早会写坏同一个文件。"""
        client, server = client_and_server
        client.post("/api/todos/add", json={"text": "落盘检查"})
        # 直接拿他的读取函数读文件,读得出来才算真落在同一个地方
        assert [it["text"] for it in server._load_todos_list()] == ["落盘检查"]
        assert not os.path.exists(server._todos_path() + ".tmp")   # 临时文件收拾干净了

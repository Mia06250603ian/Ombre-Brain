# ============================================================
# 否认降权 + 到期记忆(2026-08-19)
#
# 这些用例守的是**写之前读代码才发现的三个坑**,别删:
#   ① trace 里有一句「Auto-undormant on any access」——任何访问都解除休眠。
#      不排除的话,deny 同一次调用先设 dormant=True 再被改回 False,功能静默失效。
#   ② update() 无条件刷新 last_active,而时间分按它算(越近分越高)。
#      否认时若顺手刷新,等于一边降权一边加权,自己打自己。
#   ③ 否认必须可撤销。没有撤销就是一扇单向门,否认错了只能手工改 .md。
# ============================================================
import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def mgr():
    from bucket_manager import BucketManager
    with tempfile.TemporaryDirectory() as d:
        yield BucketManager({"buckets_dir": d})


def _meta(m, bid):
    return m._load_bucket(m._find_bucket_file(bid))["metadata"]


class TestDeny:
    @pytest.mark.asyncio
    async def test_first_deny_downweights_but_stays_searchable(self, mgr):
        bid = await mgr.create(content="她喝三分糖", name="奶茶", tags=["奶茶"],
                               importance=8, domain=["日常"])
        ctrl = await mgr.create(content="她喝三分糖(对照)", name="对照", tags=["奶茶"],
                                importance=8, domain=["日常"])
        await mgr.update(bid, denied=1, importance=1, touch=False)
        res = {b["id"]: b.get("score") for b in await mgr.search("奶茶", limit=10)}
        assert bid in res, "被否认的记忆仍要能被关键词搜到(和 resolved 同款,数据不藏)"
        assert res[bid] < res[ctrl], "被否认的必须排在对照组后面"

    @pytest.mark.asyncio
    async def test_deny_does_not_refresh_last_active(self, mgr):
        """坑②:否认不是「这条记忆活跃了」。刷新 last_active 会抬高时间分,抵消降权。"""
        bid = await mgr.create(content="x", name="x", tags=["x"], importance=8, domain=["日常"])
        before = _meta(mgr, bid)["last_active"]
        await mgr.update(bid, denied=1, importance=1, touch=False)
        assert _meta(mgr, bid)["last_active"] == before

    @pytest.mark.asyncio
    async def test_normal_update_still_touches(self, mgr):
        """反向守护:普通更新照旧刷新 last_active,别把原行为改坏。"""
        bid = await mgr.create(content="x", name="x", tags=["x"], importance=5, domain=["日常"])
        before = _meta(mgr, bid)["last_active"]
        import asyncio
        await asyncio.sleep(1.05)
        await mgr.update(bid, importance=6)
        assert _meta(mgr, bid)["last_active"] != before

    @pytest.mark.asyncio
    async def test_denied_penalty_is_capped(self, mgr):
        """否认次数再多,惩罚封顶两次 —— 防止分数下溢成 0 反而绕过阈值判断。"""
        bid = await mgr.create(content="y", name="y", tags=["y"], importance=8, domain=["日常"])
        await mgr.update(bid, denied=99, importance=1, touch=False)
        res = {b["id"]: b.get("score") for b in await mgr.search("y", limit=10)}
        assert bid in res and res[bid] >= 0


class TestExpire:
    def test_expiry_boundaries(self):
        """当天仍有效;没设不算过期;**格式坏掉一律当没过期**(宁可多留,不可误藏)。"""
        import server
        assert server._is_expired({"expires_at": "2026-08-18"}, today="2026-08-19")
        assert not server._is_expired({"expires_at": "2026-08-19"}, today="2026-08-19")
        assert not server._is_expired({"expires_at": "2026-12-31"}, today="2026-08-19")
        assert not server._is_expired({}, today="2026-08-19")
        assert not server._is_expired({"expires_at": ""}, today="2026-08-19")
        assert not server._is_expired({"expires_at": "乱写"}, today="2026-08-19")
        assert not server._is_expired({"expires_at": None}, today="2026-08-19")

    @pytest.mark.asyncio
    async def test_expires_at_roundtrip(self, mgr):
        bid = await mgr.create(content="z", name="z", tags=["z"], importance=5, domain=["日常"])
        await mgr.update(bid, expires_at="2026-09-01")
        assert _meta(mgr, bid)["expires_at"] == "2026-09-01"
        await mgr.update(bid, expires_at="")
        assert "expires_at" not in _meta(mgr, bid)


class TestDenyGuards:
    """守卫:批量 deny 必须**显式拒绝**,不能静默不做。
    静默的话调用方会以为「已经否认了」,而那条记错的记忆照旧浮现 —— 比不做还糟。
    (2026-08-19 自测发现的真洞,原样上线就是这个后果。)"""

    @pytest.mark.asyncio
    async def test_batch_deny_is_rejected_loudly(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OMBRE_BUCKETS_DIR", str(tmp_path))
        import importlib
        import server as srv
        importlib.reload(srv)
        mgr = srv.bucket_mgr
        tr = srv.trace.fn if hasattr(srv.trace, "fn") else srv.trace
        a = await mgr.create(content="A", name="A", tags=["x"], importance=8, domain=["d"])
        b = await mgr.create(content="B", name="B", tags=["x"], importance=8, domain=["d"])

        out = await tr(bucket_id=f"{a},{b}", deny=True)
        assert "只支持单条" in out, "批量 deny 必须报错,不能静默"
        meta = mgr._load_bucket(mgr._find_bucket_file(a))["metadata"]
        assert not meta.get("denied"), "被拒绝时不许留下半截状态"

        # 反向:批量的普通修改不能被误伤
        out2 = await tr(bucket_id=f"{a},{b}", importance=5)
        assert "成功 2" in out2

    @pytest.mark.asyncio
    async def test_deny_and_undeny_together_rejected(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OMBRE_BUCKETS_DIR", str(tmp_path))
        import importlib
        import server as srv
        importlib.reload(srv)
        tr = srv.trace.fn if hasattr(srv.trace, "fn") else srv.trace
        bid = await srv.bucket_mgr.create(content="x", name="x", tags=["x"],
                                          importance=5, domain=["d"])
        out = await tr(bucket_id=bid, deny=True, undeny=True)
        assert "不能同时" in out

    @pytest.mark.asyncio
    async def test_batch_expires_at_is_rejected_loudly(self, tmp_path, monkeypatch):
        """2026-08-19(晚):与批量 deny 同一个坑 —— 批量分支不认 expires_at,
        原样上线会回「成功 2 个:没有任何字段需要修改」而一个桶都没写上,
        调用方以为到期日设好了,那几条临时记忆照旧天天浮现。必须显式拒绝。"""
        monkeypatch.setenv("OMBRE_BUCKETS_DIR", str(tmp_path))
        import importlib
        import server as srv
        importlib.reload(srv)
        mgr = srv.bucket_mgr
        tr = srv.trace.fn if hasattr(srv.trace, "fn") else srv.trace
        a = await mgr.create(content="A", name="A", tags=["x"], importance=8, domain=["d"])
        b = await mgr.create(content="B", name="B", tags=["x"], importance=8, domain=["d"])

        out = await tr(bucket_id=f"{a},{b}", expires_at="2026-09-01")
        assert "只支持单条" in out, "批量 expires_at 必须报错,不能静默"
        for bid in (a, b):
            meta = mgr._load_bucket(mgr._find_bucket_file(bid))["metadata"]
            assert not meta.get("expires_at"), "被拒绝之后不许有任何桶被写上到期日"

        # 反向守护:单条照旧能设,别把正常路径改坏
        ok = await tr(bucket_id=a, expires_at="2026-09-01")
        assert "2026-09-01" in ok
        meta = mgr._load_bucket(mgr._find_bucket_file(a))["metadata"]
        assert meta.get("expires_at") == "2026-09-01"

        # 反向守护:批量普通改动不受影响
        out2 = await tr(bucket_id=f"{a},{b}", importance=3)
        assert "批量操作 2 个桶" in out2
        for bid in (a, b):
            meta = mgr._load_bucket(mgr._find_bucket_file(bid))["metadata"]
            assert int(meta.get("importance")) == 3

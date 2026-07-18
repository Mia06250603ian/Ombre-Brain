# ============================================================
# Test: Write-ahead snapshot + history restore + seal watchword
# 测试：写前快照 + 历史恢复 + 防伪暗语
#
# Covers the 2026-07 safety batch:
#   1. Content overwrite / delete → snapshot lands in .history/ first
#   2. Metadata-only updates do NOT snapshot (no history flooding)
#   3. list_history / restore_from_history (overwrite-recovery + undelete)
#   4. Snapshot pruning respects keep limit
#   5. .history is invisible to bucket scanning
#   6. _with_seal appends the watchword (or loud placeholder when unset)
# ============================================================

import os
import pytest
import pytest_asyncio

from bucket_manager import BucketManager


@pytest_asyncio.fixture
async def bm(test_config, tmp_path):
    bd = str(tmp_path / "buckets")
    for d in ["permanent", "dynamic", "archive", "feel"]:
        os.makedirs(os.path.join(bd, d), exist_ok=True)
    return BucketManager(test_config | {"buckets_dir": bd})


async def _make_bucket(bm, content="原始内容:这句话不能丢"):
    return await bm.create(
        content=content, tags=["测试"], importance=5, domain=["日常"],
        valence=0.5, arousal=0.3, name="快照测试桶", bucket_type="dynamic",
    )


class TestSnapshot:
    @pytest.mark.asyncio
    async def test_content_update_snapshots_first(self, bm):
        """整桶替换前,旧内容必须已经躺在 .history 里。"""
        bid = await _make_bucket(bm)
        assert bm.list_history(bid) == []

        ok = await bm.update(bid, content="新内容:一次手滑的覆盖")
        assert ok

        snaps = bm.list_history(bid)
        assert len(snaps) == 1
        assert snaps[0]["op"] == "update"
        old = bm.read_history_version(bid, snaps[0]["version"])
        assert old is not None
        assert "原始内容:这句话不能丢" in old["content"]

    @pytest.mark.asyncio
    async def test_delete_snapshots_first(self, bm):
        """删除前留快照,桶没了但快照还在。"""
        bid = await _make_bucket(bm)
        assert await bm.delete(bid)
        assert await bm.get(bid) is None

        snaps = bm.list_history(bid)
        assert len(snaps) == 1
        assert snaps[0]["op"] == "delete"

    @pytest.mark.asyncio
    async def test_metadata_only_update_no_snapshot(self, bm):
        """纯元数据修改(importance/resolved等)高频且不丢数据,不产生快照。"""
        bid = await _make_bucket(bm)
        await bm.update(bid, importance=8)
        await bm.update(bid, resolved=True)
        await bm.update(bid, tags=["a", "b"])
        assert bm.list_history(bid) == []

    @pytest.mark.asyncio
    async def test_snapshot_prune_respects_keep_limit(self, bm):
        """快照数量超过上限时删最旧,不无限占盘。"""
        bm.history_keep = 3
        bid = await _make_bucket(bm)
        for i in range(6):
            await bm.update(bid, content=f"第{i}版")
        assert len(bm.list_history(bid)) <= 3

    @pytest.mark.asyncio
    async def test_history_dir_invisible_to_scanning(self, bm):
        """.history 里的 .md 不会被当成记忆桶捞出来。"""
        bid = await _make_bucket(bm)
        await bm.update(bid, content="第二版")
        all_ids = [b["id"] for b in await bm.list_all(include_archive=True)]
        assert all_ids.count(bid) == 1  # 只有本体,快照没混进来
        stats = await bm.get_stats()
        assert stats["dynamic_count"] == 1


class TestRestore:
    @pytest.mark.asyncio
    async def test_restore_overwritten_content(self, bm):
        """误覆盖后按版本恢复,原文回来,恢复前的状态也留了底。"""
        bid = await _make_bucket(bm)
        await bm.update(bid, content="覆盖后的错误内容")
        version = bm.list_history(bid)[0]["version"]

        snap = await bm.restore_from_history(bid, version)
        assert snap is not None
        cur = await bm.get(bid)
        assert "原始内容:这句话不能丢" in cur["content"]
        # 恢复动作自身也快照了"覆盖后的错误内容",还能再反悔
        ops = [s["op"] for s in bm.list_history(bid)]
        assert "restore" in ops

    @pytest.mark.asyncio
    async def test_restore_undeletes_bucket(self, bm):
        """被删的桶按快照复活,内容和元数据都在,且能再次被找到。"""
        bid = await _make_bucket(bm)
        await bm.delete(bid)
        assert await bm.get(bid) is None

        version = bm.list_history(bid)[0]["version"]
        snap = await bm.restore_from_history(bid, version)
        assert snap is not None
        revived = await bm.get(bid)
        assert revived is not None
        assert "原始内容:这句话不能丢" in revived["content"]
        assert revived["metadata"].get("name") == "快照测试桶"

    @pytest.mark.asyncio
    async def test_restore_unknown_version_returns_none(self, bm):
        bid = await _make_bucket(bm)
        assert await bm.restore_from_history(bid, "20000101-000000_update") is None

    @pytest.mark.asyncio
    async def test_restore_version_path_traversal_blocked(self, bm):
        """version 参数里塞路径也翻不出 .history 目录。"""
        bid = await _make_bucket(bm)
        await bm.update(bid, content="v2")
        assert await bm.restore_from_history(bid, "../../dynamic/evil") is None


class TestSeal:
    def test_seal_appended_when_configured(self, monkeypatch):
        monkeypatch.setenv("OMBRE_SEAL_WORD", "山有木兮")
        import importlib, server
        importlib.reload(server)
        out = server._with_seal("记忆内容")
        assert out.endswith("[seal:山有木兮]")
        assert out.startswith("记忆内容")

    def test_seal_loud_placeholder_when_missing(self, monkeypatch):
        monkeypatch.delenv("OMBRE_SEAL_WORD", raising=False)
        import importlib, server
        importlib.reload(server)
        out = server._with_seal("记忆内容")
        assert "seal" in out and "未配置" in out  # 明显异常,绝不静默留空

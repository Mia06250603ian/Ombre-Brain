"""
回收站(`list_trash` / `existing_bucket_ids`)的存取层测试。

跑法:python3 -m pytest tests/test_trash.py -q
用的是真的 `BucketManager`,但库建在临时目录里 —— **碰不到任何真记忆**。
"""
import asyncio
import os
import shutil
import tempfile

import pytest

from bucket_manager import BucketManager


def _mgr(tmp):
    return BucketManager({
        "buckets_dir": tmp,
        "history": {"keep_per_bucket": 20},
    })


@pytest.fixture()
def mgr():
    tmp = tempfile.mkdtemp(prefix="ob-trash-test-")
    try:
        yield _mgr(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


async def _make(mgr, name, **kw):
    """建一个桶,返回 id。"""
    return await mgr.create(content=f"{name} 的正文,写长一点好看预览截断效果。" * 3,
                            name=name, **kw)


def test_空库回收站是空的(mgr):
    assert mgr.list_trash() == []


def test_删过的桶才进回收站_活着的不进(mgr):
    keep = run(_make(mgr, "留着的"))
    gone = run(_make(mgr, "要删的"))

    # 改一下「留着的」——编辑同样会留快照,回收站不能因此把它算进去
    run(mgr.update(keep, content="改过的正文"))
    assert mgr.list_trash() == [], "活着的桶有快照,但不该出现在回收站"

    run(mgr.delete(gone))
    trash = mgr.list_trash()
    assert [t["id"] for t in trash] == [gone]
    assert trash[0]["name"] == "要删的"
    assert trash[0]["last_op"] == "delete"
    assert trash[0]["snapshots"] >= 1
    assert trash[0]["version"], "必须给出恢复要用的版本号"
    assert len(trash[0]["content_preview"]) <= 120


def test_回收站里能按快照复活_且复活后就不在回收站里了(mgr):
    bid = run(_make(mgr, "误删的", importance=7))
    run(mgr.delete(bid))

    entry = mgr.list_trash()[0]
    snap = run(mgr.restore_from_history(bid, entry["version"]))
    assert snap is not None

    back = run(mgr.get(bid))
    assert back is not None, "复活之后桶要真的回来"
    assert back["metadata"]["name"] == "误删的"
    assert back["metadata"]["importance"] == 7
    assert mgr.list_trash() == [], "复活之后就不该再挂在回收站里"


def test_名字里带下划线也认得出_id(mgr):
    """
    `_find_bucket_file` 是按「最后一段」认 id 的,`existing_bucket_ids` 必须照同一条规矩来,
    否则名字带下划线的活桶会被当成已删、错进回收站。
    """
    bid = run(_make(mgr, "a_b_c 带下划线的名字"))
    assert bid in mgr.existing_bucket_ids()
    run(mgr.update(bid, content="改一下留个快照"))
    assert mgr.list_trash() == []


def test_新删的排在前面(mgr):
    import time
    a = run(_make(mgr, "先删的"))
    run(mgr.delete(a))
    time.sleep(1.05)          # 快照文件名精确到秒
    b = run(_make(mgr, "后删的"))
    run(mgr.delete(b))
    assert [t["name"] for t in mgr.list_trash()] == ["后删的", "先删的"]


def test_feel_桶删了也能进回收站(mgr):
    """feel 桶不许归档(规格),但删是允许的 —— 删了同样要能捞回来。"""
    bid = run(_make(mgr, "他的自省", bucket_type="feel"))
    run(mgr.delete(bid))
    trash = mgr.list_trash()
    assert [t["id"] for t in trash] == [bid]
    assert trash[0]["type"] == "feel"
    run(mgr.restore_from_history(bid, trash[0]["version"]))
    assert run(mgr.get(bid)) is not None


def test_id_里塞路径进不去(mgr):
    """
    接口那层会先 `os.path.basename` 掐掉路径成分。这里验存取层本身:
    传一个带路径的 id,不能真去读别的目录。
    """
    bid = run(_make(mgr, "正常的"))
    run(mgr.delete(bid))
    v = mgr.list_trash()[0]["version"]
    assert run(mgr.restore_from_history("../" + bid, v)) is None, "带路径的 id 不该命中任何快照"
    assert run(mgr.restore_from_history(bid, "../../etc/passwd")) is None, "带路径的版本号同理"
    # 正常的那条照样能恢复
    assert run(mgr.restore_from_history(bid, v)) is not None

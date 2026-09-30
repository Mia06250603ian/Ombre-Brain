# ============================================================
# Test: breath 向量通道的放行线(2026-09-30,OMBRE_VECTOR_MIN_SIM,默认 0.70)
#
# 真实库实测:0.5 时任何查询都有 430+ 个桶过线,库里真没有的事也拿满 5 条「语义关联」。
# 这里盯两件:① 0.65 这种「看着沾边」的不许进;② 0.75 这种真相关的照样进;
# ③ 两条都不够格时,breath 要能说出「未找到相关记忆」。
# ============================================================

import os
import sys
import tempfile
from unittest.mock import AsyncMock

import pytest


@pytest.fixture(scope="module")
def server_mod():
    bd = tempfile.mkdtemp()
    for sub in ("permanent", "dynamic", "archive", "feel"):
        os.makedirs(os.path.join(bd, sub), exist_ok=True)
    os.environ["OMBRE_BUCKETS_DIR"] = bd
    os.environ.setdefault("OMBRE_SEAL_WORD", "test-seal")
    os.environ["OMBRE_HOOK_SKIP"] = "1"
    os.environ.pop("OMBRE_VECTOR_MIN_SIM", None)
    sys.modules.pop("server", None)
    import server  # noqa: WPS433
    return server


@pytest.mark.asyncio
async def test_default_threshold_is_070(server_mod):
    assert server_mod.VECTOR_MIN_SIM == pytest.approx(0.70)


@pytest.mark.asyncio
async def test_vector_channel_uses_threshold(server_mod, monkeypatch):
    s = server_mod
    near = await s.bucket_mgr.create(content="她分享了一张截图。", tags=["截图"], importance=5,
                                     domain=["日常"], valence=0.5, arousal=0.3, name="截图那天")
    real = await s.bucket_mgr.create(content="她鼻炎犯了,换了一种药。", tags=["鼻炎"], importance=5,
                                     domain=["健康"], valence=0.5, arousal=0.3, name="鼻炎换药")
    monkeypatch.setattr(s.embedding_engine, "search_similar", AsyncMock(return_value=[(real, 0.75), (near, 0.65)]))
    monkeypatch.setattr(s.dehydrator, "dehydrate", AsyncMock(side_effect=lambda c, m=None: c))
    monkeypatch.setattr(s.random, "random", lambda: 0.99)   # 关掉「忽然想起来」的随机浮现,只看向量通道
    out = await s._breath_impl(query="过敏一直打喷嚏")
    assert real in out, out
    assert near not in out, "0.65 不该以「语义关联」递进去"

    monkeypatch.setattr(s.embedding_engine, "search_similar", AsyncMock(return_value=[(near, 0.66), (real, 0.60)]))
    out = await s._breath_impl(query="她养的狗")
    assert "未找到相关记忆" in out, out

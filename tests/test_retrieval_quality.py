# ============================================================
# 检索质量回归集(2026-09-30 新增,借鉴 Latent-memory 的 src/regression_set.py)
#
# **这个文件不是在证明检索好,是让检索质量的变化看得见。**
# 其余测试都是「这一条该命中」的点断言:改了评分,单条可能全绿,整体已经变差。
# 这里是一把尺子:四类考题分开算分,和下面的 BASELINE 比,**掉了就红**。
#   掉了 → 要么改回去,要么在 BASELINE 旁写清「为什么这次变差是可接受的代价」再改数。
#   涨了 → 也会提示你把 BASELINE 调上来(不改不红,但尺子就松了)。
#
# 量什么:
#   literal / paraphrase:Recall@5(前五条里有没有该命中的)、MRR(排第几)
#   absent_*:正确空手率(库里真没有时,搜索是不是真的空手回来)
#
# 用的是**线上那份配置**:Dockerfile 把 config.example.yaml 拷成 config.yaml,
# 所以这里读它的 scoring_weights / matching。⚠️ 面板「配置」页能热改这些值
# (POST /api/config),线上若被改过,这里量的就不是线上 —— 以容器里的 config.yaml 为准。
#
# 两部分:
#   ① 关键词那一路(bucket_manager.search):纯本地,CI 里跑。
#   ② 向量那一路(breath 里 sim>0.5 就补进来的「语义关联」):要真 embedding,
#      只在设了 OMBRE_API_KEY 时跑,**只报数不判红**(还没有基线),默认不进 CI
#      (每跑一次约 65 次 embedding 调用,花的是线上那把 key 的额度)。
#      手动跑:OMBRE_API_KEY=… python -m pytest tests/test_retrieval_quality.py -s --asyncio-mode=auto
# ============================================================

import os
from datetime import datetime, timedelta
from pathlib import Path

import pytest
import pytest_asyncio
import yaml

from tests.retrieval_corpus import CORPUS, QUERIES

ROOT = Path(__file__).resolve().parent.parent
TOP_K = 5   # breath 默认 max_results=5

# 2026-09-30 首次实测(关键词一路、线上配置)。是**现状**,不是目标。
BASELINE = {
    "literal":       {"recall@5": 1.00, "mrr": 0.96},
    "paraphrase":    {"recall@5": 0.50, "mrr": 0.45},
    "absent_远主题": {"empty_rate": 1.00},
    "absent_日常":   {"empty_rate": 0.88},   # 8 题错 1:「爸爸的生日」撞上「生日」标签
}
TOLERANCE = 0.001


def _prod_config(buckets_dir: str, with_embedding: bool = False) -> dict:
    with open(ROOT / "config.example.yaml", encoding="utf-8") as f:
        prod = yaml.safe_load(f)
    for sub in ("permanent", "dynamic", "archive", "feel"):
        os.makedirs(os.path.join(buckets_dir, sub), exist_ok=True)
    cfg = {
        "buckets_dir": buckets_dir,
        "merge_threshold": prod.get("merge_threshold", 75),
        "matching": prod["matching"],
        "scoring_weights": prod["scoring_weights"],
        "wikilink": {"enabled": False},
        "embedding": {"enabled": False},
    }
    if with_embedding:
        key = os.environ.get("OMBRE_API_KEY", "")
        base = os.environ.get("OMBRE_BASE_URL", "")
        cfg["dehydration"] = {"api_key": key, "base_url": base}
        cfg["embedding"] = {**prod.get("embedding", {}), "enabled": True}
    return cfg


async def _build(cfg: dict, embedding_engine=None):
    import frontmatter as fm
    from bucket_manager import BucketManager

    bm = BucketManager(cfg, embedding_engine=embedding_engine)
    now = datetime.now()
    key_to_id = {}
    for item in CORPUS:
        bid = await bm.create(
            content=item["content"], tags=item["tags"], importance=item["importance"],
            domain=item["domain"], valence=0.5, arousal=0.3, name=item["name"],
        )
        path = bm._find_bucket_file(bid)
        post = fm.load(path)
        ts = (now - timedelta(days=item["days"])).isoformat()
        post["created"] = ts
        post["last_active"] = ts
        with open(path, "w", encoding="utf-8") as f:
            f.write(fm.dumps(post))
        key_to_id[item["key"]] = bid
        if embedding_engine is not None:
            await embedding_engine.generate_and_store(bid, item["content"])
    return bm, key_to_id


def _score(results_by_query: dict) -> dict:
    """results_by_query: {(类别, 查询): [命中的 key, 按名次]} → 各类指标。"""
    per_cat: dict = {}
    for cat, query, expected in QUERIES:
        got = results_by_query[(cat, query)]
        row = per_cat.setdefault(cat, {"n": 0, "hit": 0, "rr": 0.0, "empty": 0, "misses": []})
        row["n"] += 1
        if expected:
            ranks = [i for i, k in enumerate(got[:TOP_K]) if k in expected]
            if ranks:
                row["hit"] += 1
                row["rr"] += 1.0 / (ranks[0] + 1)
            else:
                row["misses"].append(query)
        else:
            if not got:
                row["empty"] += 1
            else:
                row["misses"].append(f"{query}→{got[:3]}")
    out = {}
    for cat, r in per_cat.items():
        if cat.startswith("absent"):
            out[cat] = {"empty_rate": round(r["empty"] / r["n"], 2), "misses": r["misses"]}
        else:
            out[cat] = {"recall@5": round(r["hit"] / r["n"], 2),
                        "mrr": round(r["rr"] / r["n"], 2), "misses": r["misses"]}
    return out


def _report(title: str, metrics: dict) -> str:
    lines = [f"\n=== {title} ==="]
    for cat, m in metrics.items():
        nums = ", ".join(f"{k}={v}" for k, v in m.items() if k != "misses")
        lines.append(f"  {cat:14s} {nums}")
        for miss in m["misses"]:
            lines.append(f"      ✗ {miss}")
    return "\n".join(lines)


@pytest_asyncio.fixture
async def keyword_env(tmp_path):
    return await _build(_prod_config(str(tmp_path / "buckets")))


@pytest.mark.asyncio
async def test_keyword_channel_against_baseline(keyword_env):
    bm, key_to_id = keyword_env
    id_to_key = {v: k for k, v in key_to_id.items()}
    results = {}
    for cat, query, _ in QUERIES:
        # breath 取 max_results*4+10 条再截断;这里照取,算指标时只看前 TOP_K
        hits = await bm.search(query, limit=TOP_K * 4 + 10)
        results[(cat, query)] = [id_to_key[b["id"]] for b in hits]
    metrics = _score(results)
    print(_report("关键词一路(线上配置)", metrics))

    dropped, raised = [], []
    for cat, base in BASELINE.items():
        for name, want in base.items():
            got = metrics[cat][name]
            if got < want - TOLERANCE:
                dropped.append(f"{cat}.{name}: {want} → {got}")
            elif got > want + TOLERANCE:
                raised.append(f"{cat}.{name}: {want} → {got}")
    if raised:
        print("⬆ 比基线好了,记得把 BASELINE 调上来:", raised)
    assert not dropped, (
        "检索质量比基线差了(见上面报告)。改回去,或者在 BASELINE 旁写清为什么可以接受再改数:\n"
        + "\n".join(dropped)
    )


def test_corpus_and_queries_are_consistent():
    """考题引用的 key 都得在语料里;absent 考题的关键词不许偷偷出现在语料里。"""
    keys = {c["key"] for c in CORPUS}
    assert len(keys) == len(CORPUS), "语料 key 重复"
    for cat, query, expected in QUERIES:
        assert set(expected) <= keys, f"{query} 引用了不存在的 key"
        assert bool(expected) != cat.startswith("absent"), f"{query} 的类别和期望不一致"


@pytest.mark.skipif(not os.environ.get("OMBRE_API_KEY"),
                    reason="OMBRE_API_KEY not set — 向量一路只在手动跑时量")
@pytest.mark.asyncio
async def test_vector_channel_report(tmp_path):
    """照 breath 的规则:关键词没搜到、但向量相似度 > 0.5 的桶,会以「语义关联」补进结果。
    只报数不判红 —— 它决定了「库里没有时,晏会不会拿到一堆看着相关的东西」。"""
    from embedding_engine import EmbeddingEngine

    cfg = _prod_config(str(tmp_path / "buckets"), with_embedding=True)
    ee = EmbeddingEngine(cfg)
    assert ee.enabled, "embedding 没启用(key 或配置不对)"
    bm, key_to_id = await _build(cfg, embedding_engine=ee)
    id_to_key = {v: k for k, v in key_to_id.items()}

    results, top_sims = {}, {}
    for cat, query, _ in QUERIES:
        kw = await bm.search(query, limit=TOP_K * 4 + 10)
        got = [id_to_key[b["id"]] for b in kw]
        sims = await ee.search_similar(query, top_k=TOP_K * 4 + 10)
        top_sims[query] = round(sims[0][1], 3) if sims else None
        for bid, sim in sims:
            k = id_to_key.get(bid)
            if k and k not in got and sim > 0.5:   # 与 server.py 向量通道同一条线
                got.append(k)
        results[(cat, query)] = got
    metrics = _score(results)
    print(_report("关键词 + 向量(breath 实际拿到的)", metrics))
    print("  每题最高余弦:", top_sims)

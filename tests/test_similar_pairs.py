# ============================================================
# tests/test_similar_pairs.py
#
# 钉住 2026-09-01 那次提速：/api/network 的两两相似度从「纯 Python 逐对循环」
# 换成「一次读库 + numpy 矩阵运算」。快了不算数，**结果必须和老办法逐个对上**，
# 这个文件就是干这个的。
#
# 老办法 = EmbeddingEngine._cosine_similarity 双重循环（本文件里的 reference_pairs），
# 那段代码本身没删，仍在 embedding_engine.py 里，随时可比。
# ============================================================

import json
import math
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from embedding_engine import EmbeddingEngine


def make_engine(tmp_path, vectors=None, model="test-model"):
    """造一个只用得上「读向量 + 算相似度」那半边的引擎（不联网、不发请求）。"""
    engine = EmbeddingEngine.__new__(EmbeddingEngine)
    engine.model = model
    engine.enabled = True
    engine.db_path = str(tmp_path / "embeddings.db")
    conn = sqlite3.connect(engine.db_path)
    conn.execute(
        "CREATE TABLE embeddings (bucket_id TEXT, model TEXT, embedding TEXT)"
    )
    for bucket_id, vector in (vectors or {}).items():
        conn.execute(
            "INSERT INTO embeddings VALUES (?, ?, ?)",
            (bucket_id, model, json.dumps(vector)),
        )
    conn.commit()
    conn.close()
    return engine


def reference_pairs(embeddings, min_sim=0.5):
    """老办法：逐对调 _cosine_similarity。这是「正确答案」的定义。"""
    ids = list(embeddings.keys())
    out = []
    for index, id_a in enumerate(ids):
        for id_b in ids[index + 1:]:
            sim = EmbeddingEngine._cosine_similarity(embeddings[id_a], embeddings[id_b])
            if sim > min_sim:
                out.append((id_a, id_b, round(sim, 3)))
    return out


def as_set(pairs):
    """比对时忽略顺序，也忽略哪一端在前。"""
    return {(min(a, b), max(a, b), round(sim, 2)) for a, b, sim in pairs}


def random_vectors(count, dim, seed=0):
    import random
    rng = random.Random(seed)
    return {
        f"bucket{index:03d}": [rng.uniform(-1, 1) for _ in range(dim)]
        for index in range(count)
    }


def test_快办法和老办法答案一致(tmp_path):
    vectors = random_vectors(40, 64, seed=7)
    engine = make_engine(tmp_path, vectors)
    fast = engine.similar_pairs(vectors, min_sim=0.1)
    slow = reference_pairs(vectors, min_sim=0.1)
    assert as_set(fast) == as_set(slow)
    assert len(fast) > 0, "阈值定得太高，这条测试就白跑了"


def test_跨越分块边界仍然一致(tmp_path):
    # 分块大小是 256，故意造出比它多的桶，确保跨块的那些对没被漏掉
    vectors = random_vectors(300, 16, seed=11)
    engine = make_engine(tmp_path, vectors)
    fast = engine.similar_pairs(vectors, min_sim=0.5)
    slow = reference_pairs(vectors, min_sim=0.5)
    assert as_set(fast) == as_set(slow)


def test_numpy_不在时退回纯Python也一致(tmp_path, monkeypatch):
    vectors = random_vectors(30, 32, seed=3)
    engine = make_engine(tmp_path, vectors)
    expected = as_set(reference_pairs(vectors, min_sim=0.2))

    real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__

    def no_numpy(name, *args, **kwargs):
        if name == "numpy":
            raise ImportError("numpy disabled for this test")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", no_numpy)
    fallback = engine.similar_pairs(vectors, min_sim=0.2)
    assert as_set(fallback) == expected


def test_每个桶的边数封顶(tmp_path):
    vectors = random_vectors(60, 8, seed=5)   # 低维 = 大家都挺像，边会很多
    engine = make_engine(tmp_path, vectors)
    uncapped = engine.similar_pairs(vectors, min_sim=0.3)
    capped = engine.similar_pairs(vectors, min_sim=0.3, top_k=3)
    assert len(capped) < len(uncapped), "这批数据没多到会被封顶，测试没测到东西"

    # 封顶后的边必须是原来那些边的子集（不许凭空造边）
    assert as_set(capped) <= as_set(uncapped)

    # 每条边至少在它某一端的「最像的 3 条」里 —— 反过来说：
    # 任何一个桶被保留的边，都不会超过 3 条来自它自己的排名
    from collections import defaultdict
    ranked = defaultdict(list)
    for pair in uncapped:
        ranked[pair[0]].append(pair)
        ranked[pair[1]].append(pair)
    allowed = set()
    for edges in ranked.values():
        edges.sort(key=lambda item: item[2], reverse=True)
        for edge in edges[:3]:
            allowed.add((edge[0], edge[1]))
    for a, b, _ in capped:
        assert (a, b) in allowed


def test_封顶时快办法和退路结果一致(tmp_path, monkeypatch):
    """⚠️ 2026-09-01 自审抓到的偏差,这条钉住它。

    封顶的语义是「一条边只要在**任意一端**的前 top_k 里就留下」。
    numpy 那条路最初只收上三角,等于只认下标小的那一端 ——
    「只有 j 觉得 i 像」的边被整个丢掉,而纯 Python 退路(先全算完再封顶)不会。
    两条路径必须给同一个答案。
    """
    vectors = random_vectors(80, 8, seed=17)     # 低维 = 大家都挺像,封顶才真的削到东西
    engine = make_engine(tmp_path, vectors)
    fast = engine.similar_pairs(vectors, min_sim=0.3, top_k=3)

    real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__

    def no_numpy(name, *args, **kwargs):
        if name == "numpy":
            raise ImportError("numpy disabled for this test")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", no_numpy)
    slow = engine.similar_pairs(vectors, min_sim=0.3, top_k=3)

    assert as_set(fast) == as_set(slow)
    assert len(fast) < len(engine.similar_pairs(vectors, min_sim=0.3)), "这批数据没被封顶,测试没测到东西"


def test_桶不足两个时不连边(tmp_path):
    engine = make_engine(tmp_path, {})
    assert engine.similar_pairs({}) == []
    assert engine.similar_pairs({"only": [1.0, 2.0]}) == []


def test_零向量不参与也不炸(tmp_path):
    vectors = {"a": [0.0, 0.0, 0.0], "b": [1.0, 1.0, 1.0], "c": [1.0, 1.0, 0.9]}
    engine = make_engine(tmp_path, vectors)
    pairs = engine.similar_pairs(vectors, min_sim=0.5)
    assert all("a" not in (id_a, id_b) for id_a, id_b, _ in pairs)
    assert as_set(pairs) == as_set(reference_pairs(vectors, min_sim=0.5))


def test_维度不一致的少数派被排除(tmp_path):
    # 换过 embedding 模型时库里会同时躺着两种维度的向量。
    # 老办法遇到这种是 _cosine_similarity 返回 0.0（不连边），这里同样要排除掉。
    vectors = {
        "a": [1.0, 1.0, 1.0, 1.0],
        "b": [1.0, 1.0, 1.0, 0.9],
        "c": [1.0, 1.0, 1.0, 0.8],
        "odd": [1.0, 1.0],
    }
    engine = make_engine(tmp_path, vectors)
    pairs = engine.similar_pairs(vectors, min_sim=0.5)
    assert all("odd" not in (id_a, id_b) for id_a, id_b, _ in pairs)
    assert len(pairs) == 3


def test_load_embeddings_只开一次库且能按id过滤(tmp_path):
    vectors = random_vectors(5, 4, seed=1)
    engine = make_engine(tmp_path, vectors)

    loaded = engine.load_embeddings()
    assert set(loaded) == set(vectors)
    for bucket_id, vector in vectors.items():
        assert loaded[bucket_id] == pytest.approx(vector)

    wanted = list(vectors)[:2]
    assert set(engine.load_embeddings(wanted)) == set(wanted)


def test_load_embeddings_跳过坏数据不整个失败(tmp_path):
    vectors = {"good": [1.0, 2.0]}
    engine = make_engine(tmp_path, vectors)
    conn = sqlite3.connect(engine.db_path)
    conn.execute("INSERT INTO embeddings VALUES (?, ?, ?)", ("broken", engine.model, "{不是json"))
    conn.execute("INSERT INTO embeddings VALUES (?, ?, ?)", ("empty", engine.model, "[]"))
    conn.commit()
    conn.close()

    loaded = engine.load_embeddings()
    assert set(loaded) == {"good"}


def test_只读别的模型的向量(tmp_path):
    engine = make_engine(tmp_path, {"a": [1.0, 2.0]}, model="model-A")
    conn = sqlite3.connect(engine.db_path)
    conn.execute("INSERT INTO embeddings VALUES (?, ?, ?)", ("b", "model-B", json.dumps([1.0, 2.0])))
    conn.commit()
    conn.close()

    assert set(engine.load_embeddings()) == {"a"}

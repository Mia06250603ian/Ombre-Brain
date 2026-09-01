# ============================================================
# Module: Embedding Engine (embedding_engine.py)
# 模块：向量化引擎
#
# Generates embeddings via Gemini API (Google native by default,
# OpenAI-compatible for custom endpoints), stores them in SQLite,
# and provides cosine similarity search.
# ============================================================

import os
import json
import math
import sqlite3
import logging

import httpx

try:
    from openai import AsyncOpenAI
except ImportError:
    AsyncOpenAI = None

logger = logging.getLogger("ombre_brain.embedding")

_GOOGLE_NATIVE_BASE = "https://generativelanguage.googleapis.com/v1beta"


class EmbeddingEngine:
    """Embedding generation + SQLite vector storage + cosine search."""

    def __init__(self, config: dict):
        dehy_cfg = config.get("dehydration", {})
        embed_cfg = config.get("embedding", {})

        if embed_cfg.get("independent"):
            self.api_key = str(embed_cfg.get("api_key") or "").strip()
        else:
            self.api_key = (
                embed_cfg.get("api_key") or dehy_cfg.get("api_key") or ""
            ).strip()

        user_base_url = (
            (embed_cfg.get("base_url") or "").strip()
            or (dehy_cfg.get("base_url") or "").strip()
        )

        if user_base_url and "generativelanguage.googleapis.com" not in user_base_url:
            self.mode = "openai_compat"
            self.base_url = user_base_url
        else:
            self.mode = "google_native"
            if user_base_url:
                # Respect the user-supplied Google URL (e.g. v1 vs v1beta).
                self.base_url = user_base_url.rstrip("/")
            else:
                # Auto-select API version by model family:
                # text-embedding-* (gecko era) → stable v1
                # gemini-embedding-* and others → v1beta
                model_hint = embed_cfg.get("model", "gemini-embedding-001")
                if model_hint.startswith("text-embedding"):
                    self.base_url = "https://generativelanguage.googleapis.com/v1"
                else:
                    self.base_url = _GOOGLE_NATIVE_BASE

        self.model = embed_cfg.get("model", "gemini-embedding-001")
        self.enabled = bool(self.api_key) and embed_cfg.get("enabled", True)
        self.last_error = ""
        self.last_error_details = {}

        db_path = os.path.join(config["buckets_dir"], "embeddings.db")
        self.db_path = db_path

        self.client = None
        if self.enabled and self.mode == "openai_compat":
            if AsyncOpenAI is not None:
                self.client = AsyncOpenAI(
                    api_key=self.api_key,
                    base_url=self.base_url,
                    timeout=30.0,
                )
            else:
                logger.warning("openai package not installed; falling back to google_native mode")
                self.mode = "google_native"

        self._init_db()

    def _init_db(self):
        """Create embeddings table if not exists."""
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        conn = sqlite3.connect(self.db_path)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS embeddings (
                bucket_id TEXT PRIMARY KEY,
                embedding TEXT NOT NULL,
                model TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL
            )
        """)
        columns = {
            row[1] for row in conn.execute("PRAGMA table_info(embeddings)").fetchall()
        }
        if "model" not in columns:
            conn.execute(
                "ALTER TABLE embeddings ADD COLUMN model TEXT NOT NULL DEFAULT ''"
            )
        conn.commit()
        conn.close()

    async def generate_and_store(self, bucket_id: str, content: str) -> bool:
        """Generate embedding for content and store in SQLite."""
        if not self.enabled or not content or not content.strip():
            return False

        try:
            embedding = await self._generate_embedding(content)
            if not embedding:
                return False
            self._store_embedding(bucket_id, embedding)
            self.last_error = ""
            self.last_error_details = {}
            return True
        except Exception as e:
            self._capture_error(e)
            logger.warning(f"Embedding generation failed for {bucket_id}: {e}")
            return False

    async def _generate_embedding(self, text: str) -> list[float]:
        """Call API to generate embedding vector."""
        truncated = text[:2000]
        if self.mode == "google_native":
            return await self._generate_embedding_google_native(truncated)
        else:
            return await self._generate_embedding_openai_compat(truncated)

    async def _generate_embedding_google_native(self, text: str) -> list[float]:
        """Call Google's native embedding API with key auth."""
        url = f"{self.base_url}/models/{self.model}:embedContent?key={self.api_key}"
        body = {
            "model": f"models/{self.model}",
            "content": {
                "parts": [{"text": text}]
            }
        }
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(url, json=body)
                if response.status_code != 200:
                    self.last_error = f"Google API error: {response.status_code}"
                    self.last_error_details = {
                        "request_url": str(url).split("?")[0],
                        "status_code": response.status_code,
                        "response_body": response.text[:2000],
                    }
                    logger.warning(f"Embedding API call failed: Error code: {response.status_code} - {response.text[:200]}")
                    return []
                data = response.json()
                values = data.get("embedding", {}).get("values", [])
                return values
        except Exception as e:
            self._capture_error(e)
            logger.warning(f"Embedding API call failed: {e}")
            return []

    async def _generate_embedding_openai_compat(self, text: str) -> list[float]:
        """Call OpenAI-compatible embedding API."""
        try:
            response = await self.client.embeddings.create(
                model=self.model,
                input=text,
            )
            if response.data and len(response.data) > 0:
                return response.data[0].embedding
            return []
        except Exception as e:
            self._capture_error(e)
            logger.warning(f"Embedding API call failed: {e}")
            return []

    def _capture_error(self, error: Exception) -> None:
        """Keep upstream diagnostics without retaining credentials."""
        response = getattr(error, "response", None)
        request = getattr(error, "request", None)
        if request is None and response is not None:
            request = getattr(response, "request", None)

        self.last_error = f"{type(error).__name__}: {error}"[:500]
        self.last_error_details = {
            "request_url": str(getattr(request, "url", "")),
            "status_code": getattr(response, "status_code", None),
            "response_body": getattr(response, "text", "")[:2000],
        }

    def _store_embedding(self, bucket_id: str, embedding: list[float]):
        """Store embedding in SQLite."""
        from utils import now_iso
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """
            INSERT OR REPLACE INTO embeddings
                (bucket_id, embedding, model, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (bucket_id, json.dumps(embedding), self.model, now_iso()),
        )
        conn.commit()
        conn.close()

    def delete_embedding(self, bucket_id: str):
        """Remove embedding when bucket is deleted."""
        conn = sqlite3.connect(self.db_path)
        conn.execute("DELETE FROM embeddings WHERE bucket_id = ?", (bucket_id,))
        conn.commit()
        conn.close()

    async def get_embedding(self, bucket_id: str) -> list[float] | None:
        """Retrieve stored embedding for a bucket."""
        conn = sqlite3.connect(self.db_path)
        row = conn.execute(
            """
            SELECT embedding FROM embeddings
            WHERE bucket_id = ? AND model = ?
            """,
            (bucket_id, self.model),
        ).fetchone()
        conn.close()
        if row:
            try:
                return json.loads(row[0])
            except json.JSONDecodeError:
                return None
        return None

    async def search_similar(self, query: str, top_k: int = 10) -> list[tuple[str, float]]:
        """Search for buckets similar to query text."""
        if not self.enabled:
            return []

        try:
            query_embedding = await self._generate_embedding(query)
            if not query_embedding:
                return []
        except Exception as e:
            logger.warning(f"Query embedding failed: {e}")
            return []

        conn = sqlite3.connect(self.db_path)
        rows = conn.execute(
            "SELECT bucket_id, embedding FROM embeddings WHERE model = ?",
            (self.model,),
        ).fetchall()
        conn.close()

        if not rows:
            return []

        results = []
        for bucket_id, emb_json in rows:
            try:
                stored_embedding = json.loads(emb_json)
                sim = self._cosine_similarity(query_embedding, stored_embedding)
                results.append((bucket_id, sim))
            except (json.JSONDecodeError, Exception):
                continue

        results.sort(key=lambda x: x[1], reverse=True)
        return results[:top_k]

    async def find_similar_buckets(
        self, bucket_id: str, top_k: int = 3, min_sim: float = 0.5
    ) -> list[tuple[str, float]]:
        """Find buckets most similar to an existing bucket's stored embedding."""
        if not self.enabled:
            return []

        target = await self.get_embedding(bucket_id)
        if not target:
            return []

        conn = sqlite3.connect(self.db_path)
        rows = conn.execute(
            "SELECT bucket_id, embedding FROM embeddings WHERE model = ?",
            (self.model,),
        ).fetchall()
        conn.close()

        results = []
        for other_id, emb_json in rows:
            if other_id == bucket_id:
                continue
            try:
                other = json.loads(emb_json)
                sim = self._cosine_similarity(target, other)
                if sim >= min_sim:
                    results.append((other_id, sim))
            except (json.JSONDecodeError, Exception):
                continue

        results.sort(key=lambda x: x[1], reverse=True)
        return results[:top_k]

    @staticmethod
    def _cosine_similarity(a: list[float], b: list[float]) -> float:
        """Calculate cosine similarity between two vectors."""
        if len(a) != len(b) or not a:
            return 0.0
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = math.sqrt(sum(x * x for x in a))
        norm_b = math.sqrt(sum(x * x for x in b))
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return dot / (norm_a * norm_b)

    # ------------------------------------------------------------------
    # 全库两两相似度（给 /api/network 这类「所有桶互相比一遍」的场景用）
    #
    # ⚠️ 为什么不直接用 _cosine_similarity 循环：那是 O(n²) 次纯 Python 点积。
    # 438 个桶 = 95703 对 × 3072 维，实测约 30 秒（Zeabur 上更久），
    # 而且它是同步 CPU 活，跑在 async 处理函数里会占住整个事件循环 ——
    # 那段时间 /mcp 也不响应，晏调记忆工具会跟着卡。2026-09-01 实测到这个问题。
    # 这里改成一次读库 + numpy 矩阵乘法，同一批数据毫秒级出结果。
    # numpy 拿不到时自动退回纯 Python（只是慢，不会坏）。
    # ------------------------------------------------------------------

    def load_embeddings(self, bucket_ids=None) -> dict[str, list[float]]:
        """一次连接读出全部向量（可选按 bucket_ids 过滤）。

        老写法是每个桶调一次 get_embedding = 每个桶开一次 sqlite 连接；
        438 个桶就是 438 次连接。这里只开一次。
        """
        wanted = set(bucket_ids) if bucket_ids is not None else None
        conn = sqlite3.connect(self.db_path)
        try:
            rows = conn.execute(
                "SELECT bucket_id, embedding FROM embeddings WHERE model = ?",
                (self.model,),
            ).fetchall()
        finally:
            conn.close()

        out: dict[str, list[float]] = {}
        for bucket_id, emb_json in rows:
            if wanted is not None and bucket_id not in wanted:
                continue
            try:
                vector = json.loads(emb_json)
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(vector, list) and vector:
                out[bucket_id] = vector
        return out

    def similar_pairs(
        self,
        embeddings: dict[str, list[float]],
        min_sim: float = 0.5,
        top_k: int | None = None,
    ) -> list[tuple[str, str, float]]:
        """算出所有相似度高于 min_sim 的桶对，返回 [(id_a, id_b, sim), ...]。

        top_k 不为 None 时，每个桶只保留与它最像的 top_k 条
        （一条边只要在任意一端的前 top_k 里就留下）——防止边多到前端画不动。

        结果与逐对调用 _cosine_similarity 一致（tests/test_similar_pairs.py 钉着这条）。
        """
        # 维度不一致的向量没法进同一个矩阵（换过 embedding 模型时会出现）。
        # 老写法遇到这种是 _cosine_similarity 返回 0.0 = 不连边，
        # 这里同样把少数派整个排除掉，行为一致。
        ids_all = [bid for bid, vec in embeddings.items() if vec]
        if len(ids_all) < 2:
            return []
        dims: dict[int, int] = {}
        for bid in ids_all:
            dim = len(embeddings[bid])
            dims[dim] = dims.get(dim, 0) + 1
        main_dim = max(dims.items(), key=lambda kv: kv[1])[0]
        ids = [bid for bid in ids_all if len(embeddings[bid]) == main_dim]
        skipped = len(ids_all) - len(ids)
        if skipped:
            logger.warning(
                f"similar_pairs: skipped {skipped} vector(s) with mismatched dimension "
                f"(main dim={main_dim})"
            )
        if len(ids) < 2:
            return []

        try:
            import numpy as np
        except ImportError:
            logger.warning("similar_pairs: numpy unavailable, falling back to pure Python")
            return self._similar_pairs_fallback(embeddings, ids, min_sim, top_k)

        matrix = np.asarray([embeddings[bid] for bid in ids], dtype=np.float32)
        norms = np.linalg.norm(matrix, axis=1)
        keep = norms > 0
        if not bool(keep.all()):
            matrix = matrix[keep]
            norms = norms[keep]
            ids = [bid for bid, ok in zip(ids, keep.tolist()) if ok]
            if len(ids) < 2:
                return []
        matrix = matrix / norms[:, None]

        count = len(ids)
        # 分块算，峰值内存只跟「块 × 全部」有关，桶再多也不会一口气吃掉整张 n×n 表。
        block = 256
        best: dict[str, list[float]] = {}
        pairs: list[tuple[str, str, float]] = []
        for start in range(0, count, block):
            stop = min(start + block, count)
            sims = matrix[start:stop] @ matrix.T
            for offset in range(stop - start):
                row_index = start + offset
                row = sims[offset]
                row[row_index] = -1.0          # 自己跟自己不算
                hits = np.nonzero(row > min_sim)[0]
                if top_k is not None and hits.size > top_k:
                    # 只留这一行最像的 top_k 个
                    order = np.argsort(row[hits])[::-1][:top_k]
                    hits = hits[order]
                for col_index in hits.tolist():
                    if col_index < row_index:
                        continue           # 上三角即可，每对只出一次
                    pairs.append((ids[row_index], ids[col_index], float(row[col_index])))
            del sims

        if top_k is not None:
            pairs = self._cap_per_node(pairs, top_k)
        pairs.sort(key=lambda item: item[2], reverse=True)
        return [(a, b, round(sim, 3)) for a, b, sim in pairs]

    def _similar_pairs_fallback(self, embeddings, ids, min_sim, top_k):
        """numpy 不在时的退路：仍是 O(n²)，但模长只算一次，比原来的写法快约 3 倍。"""
        norms = {}
        for bid in ids:
            vec = embeddings[bid]
            norm = math.sqrt(sum(x * x for x in vec))
            if norm > 0:
                norms[bid] = norm
        usable = [bid for bid in ids if bid in norms]
        pairs: list[tuple[str, str, float]] = []
        for index, id_a in enumerate(usable):
            vec_a = embeddings[id_a]
            for id_b in usable[index + 1:]:
                sim = sum(x * y for x, y in zip(vec_a, embeddings[id_b])) / (norms[id_a] * norms[id_b])
                if sim > min_sim:
                    pairs.append((id_a, id_b, sim))
        if top_k is not None:
            pairs = self._cap_per_node(pairs, top_k)
        pairs.sort(key=lambda item: item[2], reverse=True)
        return [(a, b, round(sim, 3)) for a, b, sim in pairs]

    @staticmethod
    def _cap_per_node(pairs, top_k: int):
        """每个桶只保留最像的 top_k 条边（边在任意一端入选就保留）。"""
        ranked: dict[str, list[tuple[str, str, float]]] = {}
        for pair in pairs:
            ranked.setdefault(pair[0], []).append(pair)
            ranked.setdefault(pair[1], []).append(pair)
        kept = set()
        for edges in ranked.values():
            edges.sort(key=lambda item: item[2], reverse=True)
            for edge in edges[:top_k]:
                kept.add((edge[0], edge[1]))
        return [pair for pair in pairs if (pair[0], pair[1]) in kept]

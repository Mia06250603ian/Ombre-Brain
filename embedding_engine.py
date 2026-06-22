# ============================================================
# Module: Embedding Engine (embedding_engine.py)
# 模块：向量化引擎
#
# Primary backend: DeepSeek API (OpenAI-compatible)
#   - base_url: OMBRE_BASE_URL env var  (falls back to config, then deepseek default)
#   - api_key:  OMBRE_API_KEY env var   (falls back to config)
#   - model:    config embedding.model  (default: "deepseek-embedding")
#
# Fallback backend: sentence-transformers (local, no API required)
#   - model: paraphrase-multilingual-MiniLM-L12-v2
#   - activated automatically when API call fails or no API key is set
#   - requires: pip install sentence-transformers
#
# If both backends are unavailable, all operations degrade silently to
# keyword-only search — the rest of the system keeps working.
#
# Storage: SQLite (buckets_dir/embeddings.db)
#   - model_id column tracks which backend produced each embedding
#   - search_similar() only compares embeddings from the same backend
#     to avoid dimension mismatches between API (e.g. 1536-d) and local (384-d)
#
# Depended on by: server.py, bucket_manager.py
# 被谁依赖：server.py, bucket_manager.py
# ============================================================

import os
import json
import math
import sqlite3
import asyncio
import logging

logger = logging.getLogger("ombre_brain.embedding")

_LOCAL_MODEL_NAME = "paraphrase-multilingual-MiniLM-L12-v2"


class EmbeddingEngine:
    """
    Dual-backend embedding engine with automatic fallback.
    双后端向量化引擎，API不可用时自动降级到本地模型。
    """

    def __init__(self, config: dict):
        dehy_cfg = config.get("dehydration", {})
        embed_cfg = config.get("embedding", {})

        # --- OMBRE_API_KEY / OMBRE_BASE_URL have highest priority (instruction C) ---
        self.api_key = (
            os.environ.get("OMBRE_API_KEY", "").strip()
            or (embed_cfg.get("api_key") or "").strip()
            or (dehy_cfg.get("api_key") or "").strip()
        )
        self.base_url = (
            os.environ.get("OMBRE_BASE_URL", "").strip()
            or (embed_cfg.get("base_url") or "").strip()
            or (dehy_cfg.get("base_url") or "").strip()
            or "https://api.deepseek.com/v1"
        )
        self.model = embed_cfg.get("model", "deepseek-embedding")

        # --- SQLite path: buckets_dir/embeddings.db ---
        self.db_path = os.path.join(config["buckets_dir"], "embeddings.db")

        # --- API client ---
        self._api_available = bool(self.api_key)
        self._api_failed = False  # flipped True on first embedding API error
        if self._api_available:
            from openai import AsyncOpenAI
            self.client = AsyncOpenAI(
                api_key=self.api_key,
                base_url=self.base_url,
                timeout=30.0,
            )
        else:
            self.client = None
            logger.info("No API key for embedding — will try local sentence-transformers")

        # --- Local fallback state ---
        self._local_model = None       # lazy-loaded SentenceTransformer
        self._local_available = None   # None=untried, True/False after first attempt

        # Always True: degrades to keyword-only when both backends fail
        self.enabled = True

        self._init_db()

    # ---------------------------------------------------------
    # SQLite init / migration
    # ---------------------------------------------------------
    def _init_db(self):
        os.makedirs(os.path.dirname(self.db_path) or ".", exist_ok=True)
        conn = sqlite3.connect(self.db_path)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS embeddings (
                bucket_id  TEXT PRIMARY KEY,
                embedding  TEXT NOT NULL,
                model_id   TEXT,
                updated_at TEXT NOT NULL
            )
        """)
        # Migration: add model_id column to pre-existing databases
        try:
            conn.execute("ALTER TABLE embeddings ADD COLUMN model_id TEXT")
        except sqlite3.OperationalError:
            pass  # column already exists
        conn.commit()
        conn.close()

    # ---------------------------------------------------------
    # Public API
    # ---------------------------------------------------------
    async def generate_and_store(self, bucket_id: str, content: str) -> bool:
        """
        Generate embedding for content and persist to SQLite.
        Returns True on success, False when both backends unavailable.
        """
        if not content or not content.strip():
            return False
        try:
            embedding, model_id = await self._generate_embedding(content)
            if not embedding or model_id == "none":
                return False
            self._store_embedding(bucket_id, embedding, model_id)
            return True
        except Exception as e:
            logger.warning(f"Embedding generation failed for {bucket_id}: {e}")
            return False

    async def search_similar(
        self, query: str, top_k: int = 10
    ) -> list[tuple[str, float]]:
        """
        Semantic search: returns [(bucket_id, cosine_similarity)] sorted desc.
        Falls back to [] when no embedding backend is available.
        Only compares embeddings produced by the same backend (same model_id)
        to avoid dimension-mismatch errors.
        """
        try:
            query_embedding, model_id = await self._generate_embedding(query)
            if not query_embedding or model_id == "none":
                return []
        except Exception as e:
            logger.warning(f"Query embedding failed: {e}")
            return []

        conn = sqlite3.connect(self.db_path)
        rows = conn.execute(
            "SELECT bucket_id, embedding FROM embeddings WHERE model_id = ?",
            (model_id,),
        ).fetchall()
        conn.close()

        if not rows:
            return []

        results = []
        for bucket_id, emb_json in rows:
            try:
                stored = json.loads(emb_json)
                sim = self._cosine_similarity(query_embedding, stored)
                results.append((bucket_id, sim))
            except Exception:
                continue

        results.sort(key=lambda x: x[1], reverse=True)
        return results[:top_k]

    async def get_embedding(self, bucket_id: str) -> list[float] | None:
        """Retrieve stored embedding vector for a bucket (any backend)."""
        conn = sqlite3.connect(self.db_path)
        row = conn.execute(
            "SELECT embedding FROM embeddings WHERE bucket_id = ?", (bucket_id,)
        ).fetchone()
        conn.close()
        if row:
            try:
                return json.loads(row[0])
            except json.JSONDecodeError:
                return None
        return None

    def delete_embedding(self, bucket_id: str) -> None:
        """Remove embedding when a bucket is deleted."""
        conn = sqlite3.connect(self.db_path)
        conn.execute("DELETE FROM embeddings WHERE bucket_id = ?", (bucket_id,))
        conn.commit()
        conn.close()

    # ---------------------------------------------------------
    # Internal: embedding generation (API → local fallback)
    # ---------------------------------------------------------
    async def _generate_embedding(self, text: str) -> tuple[list[float], str]:
        """
        Returns (embedding_vector, model_id_string).
        model_id is "api:<model>" or "local:<model>" or "none".
        """
        truncated = text[:2000]

        # --- Try DeepSeek (or any OpenAI-compatible) API ---
        if self._api_available and not self._api_failed:
            try:
                response = await self.client.embeddings.create(
                    model=self.model,
                    input=truncated,
                )
                if response.data and response.data[0].embedding:
                    return response.data[0].embedding, f"api:{self.model}"
                # Empty response treated as failure
                raise ValueError("Empty embedding response from API")
            except Exception as e:
                logger.warning(
                    f"Embedding API unavailable, switching to local model: {e}"
                )
                self._api_failed = True

        # --- Local sentence-transformers fallback ---
        local_emb = await self._local_embedding(truncated)
        if local_emb:
            return local_emb, f"local:{_LOCAL_MODEL_NAME}"

        return [], "none"

    async def _local_embedding(self, text: str) -> list[float]:
        """Encode text with local sentence-transformers model (lazy-loaded)."""
        if self._local_available is False:
            return []

        if self._local_model is None:
            try:
                from sentence_transformers import SentenceTransformer
                self._local_model = SentenceTransformer(_LOCAL_MODEL_NAME)
                self._local_available = True
                logger.info(
                    f"Local embedding model loaded: {_LOCAL_MODEL_NAME}"
                )
            except ImportError:
                logger.warning(
                    "sentence-transformers not installed; "
                    "run `pip install sentence-transformers` for local fallback. "
                    "Keyword-only search active."
                )
                self._local_available = False
                return []
            except Exception as e:
                logger.warning(f"Local embedding model load failed: {e}")
                self._local_available = False
                return []

        try:
            loop = asyncio.get_event_loop()
            embedding: list[float] = await loop.run_in_executor(
                None, lambda: self._local_model.encode(text).tolist()
            )
            return embedding
        except Exception as e:
            logger.warning(f"Local embedding encode failed: {e}")
            return []

    # ---------------------------------------------------------
    # Internal: SQLite persistence
    # ---------------------------------------------------------
    def _store_embedding(
        self, bucket_id: str, embedding: list[float], model_id: str
    ) -> None:
        from utils import now_iso
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            "INSERT OR REPLACE INTO embeddings "
            "(bucket_id, embedding, model_id, updated_at) VALUES (?, ?, ?, ?)",
            (bucket_id, json.dumps(embedding), model_id, now_iso()),
        )
        conn.commit()
        conn.close()

    # ---------------------------------------------------------
    # Utility
    # ---------------------------------------------------------
    @staticmethod
    def _cosine_similarity(a: list[float], b: list[float]) -> float:
        """Cosine similarity in [0, 1]. Returns 0.0 on dimension mismatch."""
        if not a or not b or len(a) != len(b):
            return 0.0
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = math.sqrt(sum(x * x for x in a))
        norm_b = math.sqrt(sum(x * x for x in b))
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return dot / (norm_a * norm_b)

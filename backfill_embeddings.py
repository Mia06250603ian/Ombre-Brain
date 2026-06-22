#!/usr/bin/env python3
"""
Backfill embeddings for existing buckets that have no vector index yet.
为存量桶补建向量索引（一次性脚本）。

Usage:
    python backfill_embeddings.py [--batch-size 20] [--dry-run] [--force]

Environment variables (same as main server):
    OMBRE_API_KEY   — DeepSeek / OpenAI-compatible API key (primary backend)
    OMBRE_BASE_URL  — API base URL (default: https://api.deepseek.com/v1)
    OMBRE_BUCKETS_DIR — override bucket storage directory

Backends (tried in order):
    1. DeepSeek API (or any OpenAI-compatible endpoint via OMBRE_BASE_URL)
    2. sentence-transformers local model (paraphrase-multilingual-MiniLM-L12-v2)

Options:
    --batch-size N  Process N buckets per batch (default: 20)
    --dry-run       Show what would be embedded without making API calls
    --force         Re-embed all buckets, even those with existing embeddings
                    (useful when switching from one backend to another)
"""

import asyncio
import argparse
import sys

sys.path.insert(0, ".")
from utils import load_config
from bucket_manager import BucketManager
from embedding_engine import EmbeddingEngine


async def _probe_engine(engine: EmbeddingEngine) -> bool:
    """Return True if the engine can actually generate embeddings."""
    ok = await engine.generate_and_store("__probe__", "embedding probe test")
    engine.delete_embedding("__probe__")
    return ok


async def backfill(batch_size: int = 20, dry_run: bool = False, force: bool = False):
    config = load_config()
    bucket_mgr = BucketManager(config)
    engine = EmbeddingEngine(config)

    if dry_run:
        print("[DRY RUN] No API calls or writes will be made.\n")
    else:
        print("Probing embedding backend...")
        if not await _probe_engine(engine):
            print(
                "ERROR: No embedding backend available.\n"
                "  Set OMBRE_API_KEY (DeepSeek / OpenAI-compatible) OR\n"
                "  install sentence-transformers: pip install sentence-transformers"
            )
            return
        backend = (
            f"API ({engine.base_url}, model={engine.model})"
            if (engine._api_available and not engine._api_failed)
            else f"local ({engine._LOCAL_MODEL_NAME})"  # type: ignore[attr-defined]
        )
        print(f"Backend: {backend}\n")

    all_buckets = await bucket_mgr.list_all(include_archive=True)
    print(f"Total buckets: {len(all_buckets)}")

    if force:
        pending = all_buckets
        print(f"--force: re-embedding all {len(pending)} buckets")
    else:
        pending = []
        for b in all_buckets:
            emb = await engine.get_embedding(b["id"])
            if emb is None:
                pending.append(b)
        print(f"Missing embeddings: {len(pending)}")

    if not pending:
        print("Nothing to do.")
        return

    if dry_run:
        for b in pending[:10]:
            print(f"  would embed: {b['id']} ({b['metadata'].get('name', '?')})")
        if len(pending) > 10:
            print(f"  ... and {len(pending) - 10} more")
        return

    total = len(pending)
    success = 0
    failed = 0
    skipped = 0

    for i in range(0, total, batch_size):
        batch = pending[i : i + batch_size]
        batch_num = i // batch_size + 1
        total_batches = (total + batch_size - 1) // batch_size
        print(f"\n--- Batch {batch_num}/{total_batches} ({len(batch)} buckets) ---")

        for b in batch:
            name = b["metadata"].get("name", b["id"])
            content = b.get("content", "")
            if not content or not content.strip():
                print(f"  SKIP (empty): {b['id']} ({name})")
                skipped += 1
                continue

            try:
                ok = await engine.generate_and_store(b["id"], content)
                if ok:
                    success += 1
                    print(f"  OK:   {b['id'][:12]} {name[:40]}")
                else:
                    failed += 1
                    print(f"  FAIL: {b['id'][:12]} {name[:40]}")
            except Exception as e:
                failed += 1
                print(f"  ERR:  {b['id'][:12]} {name[:40]}: {e}")

        if i + batch_size < total:
            await asyncio.sleep(1)

    print(
        f"\n=== Done: {success} indexed, {failed} failed, "
        f"{skipped} skipped (empty content) ==="
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill embeddings for existing buckets")
    parser.add_argument("--batch-size", type=int, default=20, metavar="N")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    parser.add_argument("--force", action="store_true", help="Re-embed all buckets")
    args = parser.parse_args()
    asyncio.run(backfill(batch_size=args.batch_size, dry_run=args.dry_run, force=args.force))

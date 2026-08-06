# ============================================================
# Test: Dashboard bucket edit / archive / delete endpoints
# 测试：仪表板的改桶、归档、删桶接口
#
# Covers:
#   1. PATCH /api/bucket/{id} updates only whitelisted fields
#   2. Unknown / empty fields are rejected (400)
#   3. Missing bucket → 404
#   4. Pinned buckets refuse DELETE without force=1 (409)
#   5. mode=archive moves the bucket; default mode deletes it
#   6. Both routes require an authenticated dashboard session (401)
# ============================================================

import os
import sys
import tempfile

import pytest

pytest.importorskip("starlette.testclient")
from starlette.testclient import TestClient  # noqa: E402


@pytest.fixture(scope="module")
def client_and_server():
    """Boot server.py against a throwaway bucket dir, logged in."""
    bd = tempfile.mkdtemp()
    for sub in ("permanent", "dynamic", "archive", "feel"):
        os.makedirs(os.path.join(bd, sub), exist_ok=True)
    os.environ["OMBRE_BUCKETS_DIR"] = bd
    os.environ["OMBRE_DASHBOARD_PASSWORD"] = "dashboard-test-pw"
    os.environ.setdefault("OMBRE_SEAL_WORD", "test-seal")
    os.environ["OMBRE_HOOK_SKIP"] = "1"

    sys.modules.pop("server", None)
    import server  # noqa: WPS433 — imported late so env vars above apply

    client = TestClient(server.mcp.streamable_http_app())
    resp = client.post("/auth/login", json={"password": "dashboard-test-pw"})
    assert resp.status_code == 200
    return client, server


@pytest.fixture
def bucket(client_and_server):
    """A fresh dynamic bucket per test, returns its id."""
    import anyio
    _, server = client_and_server
    return anyio.run(
        lambda: server.bucket_mgr.create(
            content="原始内容", name="仪表板测试桶", tags=["a"],
            domain=["测试"], importance=5, valence=0.5, arousal=0.3,
        )
    )


class TestBucketUpdate:
    def test_updates_whitelisted_fields(self, client_and_server, bucket):
        client, _ = client_and_server
        resp = client.patch(f"/api/bucket/{bucket}", json={
            "name": "改过的桶", "content": "新内容", "importance": 8,
            "tags": "x, y", "resolved": True,
        })
        assert resp.status_code == 200
        data = resp.json()
        meta = data["metadata"]
        assert meta["name"] == "改过的桶"
        assert meta["importance"] == 8
        assert meta["tags"] == ["x", "y"]
        assert meta["resolved"] is True
        assert data["content"] == "新内容"

    def test_unknown_fields_rejected(self, client_and_server, bucket):
        client, _ = client_and_server
        resp = client.patch(f"/api/bucket/{bucket}", json={"type": "permanent"})
        assert resp.status_code == 400

    def test_empty_name_rejected(self, client_and_server, bucket):
        client, _ = client_and_server
        assert client.patch(f"/api/bucket/{bucket}", json={"name": "   "}).status_code == 400

    def test_empty_domain_rejected(self, client_and_server, bucket):
        client, _ = client_and_server
        assert client.patch(f"/api/bucket/{bucket}", json={"domain": []}).status_code == 400

    def test_missing_bucket_404(self, client_and_server):
        client, _ = client_and_server
        assert client.patch("/api/bucket/nope", json={"name": "x"}).status_code == 404


class TestBucketDelete:
    def test_pinned_needs_force(self, client_and_server, bucket):
        client, _ = client_and_server
        client.patch(f"/api/bucket/{bucket}", json={"pinned": True})
        resp = client.delete(f"/api/bucket/{bucket}")
        assert resp.status_code == 409
        assert resp.json()["error"] == "protected"
        # force=1 gets through
        assert client.delete(f"/api/bucket/{bucket}?force=1").status_code == 200

    def test_archive_keeps_the_file(self, client_and_server, bucket):
        import anyio
        client, server = client_and_server
        assert client.delete(f"/api/bucket/{bucket}?mode=archive").status_code == 200
        still = anyio.run(lambda: server.bucket_mgr.get(bucket))
        assert still is not None
        assert still["metadata"]["type"] == "archived"

    def test_delete_removes_the_bucket(self, client_and_server, bucket):
        import anyio
        client, server = client_and_server
        assert client.delete(f"/api/bucket/{bucket}").status_code == 200
        assert anyio.run(lambda: server.bucket_mgr.get(bucket)) is None

    def test_bad_mode_rejected(self, client_and_server, bucket):
        client, _ = client_and_server
        assert client.delete(f"/api/bucket/{bucket}?mode=shred").status_code == 400


class TestSpecCompatibility:
    """These three are the spec's rules, not the endpoint's — keep them nailed down."""

    @pytest.fixture
    def feel_bucket(self, client_and_server):
        import anyio
        _, server = client_and_server
        return anyio.run(
            lambda: server.bucket_mgr.create(
                content="今天有点闷", name="感受桶", tags=[], domain=[],
                importance=5, valence=0.4, arousal=0.3, bucket_type="feel",
            )
        )

    def test_feel_may_keep_empty_domain(self, client_and_server, feel_bucket):
        """B-10：feel 桶就是空 domain，编辑它不该被逼着填一个。"""
        client, _ = client_and_server
        resp = client.patch(f"/api/bucket/{feel_bucket}", json={"domain": [], "name": "感受桶2"})
        assert resp.status_code == 200
        assert resp.json()["metadata"].get("domain", []) == []

    def test_feel_never_archives(self, client_and_server, feel_bucket):
        """规格：feel 桶永不归档，衰减引擎跳过它，网页端也不能开后门。"""
        import anyio
        client, server = client_and_server
        resp = client.delete(f"/api/bucket/{feel_bucket}?mode=archive")
        assert resp.status_code == 409
        assert resp.json()["error"] == "feel_never_archives"
        # force 也不行
        assert client.delete(f"/api/bucket/{feel_bucket}?mode=archive&force=1").status_code == 409
        still = anyio.run(lambda: server.bucket_mgr.get(feel_bucket))
        assert still["metadata"]["type"] == "feel"

    def test_metadata_only_edit_writes_no_snapshot(self, client_and_server, bucket):
        """只改元数据不该留写前快照（快照只在内容覆盖/删除时产生）。"""
        client, server = client_and_server
        assert client.patch(f"/api/bucket/{bucket}", json={"importance": 9}).status_code == 200
        assert server.bucket_mgr.list_history(bucket) == []
        # 改内容才留快照
        assert client.patch(f"/api/bucket/{bucket}", json={"content": "换过的正文"}).status_code == 200
        assert len(server.bucket_mgr.list_history(bucket)) == 1

    def test_resolved_edit_does_not_auto_archive(self, client_and_server, bucket):
        """B-01：resolved 只降权，留在 dynamic/ 自然衰减，不立即归档。"""
        import anyio
        client, server = client_and_server
        assert client.patch(f"/api/bucket/{bucket}", json={"resolved": True}).status_code == 200
        meta = anyio.run(lambda: server.bucket_mgr.get(bucket))["metadata"]
        assert meta["resolved"] is True
        assert meta["type"] == "dynamic"

    def test_pinned_importance_stays_locked(self, client_and_server, bucket):
        """钉选桶 importance 锁 10，网页端也改不动。"""
        client, _ = client_and_server
        client.patch(f"/api/bucket/{bucket}", json={"pinned": True})
        resp = client.patch(f"/api/bucket/{bucket}", json={"importance": 3})
        assert resp.status_code == 200
        assert resp.json()["metadata"]["importance"] == 10

    def test_bad_trigger_date_rejected(self, client_and_server, bucket):
        client, _ = client_and_server
        assert client.patch(f"/api/bucket/{bucket}", json={"trigger_date": "8月6日"}).status_code == 400
        ok = client.patch(f"/api/bucket/{bucket}", json={"trigger_date": "2026-09-01"})
        assert ok.status_code == 200
        assert ok.json()["metadata"]["trigger_date"] == "2026-09-01"


class TestAuthRequired:
    def test_unauthenticated_calls_401(self, client_and_server, bucket):
        _, server = client_and_server
        anon = TestClient(server.mcp.streamable_http_app())
        assert anon.patch(f"/api/bucket/{bucket}", json={"name": "x"}).status_code == 401
        assert anon.delete(f"/api/bucket/{bucket}").status_code == 401

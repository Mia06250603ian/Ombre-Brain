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


class TestAuthRequired:
    def test_unauthenticated_calls_401(self, client_and_server, bucket):
        _, server = client_and_server
        anon = TestClient(server.mcp.streamable_http_app())
        assert anon.patch(f"/api/bucket/{bucket}", json={"name": "x"}).status_code == 401
        assert anon.delete(f"/api/bucket/{bucket}").status_code == 401

# ============================================================
# Test: 机器走的门上锁(mcp_guard.py,2026-10-03)
#
# 最要紧的三件事:
#   1. **不设钥匙 = 一切照旧**(上线代码那一步不能影响晏)
#   2. 设了钥匙:/mcp 和两个钩子不带 / 带错 → 401;带对 → 放行
#   3. 别的门(/health、/dashboard、/api/*)一概不碰
# 用一个假的下游 app 顶替 FastMCP,只验中间件本身,不起服务、不碰数据。
# ============================================================

import pytest
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from mcp_guard import TokenGuard, extract_token, is_guarded

TOKEN = "s3cret-token-for-tests"


def _ok(request):
    return PlainTextResponse("ok")


ROUTES = [Route(p, _ok, methods=["GET", "POST"]) for p in
          ("/mcp", "/mcp/", "/breath-hook", "/dream-hook", "/health", "/dashboard", "/api/buckets", "/mcpx")]


def _client(token):
    # 和 server.py 一样的顺序:先锁、后 CORS(CORS 在外层)
    app = Starlette(routes=ROUTES, middleware=[
        Middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]),
        Middleware(TokenGuard, token=token),
    ])
    return TestClient(app)


# ---- 1. 不设钥匙 = 一切照旧 ----
@pytest.mark.parametrize("token", ["", "   ", None])
def test_no_token_means_no_lock(token):
    c = _client(token)
    for p in ("/mcp", "/breath-hook", "/dream-hook", "/health"):
        assert c.get(p).status_code == 200, f"没设钥匙时 {p} 不该被拦"


# ---- 2. 设了钥匙 ----
@pytest.mark.parametrize("path", ["/mcp", "/mcp/", "/breath-hook", "/dream-hook"])
def test_guarded_paths_reject_without_or_wrong_token(path):
    c = _client(TOKEN)
    assert c.get(path).status_code == 401
    assert c.post(path).status_code == 401
    assert c.get(path, headers={"Authorization": "Bearer nope"}).status_code == 401
    assert c.get(path, headers={"Authorization": TOKEN}).status_code == 401, "没有 Bearer 前缀不算"
    assert c.get(path, headers={"X-Ombre-Token": "nope"}).status_code == 401


@pytest.mark.parametrize("path", ["/mcp", "/mcp/", "/breath-hook", "/dream-hook"])
def test_guarded_paths_accept_right_token(path):
    c = _client(TOKEN)
    assert c.get(path, headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 200
    assert c.post(path, headers={"authorization": f"bearer {TOKEN}"}).status_code == 200, "大小写不敏感"
    assert c.get(path, headers={"X-Ombre-Token": TOKEN}).status_code == 200


def test_401_body_and_cors():
    r = _client(TOKEN).get("/mcp", headers={"Origin": "https://example.com"})
    assert r.status_code == 401
    assert r.json() == {"error": "Unauthorized"}
    assert r.headers.get("access-control-allow-origin"), "CORS 在锁外层,401 也要带 CORS 头"


def test_cors_preflight_passes():
    r = _client(TOKEN).options("/mcp", headers={
        "Origin": "https://example.com", "Access-Control-Request-Method": "POST"})
    assert r.status_code == 200, "预检不带自定义头,不能被锁拦住"


# ---- 3. 别的门不碰 ----
@pytest.mark.parametrize("path", ["/health", "/dashboard", "/api/buckets", "/mcpx"])
def test_other_paths_untouched(path):
    assert _client(TOKEN).get(path).status_code == 200


# ---- 纯函数 ----
def test_is_guarded():
    assert is_guarded("/mcp") and is_guarded("/mcp/") and is_guarded("/mcp/abc")
    assert is_guarded("/breath-hook") and is_guarded("/dream-hook")
    assert is_guarded("/sse") and is_guarded("/messages/")
    assert not is_guarded("/mcpx") and not is_guarded("/health") and not is_guarded("/api/recall")


def test_extract_token():
    assert extract_token([(b"authorization", b"Bearer abc ")]) == "abc"
    assert extract_token([(b"x-ombre-token", b" abc")]) == "abc"
    assert extract_token([(b"authorization", b"Basic xyz")]) == ""
    assert extract_token([]) == ""

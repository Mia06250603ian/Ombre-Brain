# ============================================================
# mcp_guard.py —— 给「机器走的门」上锁(2026-10-03)
#
# 为什么有它:
#   /dashboard 那套登录(cookie)只管人用浏览器走的「前门」。晏连记忆库走的是 /mcp,
#   开场钩子走的是 /breath-hook、/dream-hook —— 这三扇门**原来都不验身份**,
#   而 /mcp 的地址又写在过公开仓库里:任何人把地址填进自己的 AI 就能读写全部记忆,
#   两个钩子更是用浏览器直接打开就吐出钉选准则和最近的记忆。
#
# 怎么用:
#   环境变量 OMBRE_MCP_TOKEN。**不设 = 不上锁,行为与改动前逐字相同**
#   (所以先上线代码、再给晏配钥匙、最后才设这个变量,中间没有空档)。
#   设了之后,上面这几扇门要求请求带下面任一种:
#     Authorization: Bearer <token>      (晏的 mcp-servers.json、Claude Code 会话用这个)
#     X-Ombre-Token: <token>             (备用,给不方便写 Authorization 的客户端)
#   不带或不对 → 401。其余路由(/health、/dashboard、/api/* 自己的鉴权)一概不碰。
#
# 为什么写成纯 ASGI 中间件、不用 Starlette 的 BaseHTTPMiddleware:
#   /mcp 是流式(streamable-http / SSE)的,BaseHTTPMiddleware 会把流式响应整个缓冲住。
#   这里只看请求头,放行时原样把 receive/send 交给下游,一个字节都不碰。
# ============================================================

import hmac
import json

# 要上锁的路径。按「等于它」或「以它 + / 开头」匹配,所以 /mcp 和 /mcp/ 都算,/mcpx 不算。
# /sse 与 /messages 是 transport=sse 时 FastMCP 用的两条路,一并锁上,换传输方式也不漏。
GUARDED_PATHS = ("/mcp", "/sse", "/messages", "/breath-hook", "/dream-hook")


def is_guarded(path: str) -> bool:
    return any(path == p or path.startswith(p + "/") for p in GUARDED_PATHS)


def extract_token(headers) -> str:
    """从 ASGI 的 headers(list of (bytes, bytes))里取出调用方给的钥匙。"""
    auth = ""
    alt = ""
    for k, v in headers:
        name = k.decode("latin-1").lower()
        if name == "authorization":
            auth = v.decode("latin-1")
        elif name == "x-ombre-token":
            alt = v.decode("latin-1")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return alt.strip()


class TokenGuard:
    """纯 ASGI 中间件。token 为空串 = 不上锁(整个中间件等于不存在)。"""

    def __init__(self, app, token: str = ""):
        self.app = app
        self.token = (token or "").strip()

    async def __call__(self, scope, receive, send):
        if (
            self.token
            and scope.get("type") == "http"
            and scope.get("method") != "OPTIONS"   # CORS 预检不带自定义头,放行;真正的请求仍要钥匙
            and is_guarded(scope.get("path", ""))
        ):
            given = extract_token(scope.get("headers") or [])
            if not given or not hmac.compare_digest(given.encode(), self.token.encode()):
                body = json.dumps({"error": "Unauthorized"}).encode()
                await send({
                    "type": "http.response.start",
                    "status": 401,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"www-authenticate", b"Bearer"),
                    ],
                })
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)

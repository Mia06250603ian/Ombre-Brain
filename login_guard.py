# ============================================================
# login_guard.py — 记忆库后台登录防猜密码(2026-10-28)
#
# 起因:rivers-system 那边的安全体检发现 /auth/login 输错能无限试(密码最短 6 位),
# 所有者:「做第二个吧」。和 Intertidal 网页那把锁同一套规矩(rivers-system/dwell-bridge/dwell-lib.mjs 的 makeLoginGuard):
#   同一个 IP 15 分钟内错 5 次 → 锁 15 分钟(429);所有 IP 加起来 1 小时错 50 次 → 全部锁 15 分钟(防换着 IP 猜)。
# 锁的只是「登录」:已经登录的浏览器带着 ombre_session 照常能用;晏走的 /mcp 是另一把钥匙,完全不经过这里。
# 只在内存,重启清零。
# ============================================================
import time


class LoginGuard:
    def __init__(self, max_fails=5, window=15 * 60, lock=15 * 60, global_max=50, global_window=60 * 60):
        self.max_fails, self.window, self.lock = max_fails, window, lock
        self.global_max, self.global_window = global_max, global_window
        self._per = {}          # ip -> [fails(时刻列表), until]
        self._all = []
        self._all_until = 0.0

    def check(self, ip, now=None):
        """能不能试:返回 (True, 0, "") 或 (False, 还要等几秒, "ip"|"all")"""
        now = time.time() if now is None else now
        if self._all_until > now:
            return False, int(self._all_until - now + 0.999), "all"
        s = self._per.get(ip)
        if s and s[1] > now:
            return False, int(s[1] - now + 0.999), "ip"
        return True, 0, ""

    def fail(self, ip, now=None):
        now = time.time() if now is None else now
        fails, until = self._per.get(ip, [[], 0.0])
        fails = [t for t in fails if now - t < self.window] + [now]
        if len(fails) >= self.max_fails:
            fails, until = [], now + self.lock
        self._per[ip] = [fails, until]
        self._all = [t for t in self._all if now - t < self.global_window] + [now]
        if len(self._all) >= self.global_max:
            self._all, self._all_until = [], now + self.lock
        if len(self._per) > 1000:
            for k in [k for k, (f, u) in self._per.items() if u <= now and not [t for t in f if now - t < self.window]]:
                self._per.pop(k, None)

    def ok(self, ip):
        self._per.pop(ip, None)


def client_ip(headers, client_host):
    """Caddy 后面的真实 IP:取 X-Forwarded-For 最右边那个(Caddy 自己写的;访客自带的在左边,不信)"""
    parts = [p.strip() for p in (headers.get("x-forwarded-for") or "").split(",") if p.strip()]
    return parts[-1] if parts else (client_host or "")

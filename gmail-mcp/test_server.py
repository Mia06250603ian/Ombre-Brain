# ============================================================
# server.py 的单元测试（用假 IMAP 服务器，不碰真网络、不需要凭据）
#
# 跑法：python3 test_server.py
#
# 为什么要有这份：开发沙盒只放行走代理的 HTTPS，直连 993 端口是不通的
# （2026-08-06 实测 TimeoutError），所以**真实 IMAP 连通性只能等上线后验**。
# 但真正容易写错的其实不是网络那一下，是协议数据的解析：
# 邮件头解码、multipart 正文抽取、中文草稿箱名、PEEK 有没有带上……
# 这些全都能用假连接离线测，而且必须测——上线后再发现，代价是又一轮部署。
#
# 这里锁死的几条不变量，改 server.py 时别把它们弄坏：
#   1. 选邮箱必须 readonly=True     —— 否则晏一看信，佳佳手机上的未读就没了
#   2. 抓正文必须带 BODY.PEEK       —— 同上，两道保险
#   3. 草稿箱按 \Drafts 标记找       —— 中文账号叫「[Gmail]/草稿」，硬编码必挂
#   4. 安全类邮件在列表和正文两层都要拦
#   5. token 没配 = 全拒（不是开放）
# ============================================================

import sys
import os
import asyncio

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

os.environ.setdefault("GMAIL_TOKEN", "test-token")
os.environ.setdefault("GMAIL_ADDRESS", "test@example.com")
os.environ.setdefault("GMAIL_APP_PASSWORD", "test-password")

import server

_passed = 0
_failed = []


def check(name, got, want):
    global _passed
    if got == want:
        _passed += 1
    else:
        _failed.append(f"{name}\n    期望: {want!r}\n    实际: {got!r}")


def check_true(name, got):
    check(name, bool(got), True)


def check_false(name, got):
    check(name, bool(got), False)


# ============================================================
# 假 IMAP 服务器
# ============================================================

def _mail_bytes(sender, subject, date, body, content_type="text/plain"):
    return (
        f"From: {sender}\r\n"
        f"To: me@example.com\r\n"
        f"Subject: {subject}\r\n"
        f"Date: {date}\r\n"
        f"Content-Type: {content_type}; charset=utf-8\r\n"
        f"\r\n"
        f"{body}"
    ).encode("utf-8")


class FakeIMAP:
    """记录每一条被调用的命令，好在测试里断言「有没有带 PEEK」这类事。"""

    def __init__(self, mails=None, folders=None):
        self.mails = mails or {}          # uid(str) -> (flags, raw bytes)
        self.folders = folders or [
            b'(\\HasNoChildren) "/" "INBOX"',
            b'(\\HasNoChildren \\Drafts) "/" "[Gmail]/&g0l6Pw- "',
        ]
        self.commands = []
        self.selected = None
        self.select_readonly = None
        self.appended = []
        self.closed = False
        self.logged_out = False

    def select(self, mailbox="INBOX", readonly=True):
        self.selected = mailbox
        self.select_readonly = readonly
        return ("OK", [b"1"])

    def list(self):
        return ("OK", self.folders)

    def uid(self, cmd, *args):
        self.commands.append((cmd, args))
        if cmd == "SEARCH":
            if "UNSEEN" in args:
                uids = [u for u, (f, _) in self.mails.items() if "\\Seen" not in f]
            else:
                uids = list(self.mails.keys())
            return ("OK", [" ".join(sorted(uids)).encode()])
        if cmd == "FETCH":
            uid = args[0]
            uid = uid.decode() if isinstance(uid, bytes) else str(uid)
            spec = args[1]
            if uid not in self.mails:
                return ("NO", [None])
            flags, raw = self.mails[uid]
            if "HEADER.FIELDS" in spec:
                head = raw.split(b"\r\n\r\n")[0] + b"\r\n\r\n"
                return ("OK", [(f"{uid} (FLAGS ({flags}) BODY[HEADER]".encode(), head), b")"])
            return ("OK", [(f"{uid} (BODY[]".encode(), raw), b")"])
        return ("OK", [b""])

    def append(self, folder, flags, date, msg):
        self.appended.append((folder, flags, msg))
        return ("OK", [b"APPEND completed"])

    def close(self):
        self.closed = True

    def logout(self):
        self.logged_out = True


def use_fake(fake):
    """把 server._connect 换成返回假连接。"""
    server._connect = lambda: fake


# ============================================================
# 一、readonly + PEEK（这两条最要紧：晏读信不能影响佳佳的未读数）
# ============================================================

_normal = _mail_bytes("Tom <tom@example.com>", "周末吃饭吗", "Thu, 6 Aug 2026 10:00:00 +0800", "老地方见")
fake = FakeIMAP({"101": ("", _normal)})
use_fake(fake)

asyncio.run(server.list_mail(limit=5))
check("列表-select 用 readonly", fake.select_readonly, True)
_fetches = [a for c, a in fake.commands if c == "FETCH"]
check_true("列表-抓头部带 PEEK", all("BODY.PEEK" in a[1] for a in _fetches))

fake2 = FakeIMAP({"101": ("", _normal)})
use_fake(fake2)
asyncio.run(server.read_mail("101"))
check("读信-select 用 readonly", fake2.select_readonly, True)
_f2 = [a for c, a in fake2.commands if c == "FETCH"]
check_true("读信-抓正文带 PEEK", all("BODY.PEEK" in a[1] for a in _f2))
check_false("读信-不能出现裸 BODY[]", any(a[1] == "(BODY[])" for a in _f2))

# 连接必须被关掉，不能泄漏
check_true("用完关连接", fake2.closed and fake2.logged_out)


# ============================================================
# 二、列表渲染
# ============================================================

fake3 = FakeIMAP({
    "101": ("", _mail_bytes("Tom <tom@example.com>", "周末吃饭吗", "Thu, 6 Aug 2026 10:00:00 +0800", "老地方见")),
    "102": ("\\Seen", _mail_bytes("Amy <amy@example.com>", "排期确认", "Thu, 6 Aug 2026 11:00:00 +0800", "见附件")),
})
use_fake(fake3)
out = asyncio.run(server.list_mail(limit=10))

check_true("列表-有主题", "周末吃饭吗" in out)
check_true("列表-有发件人", "tom@example.com" in out)
check_true("列表-有 uid", "uid 101" in out)
check_true("列表-未读标记", "●" in out)
check_true("列表-已读标记", "○" in out)
check_true("列表-说明不影响未读", "不会把它变成已读" in out or "未读数不受影响" in out)

# 只看未读
use_fake(FakeIMAP({
    "101": ("", _mail_bytes("Tom", "未读的", "Thu, 6 Aug 2026", "x")),
    "102": ("\\Seen", _mail_bytes("Amy", "已读的", "Thu, 6 Aug 2026", "y")),
}))
out_unread = asyncio.run(server.list_mail(unread_only=True))
check_true("只看未读-含未读", "未读的" in out_unread)
check_false("只看未读-不含已读", "已读的" in out_unread)

# 空邮箱
use_fake(FakeIMAP({}))
check_true("空邮箱有话说", "一封都没有" in asyncio.run(server.list_mail()))


# ============================================================
# 三、安全类邮件：列表层和正文层都要拦
# ============================================================

_code_mail = _mail_bytes(
    "security@example.com", "您的验证码是 483920", "Thu, 6 Aug 2026 12:00:00 +0800", "5 分钟内有效"
)
use_fake(FakeIMAP({"201": ("", _code_mail)}))
out_sec = asyncio.run(server.list_mail())
check_false("安全邮件-列表不显示验证码", "483920" in out_sec)
check_true("安全邮件-列表有锁标记", "🔒" in out_sec)
check_true("安全邮件-列表说明已屏蔽", "已屏蔽" in out_sec)
check_true("安全邮件-仍占一行(不隐形)", "uid 201" in out_sec)
check_true("安全邮件-仍能看到发件人", "security@example.com" in out_sec)

use_fake(FakeIMAP({"201": ("", _code_mail)}))
read_sec = asyncio.run(server.read_mail("201"))
check_false("安全邮件-正文不给码", "483920" in read_sec)
check_true("安全邮件-正文说明是边界不是故障", "不是出故障" in read_sec)

# 主题人畜无害、码藏正文里的那种：列表可以显示主题，但正文必须拦住
_hidden = _mail_bytes(
    "notify@example.com", "来自某平台的通知", "Thu, 6 Aug 2026 12:00:00 +0800",
    "您的验证码是 771002，请勿告知他人",
)
use_fake(FakeIMAP({"202": ("", _hidden)}))
read_hidden = asyncio.run(server.read_mail("202"))
check_false("码藏正文-正文层拦住", "771002" in read_hidden)


# ============================================================
# 四、正文抽取
# ============================================================

use_fake(FakeIMAP({"301": ("", _mail_bytes("a@b.com", "普通信", "Thu, 6 Aug 2026", "第一行\n第二行"))}))
body_out = asyncio.run(server.read_mail("301"))
check_true("正文-内容在", "第一行" in body_out and "第二行" in body_out)
check_true("正文-有加壳", "不可信" in body_out)
check_true("正文-加壳点名不是佳佳说的", "不是佳佳说的话" in body_out)
check_true("正文-有发件人抬头", "发件人：" in body_out)
check_true("正文-有主题抬头", "主题：普通信" in body_out)

# HTML 邮件
_html_mail = _mail_bytes(
    "shop@example.com", "夏季新品", "Thu, 6 Aug 2026",
    "<html><style>p{color:red}</style><p>五折优惠</p><p>点击查看</p></html>",
    content_type="text/html",
)
use_fake(FakeIMAP({"302": ("", _html_mail)}))
html_out = asyncio.run(server.read_mail("302"))
check_true("HTML-转出正文", "五折优惠" in html_out)
check_false("HTML-不含标签", "<p>" in html_out)
check_false("HTML-不含 CSS", "color:red" in html_out)

# multipart：有纯文本就优先用纯文本
_multipart = (
    b"From: a@b.com\r\nTo: me@example.com\r\nSubject: \xe5\xa4\x9a\xe9\x83\xa8\xe5\x88\x86\r\n"
    b"Date: Thu, 6 Aug 2026\r\n"
    b'Content-Type: multipart/alternative; boundary="BOUND"\r\n\r\n'
    b"--BOUND\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n"
    b"\xe7\xba\xaf\xe6\x96\x87\xe6\x9c\xac\xe7\x89\x88\r\n"
    b"--BOUND\r\nContent-Type: text/html; charset=utf-8\r\n\r\n"
    b"<p>HTML\xe7\x89\x88</p>\r\n--BOUND--\r\n"
)
use_fake(FakeIMAP({"303": ("", _multipart)}))
mp_out = asyncio.run(server.read_mail("303"))
check_true("multipart-用纯文本那份", "纯文本版" in mp_out)

# 附件只报名字
_with_att = (
    b"From: a@b.com\r\nTo: me@example.com\r\nSubject: report\r\nDate: Thu, 6 Aug 2026\r\n"
    b'Content-Type: multipart/mixed; boundary="B"\r\n\r\n'
    b"--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n"
    b"see attached\r\n"
    b"--B\r\nContent-Type: application/pdf\r\n"
    b'Content-Disposition: attachment; filename="report.pdf"\r\n\r\n'
    b"%PDF-1.4 binary junk\r\n--B--\r\n"
)
use_fake(FakeIMAP({"304": ("", _with_att)}))
att_out = asyncio.run(server.read_mail("304"))
check_true("附件-报出文件名", "report.pdf" in att_out)
check_true("附件-说明读不了", "读不了" in att_out)
check_false("附件-不塞二进制内容", "%PDF" in att_out)

# uid 不存在
use_fake(FakeIMAP({}))
check_true("读信-uid 不存在有人话", "没找到" in asyncio.run(server.read_mail("999")))
check_true("读信-空 uid 有人话", "给个 uid" in asyncio.run(server.read_mail("")))


# ============================================================
# 五、草稿（含中文草稿箱名——硬编码 [Gmail]/Drafts 会挂在这条）
# ============================================================

fake_draft = FakeIMAP({})
use_fake(fake_draft)
draft_out = asyncio.run(server.save_draft("tom@example.com", "关于周末", "老地方见。"))

check("草稿-存了一封", len(fake_draft.appended), 1)
_folder, _flags, _msg = fake_draft.appended[0]
check("草稿-进的是中文草稿箱", _folder, "[Gmail]/&g0l6Pw- ")
check("草稿-带 Draft 标记", _flags, "\\Draft")
check_true("草稿-收件人写对", b"tom@example.com" in _msg)
check_true("草稿-正文写进去了", "老地方见".encode() in _msg)
check_true("草稿-回话提示让佳佳过目", "看一眼" in draft_out)
check_true("草稿-回话说明存哪了", "草稿存好了" in draft_out)

# 没有 \Drafts 标记的账号，回落默认名而不是崩掉
fake_nodraft = FakeIMAP({}, folders=[b'(\\HasNoChildren) "/" "INBOX"'])
use_fake(fake_nodraft)
asyncio.run(server.save_draft("a@b.com", "s", "b"))
check("草稿-找不到标记时回落", fake_nodraft.appended[0][0], "[Gmail]/Drafts")

# 参数校验
check_true("草稿-没收件人要问", "给个收件人" in asyncio.run(server.save_draft("", "s", "b")))
check_true("草稿-没主题要问", "主题空着" in asyncio.run(server.save_draft("a@b.com", "", "b")))


# ============================================================
# 六、搜索
# ============================================================

fake_s = FakeIMAP({"401": ("", _mail_bytes("Tom", "合同的事", "Thu, 6 Aug 2026", "见附件"))})
use_fake(fake_s)
s_out = asyncio.run(server.search_mail("合同"))
check_true("搜索-有结果", "合同的事" in s_out)
_search_args = [a for c, a in fake_s.commands if c == "SEARCH"]
check_true("搜索-带 UTF-8 字符集", any("UTF-8" in [str(x) for x in a] for a in _search_args))
check_true("搜索-中文以字节发出", any(isinstance(x, bytes) and "合同".encode() in x for a in _search_args for x in a))
check_true("搜索-空关键词要问", "给个关键词" in asyncio.run(server.search_mail("")))

# 搜索词里的引号必须转义，否则能把 IMAP 命令拼坏
check("搜索-转义引号", server._imap_quote('say "hi"'), b'"say \\"hi\\""')
check("搜索-转义反斜杠", server._imap_quote("a\\b"), b'"a\\\\b"')
check("搜索-中文编 UTF-8", server._imap_quote("合同"), '"合同"'.encode("utf-8"))


# ============================================================
# 七、上限与截断
# ============================================================

use_fake(FakeIMAP({str(i): ("", _mail_bytes("a@b.com", f"信{i}", "Thu, 6 Aug 2026", "x")) for i in range(100)}))
_out = asyncio.run(server.list_mail(limit=999))
check_true("上限-limit 被夹住", _out.count("uid ") <= server.MAX_LIST_LIMIT)
check("上限-clamp 下界", server._clamp(0, 1, 30), 1)
check("上限-clamp 上界", server._clamp(9999, 1, 30), 30)
check("上限-clamp 非数字", server._clamp("abc", 1, 30), 1)

_long = "字" * 60000
use_fake(FakeIMAP({"501": ("", _mail_bytes("a@b.com", "长信", "Thu, 6 Aug 2026", _long))}))
long_out = asyncio.run(server.read_mail("501"))
check_true("截断-长信被截", len(long_out) <= server.MAX_RESULT_CHARS + 200)
check_true("截断-说明被截了", "还有约" in long_out)


# ============================================================
# 八、鉴权（token 没配 = 全拒，不是开放）
# ============================================================

class FakeReq:
    def __init__(self, headers=None, query=None):
        self.headers = headers or {}
        self.query_params = query or {}


_saved_token = server.GMAIL_TOKEN

server.GMAIL_TOKEN = "secret"
check_true("鉴权-X-Token 正确放行", server._token_ok(FakeReq({"x-token": "secret"})))
check_true("鉴权-Bearer 正确放行", server._token_ok(FakeReq({"authorization": "Bearer secret"})))
check_true("鉴权-Bearer 大小写不敏感", server._token_ok(FakeReq({"authorization": "bearer secret"})))
check_true("鉴权-查询串放行", server._token_ok(FakeReq(query={"token": "secret"})))
check_false("鉴权-错的 token 拒绝", server._token_ok(FakeReq({"x-token": "wrong"})))
check_false("鉴权-没带 token 拒绝", server._token_ok(FakeReq()))
check_false("鉴权-空 token 拒绝", server._token_ok(FakeReq({"x-token": ""})))

server.GMAIL_TOKEN = ""
check_false("鉴权-服务端没配 token 时一律拒绝", server._token_ok(FakeReq({"x-token": "anything"})))
check_false("鉴权-没配时空请求也拒绝", server._token_ok(FakeReq()))

server.GMAIL_TOKEN = _saved_token


# ============================================================
# 九、没有发送能力（这条是设计核心，用 AST 验，不靠肉眼）
# ============================================================

import ast

_tree = ast.parse(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.py")).read())
_imports = set()
for _n in ast.walk(_tree):
    if isinstance(_n, ast.Import):
        for _a in _n.names:
            _imports.add(_a.name.split(".")[0])
    elif isinstance(_n, ast.ImportFrom):
        if _n.module:
            _imports.add(_n.module.split(".")[0])

check_false("没有发送能力-没 import smtplib", "smtplib" in _imports)
check_false("没有发送能力-没 import aiosmtplib", "aiosmtplib" in _imports)

_tool_names = [t.name for t in asyncio.run(server.mcp.list_tools())]
check("工具正好四个", len(_tool_names), 4)
check("工具名单", sorted(_tool_names), ["list_mail", "read_mail", "save_draft", "search_mail"])
check_false("没有 send 工具", any("send" in n for n in _tool_names))


# ============================================================
# 结果
# ============================================================

print()
if _failed:
    print(f"❌ {len(_failed)} 项失败 / 共 {_passed + len(_failed)} 项\n")
    for f in _failed:
        print("  - " + f)
    sys.exit(1)
else:
    print(f"✅ 全绿：{_passed} 项")
    sys.exit(0)

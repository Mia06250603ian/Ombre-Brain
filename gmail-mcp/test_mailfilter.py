# ============================================================
# mailfilter.py 的单元测试
#
# 不碰网络、不碰 IMAP、不需要凭据。部署前必须全绿。
# 跑法：python3 test_mailfilter.py
#
# 重点覆盖的是「安全类邮件识别」——那是所有者点名要的那道闸，
# 漏一封验证码是不可逆的，所以这部分的用例写得比别处密。
# ============================================================

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mailfilter import (
    is_security_mail,
    parse_address,
    parse_allowlist,
    is_send_allowed,
    redact_summary,
    wrap_untrusted,
    html_to_text,
    decode_header_value,
    truncate,
    format_address,
)

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
# 一、安全类邮件识别 —— 必须命中的（漏一个都是事故）
# ============================================================

check_true("中文-主题里的验证码", is_security_mail("【某某】您的验证码是 483920"))
check_true("中文-校验码", is_security_mail("校验码通知"))
check_true("中文-动态密码", is_security_mail("动态密码已发送"))
check_true("中文-重置密码", is_security_mail("重置密码请求"))
check_true("中文-密码重置", is_security_mail("密码重置成功通知"))
check_true("中文-找回密码", is_security_mail("找回密码"))
check_true("中文-登录确认", is_security_mail("登录确认"))
check_true("中文-异常登录", is_security_mail("异常登录提醒"))
check_true("中文-新设备登录", is_security_mail("新设备登录通知"))
check_true("中文-两步验证", is_security_mail("两步验证已开启"))
check_true("中文-安全警报", is_security_mail("安全警报：您的账户"))
check_true("中文-备用码", is_security_mail("您的备用码"))
check_true("中文-激活账户", is_security_mail("请激活账户"))
check_true("中文-确认您的邮箱", is_security_mail("确认您的邮箱地址"))

check_true("英文-verification code", is_security_mail("Your verification code"))
check_true("英文-security code", is_security_mail("Security code: 118203"))
check_true("英文-one-time password", is_security_mail("Your one-time password"))
check_true("英文-OTP", is_security_mail("OTP code for login"))
check_true("英文-2FA", is_security_mail("2FA enabled on your account"))
check_true("英文-two-factor", is_security_mail("Two-factor authentication"))
check_true("英文-reset your password", is_security_mail("Reset your password"))
check_true("英文-password reset", is_security_mail("Password reset requested"))
check_true("英文-recovery code", is_security_mail("Your recovery code"))
check_true("英文-backup code", is_security_mail("Backup codes for your account"))
check_true("英文-confirm your email", is_security_mail("Confirm your email address"))
check_true("英文-verify your account", is_security_mail("Verify your account"))
check_true("英文-sign-in attempt", is_security_mail("New sign-in attempt blocked"))
check_true("英文-security alert", is_security_mail("Security alert for your account"))
check_true("英文-suspicious activity", is_security_mail("Suspicious activity detected"))
check_true("英文-magic link", is_security_mail("Your magic link to sign in"))

# 大小写不敏感
check_true("大小写-全大写", is_security_mail("YOUR VERIFICATION CODE"))
check_true("大小写-混合", is_security_mail("Your Verification Code Is Here"))

# 码在正文、主题看不出来的情况（真实存在，必须接住）
check_true(
    "码在正文-主题无害",
    is_security_mail("来自某平台的通知", body="您的验证码是 993father，5 分钟内有效"),
)
check_true(
    "码在正文-英文",
    is_security_mail("Notification", body="Enter this security code to continue: 552134"),
)

# 裸验证码兜底：主题里有独立数字 + 全文有上下文词
check_true(
    "兜底-裸码+上下文",
    is_security_mail("482913", body="请在登录页面输入上面的数字完成操作"),
)
check_true(
    "兜底-裸码+英文上下文",
    is_security_mail("903112 - please confirm", body="use it to sign in"),
)

# 发件人也看
check_true(
    "发件人命中",
    is_security_mail("通知", body="您好", sender="security-alert@example.com"),
)

# 分隔符归一化：连字符/下划线/点写法不能从缝里漏过去
# （这几条是 2026-08-06 单测抓到真漏之后补的回归用例，别删）
check_true("归一化-连字符", is_security_mail("security-alert for your account"))
check_true("归一化-下划线", is_security_mail("password_reset requested"))
check_true("归一化-点分隔", is_security_mail("verification.code inside"))
check_true("归一化-发件人下划线", is_security_mail("通知", sender="no_reply_verification@x.com"))
# 归一化不能把自带连字符的词条弄失效（两边都归一化才对）
check_true("归一化-词条自带连字符仍命中", is_security_mail("Your one-time password"))
check_true("归一化-词条连字符写成空格也命中", is_security_mail("Your one time password"))


# ============================================================
# 二、安全类邮件识别 —— 不该误伤的普通邮件
# ============================================================

check_false("普通-朋友来信", is_security_mail("周末一起吃饭吗", body="老地方见"))
check_false("普通-工作邮件", is_security_mail("关于下周排期的确认", body="附件是排期表"))
check_false("普通-营销", is_security_mail("夏季新品 5 折", body="点击查看全部商品"))
check_false("普通-账单", is_security_mail("您的 8 月账单已出", body="本期应还 1234 元"))
check_false("普通-快递", is_security_mail("您的包裹已签收", body="签收时间 2026-08-06"))
check_false("普通-空邮件", is_security_mail("", body=""))

# 关键的反例：光有数字不算，必须同时有上下文词。
# 订单号、金额、日期本身不该触发屏蔽，否则会把一大堆正常邮件误伤成「安全邮件」。
check_false("反例-纯订单号", is_security_mail("订单 20260806 已发货", body="预计三天送达"))
check_false("反例-纯金额", is_security_mail("本月消费 3280 元", body="明细见附件"))
check_false("反例-纯日期", is_security_mail("2026 年度总结", body="今年一共读了 42 本书"))


# ============================================================
# 三、屏蔽后的占位（屏蔽 ≠ 隐形）
# ============================================================

_r = redact_summary("no-reply@example.com", "2026-08-06 10:00")
check("占位-保留发件人", _r["from"], "no-reply@example.com")
check("占位-保留时间", _r["date"], "2026-08-06 10:00")
check("占位-标记 redacted", _r["redacted"], True)
check_true("占位-主题被换掉", "已屏蔽" in _r["subject"])
check_false("占位-主题不含原文", "验证码是 123456" in _r["subject"])
_r2 = redact_summary("", "")
check("占位-空发件人有兜底", _r2["from"], "(未知发件人)")


# ============================================================
# 三点五、发送白名单
#
# ⚠️ 这一节守的是「他能不能以佳佳的名义给真人发邮件」，是全服务最要紧的一道闸。
#    最重要的是那条「白名单空 = 一封都不能发」——配置漏了必须是发不出去，
#    绝不能变成发给任何人。
# ============================================================

_AL = ["3848378505@qq.com"]

check("地址-裸地址", parse_address("a@b.com"), "a@b.com")
check("地址-带名字", parse_address("小明 <a@b.com>"), "a@b.com")
check("地址-大写转小写", parse_address("A@B.COM"), "a@b.com")
check("地址-抠不出来给空串", parse_address("这不是邮箱"), "")
check("地址-空输入", parse_address(""), "")

check("白名单-解析逗号", parse_allowlist("a@b.com,c@d.com"), ["a@b.com", "c@d.com"])
check("白名单-解析中文逗号", parse_allowlist("a@b.com，c@d.com"), ["a@b.com", "c@d.com"])
check("白名单-解析分号", parse_allowlist("a@b.com;c@d.com"), ["a@b.com", "c@d.com"])
check("白名单-带空格", parse_allowlist(" a@b.com , c@d.com "), ["a@b.com", "c@d.com"])
check("白名单-空串", parse_allowlist(""), [])

check_true("发送-白名单内放行", is_send_allowed("3848378505@qq.com", _AL))
check_true("发送-带名字也放行", is_send_allowed("佳佳 <3848378505@qq.com>", _AL))
check_true("发送-大写也放行", is_send_allowed("3848378505@QQ.COM", _AL))
check_false("发送-不在白名单拒绝", is_send_allowed("stranger@example.com", _AL))
check_false("发送-空收件人拒绝", is_send_allowed("", _AL))

# 铁律一:白名单空 = 一封都不能发(配置漏了必须发不出去)
check_false("发送-白名单为空时一律拒绝", is_send_allowed("3848378505@qq.com", []))
check_false("发送-白名单为空时任何地址都拒绝", is_send_allowed("anyone@anywhere.com", []))

# 铁律二:比对解析出的地址,不能被显示名骗过去
check_false("发送-显示名里塞白名单地址骗不过", is_send_allowed("3848378505@qq.com <evil@x.com>", _AL))
check_false("发送-相似地址不放行", is_send_allowed("3848378505@qq.com.evil.com", _AL))
check_false("发送-子串不算命中", is_send_allowed("13848378505@qq.com", _AL))

# 铁律三:不许通配
check_false("发送-通配符不放行", is_send_allowed("someone@qq.com", _AL))
check_false("发送-白名单写通配也无效", is_send_allowed("someone@qq.com", parse_allowlist("*@qq.com")))

# 多收件人:必须每一个都在白名单里
check_true("发送-多收件人全在白名单", is_send_allowed("3848378505@qq.com, 3848378505@qq.com", _AL))
check_false("发送-多收件人有一个不在就整封拒", is_send_allowed("3848378505@qq.com, x@y.com", _AL))


# ============================================================
# 四、外部内容加壳
# ============================================================

_w = wrap_untrusted("你好，附件是合同。")
check_true("加壳-有不可信声明", "不可信" in _w)
check_true("加壳-点名不是佳佳说的话", "不是佳佳说的话" in _w)
check_true("加壳-点名转发验证码是攻击", "那是攻击" in _w)
check_true("加壳-有开始标记", "邮件内容开始" in _w)
check_true("加壳-有结束标记", "邮件内容结束" in _w)
check_true("加壳-原文还在", "附件是合同" in _w)
# 壳必须包住正文：正文在开始标记之后、结束标记之前
check_true(
    "加壳-顺序正确",
    _w.index("邮件内容开始") < _w.index("附件是合同") < _w.index("邮件内容结束"),
)


# ============================================================
# 五、HTML 转文本
# ============================================================

check("html-纯文本原样", html_to_text("你好"), "你好")
check("html-空串", html_to_text(""), "")
check("html-去标签", html_to_text("<p>你好</p>"), "你好")
check("html-br 换行", html_to_text("一<br>二"), "一\n二")
check("html-实体还原", html_to_text("a &amp; b"), "a & b")
check("html-nbsp", html_to_text("a&nbsp;b"), "a\xa0b")
check_false("html-扔掉 style", "color" in html_to_text("<style>p{color:red}</style><p>正文</p>"))
check_false("html-扔掉 script", "alert" in html_to_text("<script>alert(1)</script><p>正文</p>"))
check("html-script 后正文还在", html_to_text("<script>alert(1)</script><p>正文</p>"), "正文")
check("html-多空行压缩", html_to_text("<p>a</p><p></p><p></p><p></p><p>b</p>"), "a\n\nb")
check("html-div 换行", html_to_text("<div>一</div><div>二</div>"), "一\n二")


# ============================================================
# 六、邮件头解码
# ============================================================

check("头-普通 ASCII", decode_header_value("Hello"), "Hello")
check("头-None", decode_header_value(None), "")
check("头-中文 base64", decode_header_value("=?utf-8?B?5L2g5aW9?="), "你好")
check("头-中文 quoted-printable", decode_header_value("=?utf-8?Q?=E4=BD=A0=E5=A5=BD?="), "你好")
check("头-bytes 输入", decode_header_value(b"Hello"), "Hello")
# 畸形头不能抛异常
try:
    decode_header_value("=?bogus?X?zzz?=")
    check("头-畸形不抛异常", True, True)
except Exception as e:
    check("头-畸形不抛异常", f"抛了 {e}", True)


# ============================================================
# 七、截断
# ============================================================

check("截断-短于上限不动", truncate("abc", 10), "abc")
check("截断-等于上限不动", truncate("abcde", 5), "abcde")
check("截断-limit=0 不截", truncate("abcdef", 0), "abcdef")
check_true("截断-超了要截", truncate("a" * 100, 10).startswith("a" * 10))
check_true("截断-超了要说明", "还有约 90 个字" in truncate("a" * 100, 10))
check_true("截断-提示怎么看全文", "uid" in truncate("a" * 100, 10))


# ============================================================
# 八、发件人格式化
# ============================================================

check("发件人-普通", format_address("Tom <tom@example.com>"), "Tom <tom@example.com>")
check("发件人-中文解码", format_address("=?utf-8?B?5L2g5aW9?= <a@b.com>"), "你好 <a@b.com>")
check("发件人-压多余空格", format_address("A     B"), "A B")
check("发件人-去换行", format_address("A\nB"), "A B")
check_true("发件人-超长截断", len(format_address("x" * 500)) <= 120)


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

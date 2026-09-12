#!/usr/bin/env python3
# get-token.py —— 取一把新的 Claude 长期令牌(一年期),给「直连」那条链路用。
#
# **什么时候用**:第一次切直连时,以及以后每年换一次令牌时。
# **谁跑**:会话(在自己的容器里跑)。⚠️ **所有者只有手机、没有电脑,别叫她自己跑命令。**
# 她要做的只有一步:点开链接、在手机上点同意、把回来的那串码发回来。
#
# ⚠️ **必须和「把令牌写进 Zeabur」放在同一次会话** —— 令牌只显示一次,会话容器是一次性的。
# ⚠️ **令牌全程不要打印、不要 cat、不要贴进对话**;写进 Zeabur 用 "$(cat $TOKEN_WORKDIR/token.txt)",输出丢 /dev/null。
#
# 正文照抄 `../docs/直连改造-教程原文.md` 第 4.2 节,**那是踩了三轮才跑通的版本,别自己重写**。
# 四个坑见该文 4.4,最贵的一条:用正则剥转义码读屏**会吞字符** → 令牌少几个字 → 401,
# 而它只显示一次,等于那次授权当场作废、所有者得重点一遍链接。**所以必须用 pyte。**
#
# 用法(完整流程与两项自检见教程 4.2 / 4.3,**自检别跳**):
#   pip install pyte
#   export TOKEN_WORKDIR=$(mktemp -d)          # 不设就自动开一个临时目录,启动时会打印出来
#   python3 scripts/get-token.py &
#   grep -o 'https://claude\.com/cai/oauth/authorize?[^ ]*' "$TOKEN_WORKDIR/screen.txt" | head -1
#   # ↑ 这条链接发给所有者,她在手机上点同意,把回来的那串码发回来
#   # ⚠️ 投真码之前先做教程 4.3 的两项自检(屏幕还原忠实 + 假码试通路)
#   { echo "TYPE:<她发回来的那串码>"; echo "ENTER"; } >> "$TOKEN_WORKDIR/keys.txt"
#   [ -f "$TOKEN_WORKDIR/token.txt" ] && echo "长度 $(wc -c < "$TOKEN_WORKDIR/token.txt")"
#   # ↑ 只看长度,别打印内容;接着直接 variable update ... ="$(cat $TOKEN_WORKDIR/token.txt)"
# 依赖: pip install pyte     ← 关键,别省,原因见 4.4
import os, pty, re, select, time, fcntl, termios, struct, tempfile
import pyte

# ⚠️ **这一行是仓库这边相对教程原文唯一改动的地方,别改回去。**
# 原文是 `D = os.path.dirname(os.path.abspath(__file__))` —— 那会把 `token.txt`(**真令牌**)
# 写进仓库工作区,一次手滑 `git add -A` 就提交上去了。
# 改成**默认写进临时目录**,要放别处就设 `TOKEN_WORKDIR`。(根 `.gitignore` 里另有一道兜底闸。)
D = os.environ.get("TOKEN_WORKDIR") or tempfile.mkdtemp(prefix="claude-token-")
print("[get-token] 工作目录:", D)      # 只打印目录,**永远不打印令牌本身**
KEYS   = D + "/keys.txt"      # 指令输入:每行 "TYPE:xxx" 或 "ENTER"
TOKEN  = D + "/token.txt"     # 成功后令牌写在这里(权限 600)
SCREEN = D + "/screen.txt"    # 实时还原出来的屏幕,用来抠授权链接
COLS, ROWS = 220, 60          # 开宽,避免 URL 被折行

pid, fd = pty.fork()
if pid == 0:                                   # 子进程
    os.environ["TERM"] = "xterm-256color"
    os.environ["COLUMNS"], os.environ["LINES"] = str(COLS), str(ROWS)
    os.execvp("claude", ["claude", "setup-token"])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
screen = pyte.Screen(COLS, ROWS)
stream = pyte.ByteStream(screen)

n, deadline = 0, time.time() + 2400
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.4)
    if r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        stream.feed(data)
        text = "\n".join(screen.display)
        open(SCREEN, "w").write(text)
        m = re.search(r'sk-ant-oat[A-Za-z0-9_\-]+', text.replace("\n", ""))
        if m:
            old = os.umask(0o077)
            open(TOKEN, "w").write(m.group(0))
            os.umask(old)
            break
    if os.path.exists(KEYS):
        for line in open(KEYS).read().splitlines()[n:]:
            n += 1
            if line.startswith("TYPE:"):
                os.write(fd, line[5:].encode())
            elif line == "ENTER":
                os.write(fd, b"\r")      # ← 必须延迟、单独发,原因见 4.4
            time.sleep(0.4)

try:
    os.kill(pid, 15)
except Exception:
    pass

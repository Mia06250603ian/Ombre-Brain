# ============================================================
# fishing-mcp — 钓鱼小游戏的 MCP 包装服务
#
# 引擎来自 https://github.com/tutusagi/ai-fishing-game(盲玩版 fishing.py,
# vendored 自 commit 39f79d1,PolyForm Noncommercial 1.0.0,见同目录 LICENSE)。
# 本文件只做一层 streamable-http MCP 包装,供 kelivo-shim 的常驻 claude
# 进程作为远端 MCP 调用。技术栈与 Ombre Brain 的 server.py 一致(FastMCP)。
#
# 端点:
#   /mcp     — MCP streamable-http(工具 play / new_game)
#   /health  — 存活检查
#   /save    — 存档备份/恢复(需 ?key=<FISHING_KEY>;不设 FISHING_KEY=端点关闭)
#
# 环境变量:
#   PORT             监听端口(Zeabur 注入;默认 8000)
#   FISHING_DATA_DIR 存档目录(挂了持久卷就指过去;默认引擎同目录,重启会丢)
#   FISHING_KEY      /save 端点口令
# ============================================================

import json
import logging
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fishing  # 盲玩版引擎:只用 cmd()/new_game(),不解码 _BLOB(防剧透)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("fishing-mcp")

# 存档默认落在引擎同目录(容器内 = 重启即丢)。设 FISHING_DATA_DIR 可挪到持久卷。
# fishing._SAVE 是模块级全局,_load/_save 调用时才读它,导入后改是安全的。
DATA_DIR = os.environ.get("FISHING_DATA_DIR", "").strip()
if DATA_DIR:
    os.makedirs(DATA_DIR, exist_ok=True)
    fishing._SAVE = os.path.join(DATA_DIR, "fishing_save.json")
logger.info("save file: %s", fishing._SAVE)

from mcp.server.fastmcp import FastMCP
from starlette.responses import JSONResponse, PlainTextResponse

PORT = int(os.environ.get("PORT", "8000"))
FISHING_KEY = os.environ.get("FISHING_KEY", "")

mcp = FastMCP("fishing", host="0.0.0.0", port=PORT)

# 引擎非线程安全(模块级状态 + 存档文件),串行化所有调用
_lock = threading.Lock()


@mcp.tool()
def play(command: str = "") -> str:
    """文字钓鱼游戏,你是玩家:买饵 → cast 抛竿(核心)→ 按稀有度钓上各种鱼 → sell 卖鱼换点数 → 解锁新水域 → 集图鉴。每个地点+季节出的鱼不同、季节随抛竿推进;抛竿偶遇漂流瓶/宝箱/宝物和幸运时刻;买氧气瓶(buy oxygen)后可 dive 潜水远征,捕水面钓不到的水下鱼,途中遇「大遗迹」暂停时用 choose 抉择、surface 上岸。

    command 传指令文字。常用:help(规则)· status · shop(饵单)· buy <饵id> [数量] · cast [饵id] [次数] [stop=new,rare,event](连钓 N 竿只回一份汇总——想连钓用它,别一竿一条发)· dive [瓶数] · choose <编号> · surface · goto(不填=列所有钓点,填 id=前往)· inventory · sell <实例id|all|species <鱼id>|item <物品id>> · open <宝箱uid> · encyclopedia(图鉴)· look <id或中文名>。

    用 ; 把多条指令串成一批一次跑(最多 8 条,最省来回),如 "buy basic_worm 10; cast 10"、"goto reed_river; cast 8 stop=new"。每次返回末尾有一行 📊 状态栏 JSON(点数/地点/季节/回合/图鉴/余饵/渔获),看它就够,不必反复 status。command 不填=看规则。进度存在服务端,不占对话上下文。"""
    with _lock:
        return fishing.cmd(command)


@mcp.tool()
def new_game(seed: int = 0) -> str:
    """重开一局钓鱼——会清掉当前全部进度(点数/图鉴/渔获)!确认真的要重开再调。seed 不填=默认种子;同种子+同指令序列结果完全一致。"""
    with _lock:
        return fishing.new_game(seed) if seed else fishing.new_game()


@mcp.custom_route("/health", methods=["GET"])
async def health(request):
    return JSONResponse({"ok": True, "save_exists": os.path.exists(fishing._SAVE)})


@mcp.custom_route("/save", methods=["GET", "POST"])
async def save(request):
    """存档备份/恢复:重要进度可 GET 拷走,容器重启丢档后 POST 灌回去。"""
    if not FISHING_KEY or request.query_params.get("key") != FISHING_KEY:
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    if request.method == "GET":
        if not os.path.exists(fishing._SAVE):
            return JSONResponse({"error": "no save yet"}, status_code=404)
        with _lock, open(fishing._SAVE, "r", encoding="utf-8") as f:
            return PlainTextResponse(f.read(), media_type="application/json")
    body = await request.body()
    try:
        json.loads(body)
    except Exception as e:
        return JSONResponse({"error": f"not valid json: {e}"}, status_code=400)
    with _lock:
        with open(fishing._SAVE, "w", encoding="utf-8") as f:
            f.write(body.decode("utf-8"))
        fishing.S = None  # 引擎在内存缓存状态,置空强制下次 cmd() 从盘上重读
    return JSONResponse({"ok": True})


if __name__ == "__main__":
    import uvicorn

    app = mcp.streamable_http_app()
    logger.info("fishing-mcp listening on :%d (/mcp)", PORT)
    uvicorn.run(app, host="0.0.0.0", port=PORT)

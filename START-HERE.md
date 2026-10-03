# START-HERE:这个仓库只有 OB 记忆库

**2026-10-03 起这套系统分两个仓库**(所有者拍板「OB 一个,其余一个」):

| 仓库 | 里面是什么 |
|---|---|
| **`Ombre-Brain`(本仓库)** | **OB 记忆库**(Python/FastMCP)。Zeabur 从 main 拉、每日备份、CI、**每小时体检**(`.github/workflows/healthcheck.yml`,它也巡晏和 TG 桥)都在这里 |
| **`Mia06250603ian/rivers-system`(私有)** | 晏本体(`rivers-system/kelivo-shim/`)、TG / iMessage / dwell 三个桥、gmail、飞行棋、维护工位,**以及全系统的运维手册**:`START-HERE.md`(地图 + 三条铁规矩)、`OPERATIONS.md`、`TIMELINE.md` |

**新会话两个仓库都挂上,从 `rivers-system` 的 `START-HERE.md` 读起** —— 三条铁规矩、开场指令都在那边。
**只改 OB** → 读本仓库的 `INTERNALS.md`;但 OB⇄晏 的事(自动浮现、归档桶、体检)两边都要看。

本仓库文档里写成 `rivers-system/xxx` 的路径都在那个仓库。
⚠️ **`dashboard.html` 第 28、435 行和 `server.py` 里的注释提到 `OPERATIONS.md` / `dwell-bridge/` / `kelivo-shim` 时没加前缀** —— 拆仓库那天**刻意没改**:改这两个文件会触发 Zeabur 重建 OB(监控路径)。它们指的也都在 `rivers-system`;下次本来就要改这两个文件时顺手补上。2026-10-03 之前的改动历史(含晏那边的)仍在本仓库的提交记录里。

⚙️ **`.claude/`(会话连记忆库的设置 + 开场钩子)在 `rivers-system` 有一份逐字相同的副本**,改一份就把另一份也改了。

⚠️ **别把本仓库直接改成公开**:旧提交历史里有全部运维细节(服务地址、部署记录)。真要公开 OB,另开一个干净仓库(见 `rivers-system/OPERATIONS.md` 第 10 节)。

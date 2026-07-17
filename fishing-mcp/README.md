# fishing-mcp — 钓鱼小游戏 MCP 服务

给晏玩的文字钓鱼游戏。引擎来自 [tutusagi/ai-fishing-game](https://github.com/tutusagi/ai-fishing-game)
(盲玩版 `fishing.py`,vendored 自 commit `39f79d1`,PolyForm Noncommercial 1.0.0,见 `LICENSE`;
本项目为个人非商业用途)。本目录只是一层 ~100 行的 streamable-http MCP 包装,
技术栈与 Ombre Brain 一致(Python `mcp` 包 FastMCP)。

## 工具

- `play(command)` — 游戏唯一入口,传指令文字(`cast 10`、`buy basic_worm 10; cast 10`…)。
  引擎确定性(同种子+同指令=同结果)、返回自带 📊 状态栏,进度存服务端不占对话上下文。
- `new_game(seed)` — 重开一局(清进度,慎用)。

## 端点

- `POST /mcp` — MCP streamable-http
- `GET /health` — `{"ok":true,"save_exists":...}`
- `GET/POST /save?key=<FISHING_KEY>` — 存档备份/恢复(不设 FISHING_KEY 则关闭)

## 环境变量

| 变量 | 说明 |
|---|---|
| PORT | 监听端口,Zeabur 自动注入,默认 8000 |
| FISHING_DATA_DIR | 存档目录;不设=引擎同目录(**容器重启/重部署丢进度**,重要进度先 GET /save 备份) |
| FISHING_KEY | /save 端点口令,值不入库 |

## 本地测试

```bash
pip install -r requirements.txt
python test_server.py   # 起真服务跑 MCP 握手/工具调用/存档恢复,全绿再部署
```

## 部署(Zeabur)

在 `fishing-mcp/` 目录下 `npx -y zeabur@latest deploy`(dockerfile 构建)。
接到 shim:mcp-servers.json 加 `fishing` 条目 + ALLOWED_TOOLS 加 `mcp__fishing`,
两样缺一不可,详见 `../kelivo-shim/MAINTENANCE.md`。

## 升级引擎

上游出新版后:拷新的 `fishing.py` 进来即可(接口就 `cmd`/`new_game` 两个,稳定)。
注意存档兼容性看上游 CHANGELOG。

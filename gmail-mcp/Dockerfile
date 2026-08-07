# ============================================================
# gmail-mcp 镜像
#
# 构建：docker build -t gmail-mcp .
# 跑：  docker run -e GMAIL_ADDRESS=… -e GMAIL_APP_PASSWORD=… -e GMAIL_TOKEN=… -p 8040:8040 gmail-mcp
#
# ⚠️ 凭据一个都不写进镜像，全走环境变量（Zeabur 面板）。
#    这份 Dockerfile 是入库的，任何写进来的密钥都等于公开。
# ============================================================

FROM python:3.12-slim

WORKDIR /app

# 先装依赖，利用 Docker 缓存
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 只拷这三个 .py。测试文件也拷进去是有意的：
# 出问题时可以直接进容器 `python test_mailfilter.py` 验证过滤逻辑没坏，
# 不用重新构建（它不碰网络、不碰凭据，跑一次几十毫秒）。
COPY server.py mailfilter.py test_mailfilter.py ./

# 没有持久卷：这个服务不存任何东西。邮件在 Gmail 上，草稿也在 Gmail 上。
# 容器是无状态的，随便重启。

ENV GMAIL_PORT=8040
EXPOSE 8040

CMD ["python", "server.py"]

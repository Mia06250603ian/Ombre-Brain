#!/usr/bin/env bash
export DEBIAN_FRONTEND=noninteractive

# claude-code 包构建期已装,但原生二进制被 npm allowScripts 拦掉了,手动补(重试防网络抖)
CC_PKG="/src/node_modules/@anthropic-ai/claude-code"
[ -d "$CC_PKG" ] || CC_PKG="$(npm root -g)/@anthropic-ai/claude-code"
export CLAUDE_BIN="$CC_PKG/bin/claude.exe"
for i in 1 2 3 4 5; do
  if "$CLAUDE_BIN" --version >/dev/null 2>&1; then break; fi
  echo "[entrypoint] fetching claude native binary (attempt $i)..."
  (cd "$CC_PKG" && node install.cjs) || true
  sleep 3
done

unset ANTHROPIC_API_KEY   # 订阅通道必须赢

# MCP 配置(没有就生成个空的;要挂记忆/工具就写进来)
if [ ! -f .mcp.json ]; then
  echo '{ "mcpServers": {} }' > .mcp.json
fi

# 信任工作目录,让 CLAUDE.md 干净加载
printf '%s' '{"hasCompletedOnboarding":true,"projects":{"/src":{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true}}}' > "${HOME:-/root}/.claude.json"

exec node server.js

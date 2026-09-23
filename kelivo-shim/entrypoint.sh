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

# 双引擎(2026-09-23):第二份新版 CLI(package.json 里的 claude-code-next 别名),只给
# NEXT_CLI_MODELS 点名的模型(默认 5.5)用,见 cli-bin.mjs。两份各带各的原生二进制
# (npm 会把新版的那份嵌在 claude-code-next/node_modules 底下),互不干扰。
# **真能跑才导出 CLAUDE_BIN_NEXT**;装不上就不导出 —— shim 会把 5.5 从菜单拿掉、4.6 照常,
# 绝不会因为它起不来。看门狗读 /health 的 cliNext 发现它不在。
CC_NEXT="/src/node_modules/claude-code-next"
if [ -d "$CC_NEXT" ]; then
  for i in 1 2 3 4 5; do
    if "$CC_NEXT/bin/claude.exe" --version >/dev/null 2>&1; then break; fi
    echo "[entrypoint] fetching claude-next native binary (attempt $i)..."
    (cd "$CC_NEXT" && node install.cjs) || true
    sleep 3
  done
  if "$CC_NEXT/bin/claude.exe" --version; then export CLAUDE_BIN_NEXT="$CC_NEXT/bin/claude.exe"
  else echo "[entrypoint] WARNING: claude-next not runnable, next-only models dropped from menu"; fi
fi

unset ANTHROPIC_API_KEY   # 订阅通道必须赢

# MCP 配置(没有就生成个空的;要挂记忆/工具就写进来)
if [ ! -f .mcp.json ]; then
  echo '{ "mcpServers": {} }' > .mcp.json
fi

# 信任工作目录,让 CLAUDE.md 干净加载
printf '%s' '{"hasCompletedOnboarding":true,"projects":{"/src":{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true}}}' > "${HOME:-/root}/.claude.json"

exec node server.js

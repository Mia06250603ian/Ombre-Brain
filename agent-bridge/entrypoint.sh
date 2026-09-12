#!/usr/bin/env bash
# 照 ../kelivo-shim/entrypoint.sh 的形状来(那套在线上跑了两个月,别另发明)。
export DEBIAN_FRONTEND=noninteractive

# claude-code 包构建期已装,但原生二进制被 npm allowScripts 拦掉了,手动补(重试防网络抖)
CC_PKG="/src/node_modules/@anthropic-ai/claude-code"
[ -d "$CC_PKG" ] || CC_PKG="$(npm root -g)/@anthropic-ai/claude-code"
export CLAUDE_BIN="${CLAUDE_BIN:-$CC_PKG/bin/claude.exe}"
for i in 1 2 3 4 5; do
  if "$CLAUDE_BIN" --version >/dev/null 2>&1; then break; fi
  echo "[entrypoint] fetching claude native binary (attempt $i)..."
  (cd "$CC_PKG" && node install.cjs) || true
  sleep 3
done

unset ANTHROPIC_API_KEY   # 订阅通道必须赢(server.mjs 里还会再删一次给子进程的那份,两处都留着)

# git 要能提交:身份随便设,提交署名以 co-author 为准
git config --global user.email "agent@yan-system.local" 2>/dev/null || true
git config --global user.name "agent-bridge" 2>/dev/null || true
git config --global --add safe.directory '*' 2>/dev/null || true

# 信任工作目录,让仓库里的 CLAUDE.md / 技能干净加载
# ⚠️ 这里信任的是 WORK_DIR 下那份 clone,**不是 /src**(/src 是本服务自己的代码)
printf '%s' '{"hasCompletedOnboarding":true}' > "${HOME:-/root}/.claude.json"

exec node server.mjs

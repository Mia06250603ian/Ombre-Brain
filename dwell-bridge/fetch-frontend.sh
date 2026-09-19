#!/bin/sh
# 从 dwell 仓库拉一份前端进 web/，并删掉那段「演示模式」拦截器。
#
# 为什么不把 index.html 存进本仓库：那就成了两份同样的东西，
# 日久必然一边改一边不改（手册里那句「东西在 dwell 里了，别留两份」）。
# 唯一可信源是 dwell 仓库，这里只在部署前拉一次。
#
# 用法：./fetch-frontend.sh [分支名，默认 main]

set -e
BRANCH="${1:-main}"
SRC="https://raw.githubusercontent.com/Mia06250603ian/dwell-on-something/${BRANCH}/web/index.html"
OUT="$(dirname "$0")/web/index.html"

mkdir -p "$(dirname "$OUT")"
echo "拉取 ${BRANCH} 的前端…"
curl -fsSL "$SRC" -o "$OUT.raw"

# 删掉演示拦截块（逻辑和护栏都在 strip-demo.mjs 里，有单测）
node "$(dirname "$0")/strip-demo.mjs" "$OUT.raw" "$OUT"

rm -f "$OUT.raw"

# 桌面图标与 manifest。index.html 的 <head> 早就引用了它们，
# 缺了的话 iOS「添加到主屏幕」会拿网页截图当图标。
BASE="https://raw.githubusercontent.com/Mia06250603ian/dwell-on-something/${BRANCH}/web"
mkdir -p "$(dirname "$OUT")/icons"
for f in icons/favicon-64.png icons/favicon.ico icons/icon-180.png icons/icon-192.png icons/icon-512.png manifest.json; do
  if curl -fsSL "$BASE/$f" -o "$(dirname "$OUT")/$f"; then
    echo "  ✓ $f"
  else
    echo "  ！$f 没拉到（图标会缺，页面本身不受影响）"
  fi
done

# 桌宠 clawd 的七个状态图。
# **刻意在部署时拉，不进任何仓库**：这批美术是 Mia06250603ian/clawd-on-desk
# 的 assets/，其 LICENSE 是 All Rights Reserved（授权只覆盖那个桌宠应用本身的
# 个人使用）。所有者拍板自用，那就自用——但没必要顺手把别人的美术转发进
# 一个公开仓库。取不到也不影响页面：前端的 img onerror 会把桌宠整个藏掉。
PET_BASE="https://raw.githubusercontent.com/Mia06250603ian/clawd-on-desk/main/assets/svg"
mkdir -p "$(dirname "$OUT")/pet"
for f in clawd-idle-follow clawd-working-thinking clawd-working-typing clawd-happy \
         clawd-idle-doze clawd-sleeping clawd-react-double-jump; do
  if curl -fsSL "$PET_BASE/$f.svg" -o "$(dirname "$OUT")/pet/$f.svg"; then
    echo "  ✓ pet/$f.svg"
  else
    echo "  ！pet/$f.svg 没拉到（桌宠会自动藏起来，不报错）"
  fi
done
echo "好了：$OUT （$(wc -c < "$OUT") 字节）"

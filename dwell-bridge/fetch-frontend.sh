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
echo "好了：$OUT （$(wc -c < "$OUT") 字节）"

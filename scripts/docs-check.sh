#!/usr/bin/env bash
# 文档一致性自检(2026-08-29 新增)
# 只读:不改任何文件、不联网。跑完打印哪里对不上,自己动手改。
# 用法:bash scripts/docs-check.sh   (在仓库根目录跑)
# 为什么有它:规矩只管「写文档」不管「核文档」,而横跨所有服务的事实
#(服务数、地图表、开场指令、目录行号)没有哪个会话觉得是自己的活,于是每加
# 一个服务就歪一点。2026-08-29 一次自查撞出四处旧账,最久的从 08-28 就歪着。
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
fail=0
say(){ printf '%s\n' "$*"; }
bad(){ printf '  ✗ %s\n' "$*"; fail=1; }
ok(){  printf '  ✓ %s\n' "$*"; }

say "① 带行号目录 vs 实际标题"
for f in kelivo-shim/MAINTENANCE.md telegram-bridge/MAINTENANCE.md; do
  [ -f "$f" ] || continue
  out=$(python3 - "$f" <<'PY'
import re,sys
p=sys.argv[1]; lines=open(p).read().split('\n')
real={i+1 for i,l in enumerate(lines) if re.match(r'^#{2,4} ',l)}
toc=[int(m) for m in re.findall(r'^\| (\d+) \|', '\n'.join(lines), re.M)]
bad=[n for n in toc if n not in real]
print(f"{len(toc)} {' '.join(map(str,bad))}")
PY
)
  cnt=${out%% *}; rest=${out#* }
  if [ "$out" = "$cnt" ] || [ -z "${rest// }" ]; then ok "$f($cnt 个行号全部对上)"
  else bad "$f 有对不上实际标题的行号:$rest"; fi
done

say "② 服务数说法 vs START-HERE 地图表行数"
if python3 - <<'PYEOF'
import re, sys
CN = {c: i for i, c in enumerate("零一二三四五六七八九十", 0)}
def num(t):
    return CN.get(t, 0)
sh = open("START-HERE.md").read()
op = open("OPERATIONS.md").read()
rows = len(re.findall(r'^\| (?:\*\*根目录\*\*|`[a-z-]+/`)', sh, re.M))
m1 = re.search(r'躺着([一二三四五六七八九十])个互相独立的服务', sh)
m2 = re.search(r'躺着([一二三四五六七八九十])个服务', op)
bad = False
if not m1:
    print("  ✗ START-HERE 里找不到「躺着N个互相独立的服务」那句"); bad = True
elif num(m1.group(1)) != rows:
    print(f"  ✗ START-HERE 说 {m1.group(1)} 个,但地图表有 {rows} 行"); bad = True
else:
    print(f"  ✓ START-HERE 说 {m1.group(1)} 个,地图表 {rows} 行,一致")
if not m2:
    print("  ✗ OPERATIONS《开场指令》里找不到「躺着N个服务」"); bad = True
elif num(m2.group(1)) != rows:
    print(f"  ✗ OPERATIONS《开场指令》说 {m2.group(1)} 个,和地图表的 {rows} 行对不上"
          "(这段是每次发给新会话的,最容易被忘)"); bad = True
else:
    print(f"  ✓ OPERATIONS《开场指令》也说 {m2.group(1)} 个,一致")
sys.exit(1 if bad else 0)
PYEOF
then :; else fail=1; fi

say "③ 每个服务目录都有手册,且被 START-HERE 指到"
for d in */; do
  d=${d%/}
  case "$d" in docs|tests|scripts|.github|__pycache__) continue;; esac
  [ -f "$d/MAINTENANCE.md" ] || { bad "$d/ 没有 MAINTENANCE.md"; s3=1; continue; }
  grep -q "\`$d/\`" START-HERE.md || { bad "$d/ 有手册,但 START-HERE 的地图表里找不到它"; s3=1; }
done
[ "${s3:-0}" = 0 ] && ok "所有服务目录都有手册且在地图表里"

say "④ 挂了很久的「尚未/待验」这类话(可能已经过期)"
hits=$(grep -rn "尚未验证\|尚未验\|差最后一步\|待补验\|还没验" --include="*.md" . 2>/dev/null | grep -v "^./TIMELINE.md" | grep -v "^./kelivo-shim/DEPLOY-LOG.md" | head -8)
if [ -z "$hits" ]; then ok "没有挂着的「尚未验证」类说法"
else printf '  ⚠ 下面这些请人工确认是否已经过期(TIMELINE/DEPLOY-LOG 已排除):\n'; printf '%s\n' "$hits" | sed 's/^/     /'; fi

say "⑤ TIMELINE 有没有写成流水账(单行 > 3500 字符)"
#    阈值 2026-08-29 实测定的:2000 会命中 22 行(长行是这份档案的常态,抓不出异常),3500 只命中真正过长的几行。
long=$(awk 'length>3500{printf "     %d 字符: %s…\n", length, substr($0,1,42)}' TIMELINE.md)
if [ -z "$long" ]; then ok "没有超长行"
else printf '  ⚠ 下面这些行详情应该挪进对应手册,TIMELINE 只留一句指路:\n%s\n' "$long"; fi

say ""
if [ $fail -eq 0 ]; then say "结论:硬性检查全部通过(带 ⚠ 的是提醒,要人工判断)。"; else say "结论:有 ✗,按上面逐条改。"; fi
exit $fail

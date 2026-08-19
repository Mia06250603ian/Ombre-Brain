#!/usr/bin/env python3
"""从 ob-backup 的每日 JSON 还原记忆桶。

**为什么要有这个(2026-08-19)**:每天的备份一直在跑、数据也完好(实测 58 天零断档、
375 个桶、0 个空壳),但**仓库里从来没有「还原」这一半** —— `backup_exporter.py` 只导出,
`server.py` 只有 `/api/export-backup`,`import_memory.py` 吃的是原始记忆文字不是备份 JSON,
而 `trace(restore=...)` 是**单个桶**的历史版本回滚,不是整库还原。
也就是说:真出事那天得现场写一个。**没验过的还原路径等于没有备份。**

**写之前实测出来的两件事(别照直觉改回去)**:

1. **分组是权威,`metadata.type` 不是。**
   导出端 `backup_exporter.export_all()` 明写着「Determine category from filesystem path
   to handle legacy type fields」——它按**文件所在目录**分组,不看 type 字段。
   实测 2026-08-19 那份备份:**19 个归档桶的 `type` 是 `"archived"`,而分组名是 `archive`**。
   **按 type 字段还原会把这 19 个全放错。** 所以本脚本一律按 JSON 的分组键落盘。

2. **顶层目录决定「算不算数」。**
   `bucket_manager.list_all()` 只走 permanent/dynamic/feel 三个目录(archive 要
   `include_archive=True` 才带上),但它是**递归**的,且类型从 frontmatter 读、不从目录推断。
   所以:顶层目录必须对(否则归档桶会混进正常检索),域子目录只影响归类好不好看。

**⚠️ 还原完之后还差什么(2026-08-19 实测,真出事时先看这段)**:

  备份 JSON **只有记忆桶的正文与 metadata**。桶目录里这些东西**一份都没备**:

  | 没备份的 | 实测大小 | 丢了会怎样 |
  |---|---|---|
  | `embeddings.db`        | 16 MB   | **语义检索失灵**,要跑 `backfill_embeddings.py` 重建(费额度和时间) |
  | `letters.jsonl`        | 33 KB   | **晏写给她的信全没了** —— 这条最要命,而它很小,值得加进导出 |
  | `.history/`            | 123 个文件 | 每个桶的历史版本快照没了,`trace(restore=版本)` 回滚不了 |
  | `todos.json`           | 2 B     | 晏的待办便利贴 |
  | `dehydration_cache.db` | 336 KB  | 压缩缓存,丢了无所谓,会自己重建 |

  **所以真实的恢复流程是两步,不是一步**:
    ① 本脚本还原记忆桶 → ② `backfill_embeddings.py` 重建向量索引
  信、历史快照、便利贴**没有退路可走**(备份里就没有)。

**安全**:
  · 必须显式给 --dest,**不提供任何默认值** —— 免得手一抖写到线上桶目录;
  · 目标目录非空时**默认拒绝**,要覆盖得显式加 --force;
  · 只写文件,不碰任何服务、不联网。
  · 线上的桶在 OB 容器里的 `/app/buckets`,本脚本跑在别处碰不到它。

用法:
    python3 restore_backup.py --backup <某天>.json --dest <空目录>
    python3 restore_backup.py --backup <某天>.json --dest <空目录> --dry-run
"""
import argparse
import json
import os
import sys

import frontmatter

from utils import sanitize_name, safe_path   # 复用真实代码的实现,不自己重写一遍

CATEGORIES = ("dynamic", "permanent", "feel", "archive")


def restore(backup_path: str, dest: str, dry_run: bool = False) -> dict:
    with open(backup_path, encoding="utf-8") as f:
        data = json.load(f)

    declared = data.get("total")
    stats = {c: 0 for c in CATEGORIES}
    written, skipped = 0, []

    for cat in CATEGORIES:
        items = data.get(cat) or []
        for b in items:
            bid = b.get("id")
            meta = dict(b.get("metadata") or {})
            content = b.get("content", "")
            if not bid:
                skipped.append(f"{cat}: 缺 id,跳过")
                continue

            # 域子目录:feel 固定 沉淀物,其余取 domain[0];与 bucket_manager.create 一致
            if cat == "feel":
                sub = "沉淀物"
            else:
                dom = meta.get("domain") or []
                sub = sanitize_name(dom[0]) if dom else "未分类"

            target_dir = os.path.join(dest, cat, sub)
            name = meta.get("name")
            filename = f"{name}_{bid}.md" if name and name != bid else f"{bid}.md"

            if not dry_run:
                os.makedirs(target_dir, exist_ok=True)
                path = safe_path(target_dir, filename)   # 防目录穿越,用真实代码那份
                with open(path, "w", encoding="utf-8") as fo:
                    fo.write(frontmatter.dumps(frontmatter.Post(content, **meta)))
            stats[cat] += 1
            written += 1

    return {"declared": declared, "written": written, "stats": stats, "skipped": skipped}


def main() -> int:
    ap = argparse.ArgumentParser(description="从备份 JSON 还原记忆桶")
    ap.add_argument("--backup", required=True, help="备份文件,如 backups/2026-08-19.json")
    ap.add_argument("--dest", required=True,
                    help="还原到哪个目录(**没有默认值,必须自己写**,免得手抖写到线上)")
    ap.add_argument("--dry-run", action="store_true", help="只数不写")
    ap.add_argument("--force", action="store_true", help="目标目录非空时也继续")
    a = ap.parse_args()

    if not os.path.isfile(a.backup):
        print(f"❌ 备份文件不存在: {a.backup}"); return 2

    if os.path.isdir(a.dest) and os.listdir(a.dest) and not a.force and not a.dry_run:
        print(f"❌ 目标目录非空: {a.dest}")
        print("   还原会覆盖同名文件。确认要覆盖就加 --force。")
        return 2

    r = restore(a.backup, a.dest, a.dry_run)

    print(("[试运行] " if a.dry_run else "") + f"从 {a.backup} 还原到 {a.dest}")
    for c in CATEGORIES:
        print(f"  {c:<10} {r['stats'][c]:>4} 个")
    print(f"  {'合计':<10} {r['written']:>4} 个   (备份自报 total={r['declared']})")
    for s in r["skipped"]:
        print("  ⚠️ " + s)

    if r["declared"] is not None and r["written"] != r["declared"]:
        print(f"\n❌ 数目对不上:写了 {r['written']},备份自报 {r['declared']}")
        return 1
    print("\n✅ 数目对得上" + ("(试运行,没写文件)" if a.dry_run else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())

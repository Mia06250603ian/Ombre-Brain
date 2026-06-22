# ============================================================
# Module: Backup Exporter (backup_exporter.py)
# 模块：备份导出器
#
# Exports all bucket data (dynamic, permanent, feel, archive)
# to a dated JSON file and pushes to a private GitHub backup repo.
# 将全库数据导出为带日期的 JSON，并推送到 GitHub 私有备份仓库。
#
# Env vars:
#   OMBRE_BACKUP_REPO_URL        Git HTTPS URL of private backup repo
#   OMBRE_BACKUP_TOKEN           GitHub PAT with write access to backup repo
#   OMBRE_BACKUP_LOCAL_PATH      Local clone path (default: ../ombre_backup_repo)
#   OMBRE_BACKUP_INTERVAL_HOURS  Hours between auto-backups (default: 24)
#
# Depended on by: server.py
# ============================================================

import os
import json
import logging
import asyncio
import subprocess
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger("ombre_brain.backup")

_BACKUP_SUBDIR = "backups"


class BackupExporter:
    """
    Daily backup: export all buckets as JSON, commit, push to private GitHub repo.
    每日备份：将全库导出为 JSON，commit 并 push 到私有 GitHub 仓库。
    """

    def __init__(self, config: dict, bucket_mgr):
        self.bucket_mgr = bucket_mgr
        self.buckets_dir = Path(config.get("buckets_dir", "buckets"))

        self.repo_url = os.environ.get("OMBRE_BACKUP_REPO_URL", "").strip()
        self.token = os.environ.get("OMBRE_BACKUP_TOKEN", "").strip()
        self.local_path = Path(
            os.environ.get(
                "OMBRE_BACKUP_LOCAL_PATH",
                str(self.buckets_dir.parent / "ombre_backup_repo"),
            )
        )
        self.interval_hours = float(
            os.environ.get("OMBRE_BACKUP_INTERVAL_HOURS", "24") or "24"
        )
        self.enabled = bool(self.repo_url and self.token)

        self._task: asyncio.Task | None = None
        self._running = False
        self._last_backup: str | None = None  # ISO date string of last successful backup

    @property
    def is_running(self) -> bool:
        return self._running

    # ---------------------------------------------------------
    # Git helpers — token embedded in URL, never logged
    # ---------------------------------------------------------
    def _auth_url(self) -> str:
        """Inject PAT into the HTTPS repo URL."""
        url = self.repo_url
        if "://" in url:
            scheme, rest = url.split("://", 1)
            return f"{scheme}://{self.token}@{rest}"
        return url

    def _git(self, args: list[str]) -> str:
        result = subprocess.run(
            ["git"] + args,
            cwd=str(self.local_path),
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError(f"git {args[0]}: {result.stderr.strip()[:400]}")
        return result.stdout.strip()

    def _ensure_repo(self) -> None:
        """Clone backup repo if missing; otherwise pull latest."""
        self.local_path.mkdir(parents=True, exist_ok=True)
        if not (self.local_path / ".git").exists():
            result = subprocess.run(
                ["git", "clone", self._auth_url(), str(self.local_path)],
                capture_output=True,
                text=True,
                timeout=120,
            )
            if result.returncode != 0:
                # Repo may not exist yet — init a fresh one
                self._git(["init"])
                self._git(["remote", "add", "origin", self._auth_url()])
        else:
            try:
                subprocess.run(
                    ["git", "pull", "--rebase", "origin", "main"],
                    cwd=str(self.local_path),
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
            except Exception:
                pass  # OK if remote branch doesn't exist yet

    # ---------------------------------------------------------
    # Data export
    # ---------------------------------------------------------
    async def export_all(self) -> dict:
        """
        Read every bucket via BucketManager and return a structured export dict.
        通过 BucketManager 读取所有桶，返回结构化导出字典。
        """
        all_buckets = await self.bucket_mgr.list_all(include_archive=True)

        by_type: dict[str, list] = {
            "dynamic": [],
            "permanent": [],
            "feel": [],
            "archive": [],
        }

        for b in all_buckets:
            btype = b["metadata"].get("type", "dynamic")
            path_str = b.get("path", "")
            # Determine category from filesystem path to handle legacy type fields
            if os.sep + "archive" + os.sep in path_str or "/archive/" in path_str:
                btype = "archive"
            elif os.sep + "feel" + os.sep in path_str or "/feel/" in path_str:
                btype = "feel"
            elif os.sep + "permanent" + os.sep in path_str or "/permanent/" in path_str:
                btype = "permanent"
            else:
                btype = "dynamic"

            by_type.setdefault(btype, []).append({
                "id": b["id"],
                "metadata": b["metadata"],
                "content": b["content"],
            })

        total = sum(len(v) for v in by_type.values())
        return {
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "total": total,
            "dynamic": by_type["dynamic"],
            "permanent": by_type["permanent"],
            "feel": by_type["feel"],
            "archive": by_type["archive"],
        }

    # ---------------------------------------------------------
    # Full backup: export → save → git commit → push
    # ---------------------------------------------------------
    async def run_backup(self) -> dict:
        """
        Run a full backup: export all buckets, write dated JSON, commit and push.
        执行完整备份：导出全库，写入带日期 JSON，commit 并 push。
        Returns a summary dict.
        """
        if not self.enabled:
            raise RuntimeError(
                "Backup not configured — set OMBRE_BACKUP_REPO_URL and OMBRE_BACKUP_TOKEN."
            )

        logger.info("Backup export started / 开始备份导出...")
        data = await self.export_all()
        total = data["total"]

        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._ensure_repo)

        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        dest_dir = self.local_path / _BACKUP_SUBDIR
        dest_dir.mkdir(parents=True, exist_ok=True)
        json_path = dest_dir / f"{today}.json"

        json_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        logger.info(f"Exported {total} buckets → {json_path}")

        def _commit_and_push() -> str:
            self._git(["config", "user.name", "Ombre Brain Backup"])
            self._git(["config", "user.email", "backup@ombre-brain.local"])
            # Only stage the backups/ subdirectory — never the whole repo
            # 仅 add 备份目录，绝对不要 git add . 或 git add -A
            self._git(["add", f"{_BACKUP_SUBDIR}/"])

            # Check if there is anything staged
            diff_check = subprocess.run(
                ["git", "diff", "--cached", "--quiet"],
                cwd=str(self.local_path),
                capture_output=True,
            )
            if diff_check.returncode == 0:
                logger.info("No changes to commit — today's backup is identical")
                return "no_changes"

            self._git(["commit", "-m", f"backup: {today} ({total} buckets)"])

            # Push to main; use auth URL directly to avoid storing credentials in config
            result = subprocess.run(
                ["git", "push", self._auth_url(), "HEAD:main"],
                cwd=str(self.local_path),
                capture_output=True,
                text=True,
                timeout=120,
            )
            if result.returncode != 0:
                raise RuntimeError(f"git push failed: {result.stderr.strip()[:400]}")
            logger.info(f"Backup pushed for {today} / 备份已推送: {today}")
            return "pushed"

        status = await loop.run_in_executor(None, _commit_and_push)
        self._last_backup = today

        return {
            "status": status,
            "date": today,
            "file": str(json_path),
            "total": total,
            "dynamic": len(data.get("dynamic", [])),
            "permanent": len(data.get("permanent", [])),
            "feel": len(data.get("feel", [])),
            "archive": len(data.get("archive", [])),
        }

    # ---------------------------------------------------------
    # Background loop (like DecayEngine pattern)
    # ---------------------------------------------------------
    async def ensure_started(self) -> None:
        """Lazily start the backup background loop if not already running."""
        if not self.enabled:
            return
        if self._running:
            return
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._background_loop())
            logger.info(
                f"Backup loop started, interval={self.interval_hours}h / "
                f"备份循环已启动，间隔={self.interval_hours}h"
            )

    async def _background_loop(self) -> None:
        self._running = True
        try:
            await asyncio.sleep(30)  # Brief delay so server finishes startup first
            while True:
                try:
                    result = await self.run_backup()
                    logger.info(f"Scheduled backup complete: {result['status']} | {result['total']} buckets")
                except Exception as e:
                    logger.error(f"Scheduled backup failed: {e}")
                await asyncio.sleep(self.interval_hours * 3600)
        finally:
            self._running = False

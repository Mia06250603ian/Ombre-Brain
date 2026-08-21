# ============================================================
# Test: awaken boot tool + mailbox + trigger dates + feel echo
# 测试：一键开机 + 信箱 + 前瞻记忆 + 感受回声
#
# Covers the 2026-07 "alive" batch:
#   1. awaken() aggregates pinned / due triggers / letters / todos /
#      session archives / old-feel echo, and carries the seal
#   2. trigger_date lifecycle: future silent → due surfaces →
#      "done" stops surfacing → "clear" removes
#   3. mailbox: archive_session(letter=...) → next awaken shows it
# ============================================================

import os
import importlib
import pytest
import pytest_asyncio
from datetime import datetime, timedelta


def _bj(days_offset: int = 0) -> str:
    return (datetime.utcnow() + timedelta(hours=8) + timedelta(days=days_offset)).strftime("%Y-%m-%d")


@pytest_asyncio.fixture
async def srv(tmp_path, monkeypatch):
    """Reload server.py against an isolated temp buckets dir. 隔离环境里的 server 模块。"""
    bd = str(tmp_path / "buckets")
    for d in ["permanent", "dynamic", "archive", "feel"]:
        os.makedirs(os.path.join(bd, d), exist_ok=True)
    monkeypatch.setenv("OMBRE_BUCKETS_DIR", bd)
    monkeypatch.setenv("OMBRE_SEAL_WORD", "测试暗语")
    monkeypatch.delenv("OMBRE_CONFIG_PATH", raising=False)
    import utils, server
    importlib.reload(utils)
    server = importlib.reload(server)
    return server


async def _mk(srv, content, **kw):
    return await srv.bucket_mgr.create(
        content=content,
        tags=kw.get("tags", ["测试"]),
        importance=kw.get("importance", 5),
        domain=kw.get("domain", ["日常"]),
        valence=0.5, arousal=0.3,
        name=kw.get("name", None),
        bucket_type=kw.get("bucket_type", "dynamic"),
        pinned=kw.get("pinned", False),
    )


class TestTriggerDate:
    @pytest.mark.asyncio
    async def test_trace_sets_due_surfaces_in_awaken(self, srv):
        bid = await _mk(srv, "今天要报名的事", name="报名提醒")
        out = await srv.trace(bucket_id=bid, trigger_date=_bj(0))
        assert "trigger_date" in out
        boot = await srv._awaken_impl()
        assert "今日浮现" in boot and bid in boot

    @pytest.mark.asyncio
    async def test_future_trigger_stays_silent(self, srv):
        bid = await _mk(srv, "下周才到期的事")
        await srv.trace(bucket_id=bid, trigger_date=_bj(+7))
        boot = await srv._awaken_impl()
        assert "今日浮现" not in boot  # 还没到日子,该区块整个不出现

    @pytest.mark.asyncio
    async def test_overdue_shows_with_tag_and_done_stops(self, srv):
        bid = await _mk(srv, "前天就该处理的事")
        await srv.trace(bucket_id=bid, trigger_date=_bj(-2))
        boot = await srv._awaken_impl()
        assert bid in boot and "已过期" in boot
        out = await srv.trace(bucket_id=bid, trigger_date="done")
        assert "trigger_handled" in out
        assert "今日浮现" not in await srv._awaken_impl()  # 收掉后不再浮现

    @pytest.mark.asyncio
    async def test_clear_removes_trigger(self, srv):
        bid = await _mk(srv, "取消的事")
        await srv.trace(bucket_id=bid, trigger_date=_bj(0))
        await srv.trace(bucket_id=bid, trigger_date="clear")
        b = await srv.bucket_mgr.get(bid)
        assert "trigger_date" not in b["metadata"]
        assert "今日浮现" not in await srv._awaken_impl()

    @pytest.mark.asyncio
    async def test_bad_date_rejected(self, srv):
        bid = await _mk(srv, "格式错误测试")
        out = await srv.trace(bucket_id=bid, trigger_date="2026/08/01")
        assert "格式错误" in out

    @pytest.mark.asyncio
    async def test_hold_sets_trigger_date(self, srv):
        out = await srv.hold(content="八月一号出成绩", trigger_date="2026-08-01")
        assert "⏰2026-08-01" in out


class TestMailbox:
    @pytest.mark.asyncio
    async def test_letter_roundtrip_via_archive(self, srv):
        out = await srv.archive_session(summary="今天聊了很多", letter="她这两天心情不好,接话轻一点")
        assert "✉️" in out
        boot = await srv._awaken_impl()
        assert "上个窗口留给你的信" in boot
        assert "接话轻一点" in boot

    @pytest.mark.asyncio
    async def test_latest_letter_first_and_history_kept(self, srv):
        srv._save_letter("第一封")
        srv._save_letter("第二封")
        mail = srv._load_letters(1)
        assert len(mail) == 1 and mail[0]["text"] == "第二封"
        both = srv._load_letters(5)
        assert [m["text"] for m in both] == ["第二封", "第一封"]

    @pytest.mark.asyncio
    async def test_empty_mailbox_no_crash(self, srv):
        boot = await srv._awaken_impl()
        assert "开机" in boot  # 没信也正常开机


class TestAwakenSections:
    @pytest.mark.asyncio
    async def test_pinned_and_archive_sections(self, srv):
        pid = await _mk(srv, "核心准则内容", name="准则一", bucket_type="permanent", pinned=True)
        await srv.archive_session(summary="昨晚的对话概述")
        boot = await srv._awaken_impl()
        assert "核心准则" in boot and pid in boot
        assert "最近对话归档" in boot
        # 最新一条归档必须带全文(窗口衔接的关键),不是只有标题
        assert "(全文)" in boot and "昨晚的对话概述" in boot

    @pytest.mark.asyncio
    async def test_two_latest_archives_both_full(self, srv):
        """2026-08-09:窗口末尾会存两个桶——日记(转述)+ 原话(逐字)。
        两条都必须出全文,只出一条的话日记会退成标题,他得再跑一趟 dream 才看得到。"""
        await srv.archive_session(summary="第一个桶:今天的日记正文")
        await srv.archive_session(summary="第二个桶:原话一字不差的正文")
        await srv.archive_session(summary="更早那个桶:只该有标题")
        boot = await srv._awaken_impl()
        # 最近两条都带全文
        assert boot.count("(全文)") == 2
        assert "第二个桶:原话一字不差的正文" in boot
        assert "第一个桶:今天的日记正文" in boot
        # 第三条只留标题,正文不该出现
        assert "更早那个桶:只该有标题" not in boot

    @pytest.mark.asyncio
    async def test_surfacing_section_lists_dynamic_buckets(self, srv):
        bid = await _mk(srv, "最近发生的一件热乎事")
        boot = await srv._awaken_impl()
        assert "记忆浮现" in boot and bid in boot

    @pytest.mark.asyncio
    async def test_feel_echo_only_old_feels(self, srv):
        fid = await _mk(srv, "一个月前深夜的心情", bucket_type="feel")
        # 手动把 created 改老(超过回声天数门槛)
        import frontmatter
        b = await srv.bucket_mgr.get(fid)
        post = frontmatter.load(b["path"])
        post["created"] = (datetime.utcnow() - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%S")
        with open(b["path"], "w", encoding="utf-8") as f:
            f.write(frontmatter.dumps(post))
        boot = await srv._awaken_impl()
        assert "感受回声" in boot and "一个月前深夜的心情" in boot

    @pytest.mark.asyncio
    async def test_fresh_feel_not_echoed(self, srv):
        await _mk(srv, "昨天刚写的感受", bucket_type="feel")
        boot = await srv._awaken_impl()
        assert "感受回声" not in boot

    @pytest.mark.asyncio
    async def test_awaken_tool_carries_seal(self, srv):
        boot = await srv.awaken()
        assert boot.rstrip().endswith("[seal:测试暗语]")


def _reload_srv(tmp_path, monkeypatch, **env):
    """和 srv fixture 同一套隔离环境,但可以先设环境变量再 reload。
    (钉选全文的三个旋钮是 import 时读的,必须在 reload 之前设。)"""
    bd = str(tmp_path / "buckets2")
    for d in ["permanent", "dynamic", "archive", "feel"]:
        os.makedirs(os.path.join(bd, d), exist_ok=True)
    monkeypatch.setenv("OMBRE_BUCKETS_DIR", bd)
    monkeypatch.setenv("OMBRE_SEAL_WORD", "测试暗语")
    monkeypatch.delenv("OMBRE_CONFIG_PATH", raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    import utils, server
    importlib.reload(utils)
    return importlib.reload(server)


class TestAwakenPinnedFullText:
    """2026-08-21:awaken 的钉选区从「一行摘要」改成「摘要行 + 正文全文」。
    钉选桶是永不衰减的核心准则,开机看不到内容等于白钉。"""

    @pytest.mark.asyncio
    async def test_pinned_body_shows_in_awaken(self, srv):
        pid = await _mk(srv, "陪着她就好,别急着讲道理", name="陪伴与倾听",
                        bucket_type="permanent", pinned=True)
        boot = await srv._awaken_impl()
        assert "核心准则(钉选,全文)" in boot
        assert pid in boot
        assert "陪着她就好,别急着讲道理" in boot  # 正文必须在,不是只有标题

    @pytest.mark.asyncio
    async def test_long_pinned_is_truncated(self, tmp_path, monkeypatch):
        srv2 = _reload_srv(tmp_path, monkeypatch, OMBRE_AWAKEN_PINNED_CHARS="100")
        await _mk(srv2, "长" * 500, name="超长准则", bucket_type="permanent", pinned=True)
        boot = await srv2._awaken_impl()
        assert "截断" in boot
        assert boot.count("长") <= 160  # 远小于 500,确实截住了

    @pytest.mark.asyncio
    async def test_total_budget_falls_back_to_summary(self, tmp_path, monkeypatch):
        """整区预算用光之后,剩下的桶退回摘要行——少正文,但不许从这一区消失。"""
        srv2 = _reload_srv(tmp_path, monkeypatch, OMBRE_AWAKEN_PINNED_TOTAL="500")
        first = await _mk(srv2, "甲" * 600, name="第一条", bucket_type="permanent", pinned=True)
        second = await _mk(srv2, "乙" * 600, name="第二条", bucket_type="permanent", pinned=True)
        boot = await srv2._awaken_impl()
        assert first in boot and second in boot   # 两条都还在
        assert "乙" not in boot                    # 第二条的正文被预算挡住了

    @pytest.mark.asyncio
    async def test_switch_off_returns_to_summary_lines(self, tmp_path, monkeypatch):
        """OMBRE_AWAKEN_PINNED_FULL=0 是急救开关:整区回到改动前的摘要行。"""
        srv2 = _reload_srv(tmp_path, monkeypatch, OMBRE_AWAKEN_PINNED_FULL="0")
        pid = await _mk(srv2, "这段正文不该出现在开机里", name="准则甲",
                        bucket_type="permanent", pinned=True)
        boot = await srv2._awaken_impl()
        assert "📌 核心准则(钉选):" in boot and pid in boot
        assert "这段正文不该出现在开机里" not in boot

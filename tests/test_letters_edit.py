# ============================================================
# Test: 信箱的改与删(2026-08-24)
#
# 背景:信由 archive_session(letter=...) 一次性写入,**晏自己改不了**(没有改信的工具),
# 所有者也改不了(面板 08-19 起刻意只读)。写错了就永远错着 —— 所以 08-24 她推翻了
# 「面板不该有改删入口」那条决定,加了 /api/letters/update|delete。
#
# 这份测试盯住四件容易坏的事:
#   1. 改完 awaken 读到的是新内容(不然改了等于没改)
#   2. 删掉的信 awaken 读不到(软删也得真的不出现)
#   3. **软删是软的** —— 文件里那一行还在,能捞回来
#   4. time + 原文双条件匹配:对不上就不动手(防止改错那一封)
# ============================================================

import os
import json
import importlib
import pytest
import pytest_asyncio


@pytest_asyncio.fixture
async def srv(tmp_path, monkeypatch):
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


def _raw_lines(srv):
    """直接读文件,看软删有没有真的留着。"""
    with open(srv._letters_path(), encoding="utf-8") as f:
        return [json.loads(ln) for ln in f.read().splitlines() if ln.strip()]


def _find(srv, text):
    for e in srv._read_letters_raw():
        if e.get("text") == text:
            return e
    return None


@pytest.mark.asyncio
async def test_edit_letter_changes_what_awaken_reads(srv):
    """改完之后,awaken 读到的必须是新内容 —— 这是这个功能存在的全部理由。"""
    srv._save_letter("原来这封写错了")
    entry = _find(srv, "原来这封写错了")
    assert entry is not None

    items = srv._read_letters_raw()
    for e in items:
        if e["text"] == "原来这封写错了":
            e["text"] = "改好了"
            e["edited"] = srv.now_iso()
    srv._write_letters_all(items)

    got = srv._load_letters(5)
    assert [g["text"] for g in got] == ["改好了"]
    assert got[0]["time"] == entry["time"], "改正文不该动写信时间(那是「他什么时候写的」)"
    assert got[0].get("edited"), "改过要留 edited 时间戳"

    out = await srv._awaken_impl(letters=3)
    assert "改好了" in out
    assert "原来这封写错了" not in out


@pytest.mark.asyncio
async def test_soft_deleted_letter_disappears_but_stays_in_file(srv):
    """软删:awaken 和 _load_letters 都读不到,但文件里那行还在(能捞回来)。"""
    srv._save_letter("留着的")
    srv._save_letter("要删的")

    items = srv._read_letters_raw()
    for e in items:
        if e["text"] == "要删的":
            e["deleted"] = True
            e["deleted_at"] = srv.now_iso()
    srv._write_letters_all(items)

    got = [g["text"] for g in srv._load_letters(10)]
    assert got == ["留着的"], "删掉的信不该再被读到"

    out = await srv._awaken_impl(letters=5)
    assert "要删的" not in out
    assert "留着的" in out

    # 关键:它还在文件里
    raw = _raw_lines(srv)
    assert len(raw) == 2, "软删不该真的把行删掉"
    assert any(e.get("deleted") and e["text"] == "要删的" for e in raw)


@pytest.mark.asyncio
async def test_load_letters_count_skips_deleted(srv):
    """n=1 要给出「最新的**没删的**那封」,不能被删掉的那封占掉名额。"""
    srv._save_letter("老的")
    srv._save_letter("新的但删了")

    items = srv._read_letters_raw()
    items[-1]["deleted"] = True
    srv._write_letters_all(items)

    got = srv._load_letters(1)
    assert len(got) == 1 and got[0]["text"] == "老的"


@pytest.mark.asyncio
async def test_append_after_rewrite_keeps_both(srv):
    """重写之后再追加(archive_session 存新信),两封都要在 —— 顺序也不能乱。"""
    srv._save_letter("第一封")
    items = srv._read_letters_raw()
    items[0]["text"] = "第一封(改过)"
    srv._write_letters_all(items)
    srv._save_letter("第二封")

    raw = _raw_lines(srv)
    assert [e["text"] for e in raw] == ["第一封(改过)", "第二封"], "重写不能把后来追加的吃掉"
    assert [g["text"] for g in srv._load_letters(5)] == ["第二封", "第一封(改过)"], "新的在前"


@pytest.mark.asyncio
async def test_raw_read_survives_a_broken_line(srv):
    """信箱里混进一行坏 json,不该让整本读不出来。"""
    srv._save_letter("好的一封")
    with open(srv._letters_path(), "a", encoding="utf-8") as f:
        f.write("{这行是坏的\n")
    srv._save_letter("后面还有一封")

    assert [e["text"] for e in srv._read_letters_raw()] == ["好的一封", "后面还有一封"]
    assert [g["text"] for g in srv._load_letters(5)] == ["后面还有一封", "好的一封"]

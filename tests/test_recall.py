# ============================================================
# Test: 自动浮现的挑选逻辑(recall.py)+ /api/recall 接口(2026-09-30)
#
# 最要紧的两件事:
#   1. 她说的话和某件旧事真相关 → 挑出**那一件**(不是别的)
#   2. 闲聊(包括「今天好开心」这种会撞上泛标签的)→ **空手**
# 语料借用检索尺子那份(tests/retrieval_corpus.py,编的,带泛标签)。
# ============================================================

import os
import sys
import tempfile
from datetime import datetime, timedelta

import pytest
import pytest_asyncio

import recall
from tests.test_retrieval_quality import _prod_config, _build

# (她的原话, 应挑中的 key;None = 应空手)
MESSAGES = [
    ("团子今天又不吃饭了,我好担心", "cat_vet"),
    ("我妈生日快到了送什么好啊", "mom_bday"),
    ("阿蟹今天被我压扁了哈哈", "crab"),
    ("外婆今天打电话来了", "grandma"),
    ("又想去海边了", "trip_sea"),
    ("小雅又惹我生气了", "friend_fall"),
    ("今晚又失眠了睡不着", "insomnia"),
    ("教资面试要报名了", "exam"),
    ("来下飞行棋吗", "game"),
    ("你还记得你答应给我写信吗", "promise_letter"),
    ("在吗", None),
    ("哈哈哈哈哈哈", None),
    ("晚安", None),
    ("今天好累啊", None),
    ("我到家了", None),
    ("好想你", None),
    ("今天上班老板又骂人了,烦死了", None),
    ("今天好开心呀", None),          # 撞「开心」泛标签
    ("有点难过", None),              # 撞「难过」
    ("好想念你", None),              # 撞「想念」
    ("就是很日常的一天", None),      # 撞「日常」
    ("明天要早起,我先睡啦,你也早点休息好不好", None),
]


@pytest_asyncio.fixture
async def env(tmp_path):
    bm, key_to_id = await _build(_prod_config(str(tmp_path / "buckets")))
    return bm, key_to_id


async def _pick(bm, text, **kw):
    all_b = await bm.list_all(include_archive=False)
    matches = await bm.search(text, limit=20)
    return recall.pick(text, matches, all_b, datetime.now(), **kw)


@pytest.mark.asyncio
@pytest.mark.parametrize("text,want", MESSAGES)
async def test_pick_right_one_or_nothing(env, text, want):
    bm, key_to_id = env
    out = await _pick(bm, text)
    got = out["pick"]["id"] if out["pick"] else None
    assert got == (key_to_id[want] if want else None), out


@pytest.mark.asyncio
async def test_search_is_read_only(env):
    """挑选不能涨权重:activation_count / last_active 一个都不许动。"""
    bm, key_to_id = env
    before = (await bm.get(key_to_id["crab"]))["metadata"]
    await _pick(bm, "阿蟹今天被我压扁了哈哈")
    after = (await bm.get(key_to_id["crab"]))["metadata"]
    assert after.get("activation_count") == before.get("activation_count")
    assert str(after.get("last_active")) == str(before.get("last_active"))


@pytest.mark.asyncio
async def test_cooldown_excludes(env):
    bm, key_to_id = env
    out = await _pick(bm, "阿蟹今天被我压扁了哈哈", exclude_ids=[key_to_id["crab"]])
    assert out["pick"] is None
    assert out["candidates"][0]["skip"] == "cooldown"


@pytest.mark.asyncio
async def test_too_new_excluded(env):
    """刚存的(24 小时内)多半还在这个窗口里,不附。"""
    bm, key_to_id = env
    out = await _pick(bm, "半夜饿了煮泡面", min_age_hours=24 * 4)   # snack 是 3 天前的
    assert out["pick"] is None or out["pick"]["id"] != key_to_id["snack"]


def _meta(**kw):
    base = {"created": (datetime.now() - timedelta(days=10)).isoformat()}
    base.update(kw)
    return base


@pytest.mark.parametrize("meta,why", [
    (_meta(pinned=True), "pinned"),
    (_meta(protected=True), "pinned"),
    (_meta(type="feel"), "feel"),
    (_meta(dormant=True), "dormant"),
    (_meta(denied=1), "denied"),
    (_meta(created=datetime.now().isoformat()), "too_new"),
    (_meta(), ""),
])
def test_excluded_reason(meta, why):
    assert recall.excluded_reason(meta, datetime.now(), 24) == why


def test_expired_excluded():
    assert recall.excluded_reason(_meta(), datetime.now(), 24, is_expired=lambda m: True) == "expired"


def test_excerpt_cuts_at_sentence():
    text = "第一句话在这里。" * 10
    out = recall.excerpt(text, 20)
    assert out.endswith("。") and len(out) <= 20
    assert recall.excerpt("短", 20) == "短"


def test_rare_limit_scales():
    assert recall.rare_limit(10) == 3
    assert recall.rare_limit(410) == 21     # 2026-09-30 真实库的规模
    assert recall.rare_limit(1000) == 50


def test_common_word_in_text_is_not_rare_even_if_tagged_once():
    """2026-09-30 真实库彩排撞出来的:「开心」只被 1 个桶打成标签,但 50 条记忆的正文里都有。
    按「几个桶打了这个标签」算它是稀有词,「今天好开心呀」就会随手翻出一件旧事 —— 必须按正文算。"""
    now = datetime.now()
    old = (now - timedelta(days=10)).isoformat()
    buckets = [{"id": f"b{i}", "content": f"那天她很开心,第{i}件小事。", "metadata": {"name": f"小事{i}", "tags": [], "created": old}}
               for i in range(40)]
    buckets.append({"id": "happy", "content": "一件事。", "metadata": {"name": "某事", "tags": ["开心"], "created": old}})
    buckets.append({"id": "nose", "content": "她鼻炎犯了。", "metadata": {"name": "鼻炎", "tags": ["鼻炎"], "created": old}})
    by_id = {b["id"]: b for b in buckets}
    out = recall.pick("今天好开心呀", [by_id["happy"]], buckets, now)
    assert out["pick"] is None and out["candidates"][0]["skip"] == "no_rare_word"
    out = recall.pick("我鼻炎又犯了", [by_id["nose"]], buckets, now)
    assert out["pick"] and out["pick"]["id"] == "nose"


# ---------------- HTTP 层 ----------------

@pytest.fixture(scope="module")
def http_client():
    pytest.importorskip("starlette.testclient")
    from starlette.testclient import TestClient
    bd = tempfile.mkdtemp()
    for sub in ("permanent", "dynamic", "archive", "feel"):
        os.makedirs(os.path.join(bd, sub), exist_ok=True)
    os.environ["OMBRE_BUCKETS_DIR"] = bd
    os.environ.setdefault("OMBRE_SEAL_WORD", "test-seal")
    os.environ["OMBRE_HOOK_SKIP"] = "1"
    sys.modules.pop("server", None)
    import server  # noqa: WPS433
    return TestClient(server.mcp.streamable_http_app())


def test_http_disabled_without_token(http_client, monkeypatch):
    monkeypatch.delenv("OMBRE_RECALL_TOKEN", raising=False)
    r = http_client.get("/api/recall", params={"q": "阿蟹"})
    assert r.status_code == 404


def test_http_rejects_bad_token(http_client, monkeypatch):
    monkeypatch.setenv("OMBRE_RECALL_TOKEN", "right-token")
    assert http_client.get("/api/recall", params={"q": "阿蟹"}).status_code == 401
    r = http_client.get("/api/recall", params={"q": "阿蟹"}, headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401


def test_http_ok_shape(http_client, monkeypatch):
    monkeypatch.setenv("OMBRE_RECALL_TOKEN", "right-token")
    r = http_client.get("/api/recall", params={"q": "阿蟹"}, headers={"Authorization": "Bearer right-token"})
    assert r.status_code == 200
    body = r.json()
    assert set(body) >= {"pick", "reason", "candidates"}


# ---------------- 省下的那次 embedding 调用(2026-09-30 优化)----------------

@pytest.mark.asyncio
async def test_recall_search_skips_embedding(tmp_path, mock_embedding_engine):
    """自动浮现走 use_embedding=False:一次 embedding API 都不许调;普通搜索(breath 用的)照旧调。"""
    from bucket_manager import BucketManager
    mock_embedding_engine.enabled = True
    bm, key_to_id = await _build(_prod_config(str(tmp_path / "buckets")))
    bm.embedding_engine = mock_embedding_engine
    all_b = await bm.list_all(include_archive=False)
    hits = await bm.search("阿蟹今天被我压扁了", limit=20, use_embedding=False, all_buckets=all_b)
    assert mock_embedding_engine.search_similar.await_count == 0
    assert hits and hits[0]["id"] == key_to_id["crab"]
    await bm.search("阿蟹今天被我压扁了", limit=20)
    assert mock_embedding_engine.search_similar.await_count == 1, "默认行为(breath)不该被改动"


# ---------------- 2026-09-30 上线当晚她的真实消息撞出来的 ----------------

@pytest.mark.parametrize("raw,want", [
    ("(她发来一个贴纸)", ""),
    ("（她发来一个贴纸：🥺）", ""),
    ("[语音] 我鼻炎又犯了（语气：低落，和平时比更慢）", "我鼻炎又犯了"),
    ("[语音] 想去海边（语气分析还在认识她的声音）", "想去海边"),
    ("(她给你的「好」点了 ❤) 嗯嗯", "嗯嗯"),
    ("我鼻炎又犯了", "我鼻炎又犯了"),
])
def test_clean_query_strips_bridge_text(raw, want):
    assert recall.clean_query(raw) == want


def _bucket(i, name, content, tags, days=10):
    return {"id": i, "content": content,
            "metadata": {"name": name, "tags": tags, "created": (datetime.now() - timedelta(days=days)).isoformat()}}


@pytest.mark.parametrize("text", [
    "我哪里有 我去给你更新ob功能了呀 委屈",   # 「委屈」是情绪词,不是具体的事
    "你awaken啦?",                            # 系统词
    "好想你呀",
    "我好心疼你",
])
def test_stop_words_never_trigger(text):
    buckets = [_bucket("x", "某事", "那天她有点委屈,也很想你,心疼。awaken 之后归档。", ["委屈", "awaken", "想你", "心疼", "ob"])]
    buckets += [_bucket(f"f{i}", f"填充{i}", f"第{i}件不相干的事。", []) for i in range(60)]
    out = recall.pick(text, [buckets[0]], buckets, datetime.now())
    assert out["pick"] is None, out


def test_real_thing_still_triggers_with_stop_words_around():
    buckets = [_bucket("nose", "鼻炎换药", "她鼻炎犯了。", ["鼻炎", "委屈"])]
    buckets += [_bucket(f"f{i}", f"填充{i}", f"第{i}件不相干的事。", []) for i in range(60)]
    out = recall.pick("委屈死了 鼻炎又犯了", [buckets[0]], buckets, datetime.now())
    assert out["pick"] and out["pick"]["rare"] == ["鼻炎"]


# ---------------- 繁体语音(2026-09-30 她用语音测试时撞到的)----------------

def test_traditional_voice_is_simplified():
    # ears 转写原文就是繁体:「測試一下功能我現在說我閉眼又犯了」(鼻炎被听成了閉眼,那个没法修)
    assert recall.clean_query("[语音] 測試一下功能我現在說（语气：平静）") == "测试一下功能我现在说"
    assert recall.clean_query("想去海邊") == "想去海边"


def test_traditional_voice_triggers_simplified_memory():
    buckets = [_bucket("sea", "海边写下的约定", "她说以后每年都去海边。", ["海边"])]
    buckets += [_bucket(f"f{i}", f"填充{i}", f"第{i}件不相干的事。", []) for i in range(60)]
    q = recall.clean_query("[语音] 好想去海邊啊（语气：开心）")
    out = recall.pick(q, [buckets[0]], buckets, datetime.now())
    assert out["pick"] and out["pick"]["id"] == "sea"


# ---------------- 几个桶都合格时挑哪一件(2026-10-01 她在线上撞到的)----------------

def _three_hm():
    old = (datetime.now() - timedelta(days=10)).isoformat()
    def b(i, name, score):
        return {"id": i, "score": score, "content": f"{name}。",
                "metadata": {"name": name, "tags": ["人机恋"], "created": old}}
    matches = [b("letter", "佳佳的情书", 61.64), b("blogger", "人机恋博主态度", 61.58), b("yesno", "人机恋中的否定与肯定", 59.82)]
    filler = [{"id": f"f{i}", "content": f"第{i}件不相干的事。", "metadata": {"name": f"填充{i}", "tags": [], "created": old}}
              for i in range(60)]
    return matches, matches + filler


def test_name_closest_to_her_words_wins_over_score():
    """她说「人机恋博主」:情书分高 0.06,但「人机恋博主态度」才是那件事。"""
    matches, all_b = _three_hm()
    out = recall.pick("人机恋博主", matches, all_b, datetime.now())
    assert out["pick"]["id"] == "blogger", out


def test_overlap_tie_falls_back_to_search_order():
    """只说「人机恋」:后两个桶名都重合 3 个字,按原来的分数顺序取前一个;情书重合 0,不选。"""
    matches, all_b = _three_hm()
    out = recall.pick("人机恋", matches, all_b, datetime.now())
    assert out["pick"]["id"] == "blogger", out


def test_no_overlap_anywhere_keeps_old_behavior():
    """桶名都不含她那句话里的稀有词 → 和原来一样取第一个合格的。"""
    old = (datetime.now() - timedelta(days=10)).isoformat()
    a = {"id": "a", "score": 70, "content": "x", "metadata": {"name": "某天", "tags": ["鼻炎"], "created": old}}
    c = {"id": "c", "score": 60, "content": "y", "metadata": {"name": "另一天", "tags": ["鼻炎"], "created": old}}
    filler = [{"id": f"f{i}", "content": f"第{i}件事。", "metadata": {"name": f"填充{i}", "tags": [], "created": old}} for i in range(60)]
    out = recall.pick("鼻炎又犯了", [a, c], [a, c] + filler, datetime.now())
    assert out["pick"]["id"] == "a"


def test_overlap_only_counts_runs_with_a_rare_word():
    """「佳佳」这类到处都是的字不该给桶名加分:重合段里必须有命中的稀有词。"""
    assert recall.name_overlap("佳佳说人机恋博主", "佳佳的情书", ["人机恋"]) == 0
    assert recall.name_overlap("佳佳说人机恋博主", "人机恋博主态度", ["人机恋"]) == 5
    assert recall.name_overlap("人机恋", "人机恋中的否定与肯定", ["人机恋"]) == 3

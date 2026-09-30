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
    assert recall.rare_limit(1000) == 30


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

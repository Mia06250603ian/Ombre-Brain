# ============================================================
# recall.py — 「自动浮现」的挑选逻辑(2026-09-30 新增,借鉴 Latent-memory 的 Passive Recall 思路)
#
# 用处:shim 在她每句话进晏之前,拿这句话来问 OB「有没有一件相关的旧事」,
# 有就附在那句话前面,让晏不用自己想起来去 breath。入口是 server.py 的 GET /api/recall。
#
# 三条硬规矩(改之前先想清楚):
#   1. **只读**:不 touch、不涨 activation_count、不触发时间涟漪 —— 自动附上的不算「他想起来了」,
#      否则被附过一次的桶权重越涨越高,越容易再被附,滚雪球。bucket_manager.search() 本身就不 touch。
#   2. **宁可空手**:她大部分话是闲聊,没东西可附是常态。拿不准就不附(附错比不附更伤)。
#   3. **只信「稀有词」**:标签是子串匹配,「今天好开心」会撞上所有带「开心」标签的桶。
#      所以命中必须至少有一个**在全库里不常见**的标签出现在她这句话里(「团子」「阿蟹」),
#      只靠「开心」「担心」「日常」这类满库都是的标签撞上的,一律不算。
#
# 纯逻辑,不碰网络;tests/test_recall.py 拿编的语料测它。
# ============================================================

from __future__ import annotations

import math
import re
from collections import Counter
from datetime import datetime, timedelta

# 稀有标签的门槛:df ≤ max(RARE_MIN, 全库桶数 × RARE_RATIO)。
# 2026-09-30 在 30 条编的语料上定的(泛词每个挂在 8~9 条上,专名挂在 1~2 条上);
# 真实语料上要看 shim 的观察记录再调,别凭感觉改。
RARE_MIN = 3
RARE_RATIO = 0.03
MIN_TAG_LEN = 2


def tag_df(buckets: list[dict]) -> Counter:
    """每个标签(小写)挂在几个桶上。"""
    df: Counter = Counter()
    for b in buckets:
        tags = {str(t).strip().lower() for t in (b.get("metadata", {}).get("tags") or []) if str(t).strip()}
        df.update(tags)
    return df


def rare_limit(n_buckets: int) -> int:
    return max(RARE_MIN, math.ceil(n_buckets * RARE_RATIO))


def rare_tags_in(query: str, tags: list, df: Counter, limit: int) -> list[str]:
    """这个桶的标签里,哪些**原样出现在她这句话里**且在全库不常见。"""
    q = (query or "").lower()
    hits = []
    for t in tags or []:
        t = str(t).strip().lower()
        if len(t) >= MIN_TAG_LEN and t in q and df.get(t, 0) <= limit:
            hits.append(t)
    return hits


def _parse_dt(raw) -> datetime | None:
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00")).replace(tzinfo=None)
    except (ValueError, TypeError):
        return None


def excerpt(content: str, max_chars: int) -> str:
    """取开头 max_chars 字;能在句号处断就在句号处断,别把半句话递给他。"""
    text = re.sub(r"\s+", " ", content or "").strip()
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    stop = max(cut.rfind(p) for p in "。!?!?;;")
    if stop >= max_chars * 0.5:
        return cut[: stop + 1]
    return cut + "…"


def excluded_reason(meta: dict, now: datetime, min_age_hours: float, is_expired=None) -> str:
    """不该自动附的桶返回原因,该附返回空串。"""
    if meta.get("pinned") or meta.get("protected"):
        return "pinned"              # 钉选的 awaken 每次都带全文,再附是重复
    if meta.get("type") == "feel":
        return "feel"                # 他自己的感受,不当「旧事」递
    if meta.get("dormant"):
        return "dormant"
    if int(meta.get("denied", 0) or 0) > 0:
        return "denied"              # 她否认过的,别自动往外递
    if is_expired and is_expired(meta):
        return "expired"
    created = _parse_dt(meta.get("created"))
    if created and now - created < timedelta(hours=min_age_hours):
        return "too_new"             # 刚存的多半还在这个窗口里,附了是复读
    return ""


def pick(query: str, matches: list[dict], all_buckets: list[dict], now: datetime,
         min_age_hours: float = 24, max_chars: int = 240, exclude_ids=(), is_expired=None) -> dict:
    """从 search() 的结果里挑**最多一条**。返回
    {"pick": {...} | None, "reason": str, "candidates": [...]}。
    candidates 给 shim 的观察记录用(前三条、各自为什么行/不行),不含正文。"""
    df = tag_df(all_buckets)
    limit = rare_limit(len(all_buckets))
    exclude = set(exclude_ids or ())
    candidates, chosen = [], None
    for b in matches:
        meta = b.get("metadata", {})
        why = excluded_reason(meta, now, min_age_hours, is_expired)
        rare = rare_tags_in(query, meta.get("tags", []), df, limit)
        if not why and b["id"] in exclude:
            why = "cooldown"
        if not why and not rare:
            why = "no_rare_word"
        if len(candidates) < 3:
            candidates.append({"id": b["id"], "name": meta.get("name", b["id"]),
                               "score": b.get("score", 0), "rare": rare, "skip": why})
        if not why and chosen is None:
            chosen = (b, rare)
    if chosen is None:
        reason = "empty" if not matches else "no_trusted_hit"
        return {"pick": None, "reason": reason, "candidates": candidates}
    b, rare = chosen
    meta = b.get("metadata", {})
    created = str(meta.get("created", ""))[:10]
    return {
        "pick": {"id": b["id"], "name": meta.get("name", b["id"]), "created": created,
                 "score": b.get("score", 0), "rare": rare,
                 "excerpt": excerpt(b.get("content", ""), max_chars)},
        "reason": "ok",
        "candidates": candidates,
    }

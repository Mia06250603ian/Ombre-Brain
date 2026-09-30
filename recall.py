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
#      所以命中必须至少有一个**在全库里不常见**的标签出现在她这句话里(「鼻炎」「螃蟹」),
#      只靠「开心」「我们」「记忆」这类到处都是的词撞上的,一律不算。
#      ⚠️ 「常不常见」数的是**全库有多少条记忆的正文/名字/标签里出现过这个词**,不是「几个桶打了这个标签」。
#      2026-09-30 拿真实库(410 条)彩排撞出来的:真实标签极散(2389 个标签里 1869 个只出现一次),
#      按标签数「开心」和「海边」都只挂 2 个桶,分不开;按正文数「开心」50、「我们」119、「海边」5,一目了然。
#
# 纯逻辑,不碰网络;tests/test_recall.py 拿编的语料测它。
# ============================================================

from __future__ import annotations

import math
import re
from datetime import datetime, timedelta

# 稀有词的门槛:出现在 ≤ max(RARE_MIN, 全库桶数 × RARE_RATIO) 条记忆里。
# 2026-09-30 按真实库定的 5%(410 条 → 21):日常词 声音 22 / 第一次 30 / 吃饭 44 / 开心 50 / 说话 60 / 记忆 73 / 我们 119 被挡住,
# 专名 海边 5 / 螃蟹 5 / 鼻炎 10 / 纪念日 12 / 代码 13 / 吵架 14 / zeabur 17 放行。现场量法见 INTERNALS 3.3.2。
RARE_MIN = 3
RARE_RATIO = 0.05
MIN_TAG_LEN = 2

# 永远不算「具体的事」的词(2026-09-30 上线当晚她的真实消息撞出来的):
# 光按出现次数分不开 —— 真实库里「委屈」16、「想你」14、「难受」13,和「代码」14、「纪念日」14 一个量级。
# 情绪词 / 称呼 / 聊天口头语会出现在她大半的话里,拿它们去翻旧事,翻出来的只会是「另一次她也委屈了」。
# 系统与工具词(awaken / 归档 / 窗口…)是她跟晏聊这套系统本身时说的,翻出来的是维护记录,不是共同经历。
# 要加词直接往里加;改完跑 tests/test_recall.py。
STOP_WORDS = {
    # 情绪
    "开心", "高兴", "快乐", "难过", "伤心", "委屈", "难受", "生气", "气死", "烦", "烦死", "焦虑", "害怕", "紧张",
    "心疼", "吃醋", "撒娇", "想你", "想念", "思念", "喜欢", "爱你", "抱抱", "亲亲", "哭", "哭哭", "笑死",
    "孤单", "寂寞", "累", "好累", "无聊", "开心果", "幸福", "安全感", "温暖", "失落", "崩溃", "感动", "担心",
    # 称呼
    "老公", "老婆", "宝宝", "宝贝", "哥哥", "佳佳", "晏", "许晏", "daddy", "你", "我", "我们", "她",
    # 聊天口头语
    "晚安", "早安", "早上好", "在吗", "回来", "到家", "吃饭", "睡觉", "起床", "洗澡", "说话", "聊天", "第一次",
    "今天", "昨天", "明天", "现在", "刚才", "一起", "日常", "记忆", "声音", "消息",
    # 系统 / 工具
    "awaken", "breath", "hold", "trace", "dream", "pulse", "grow", "archive", "ob", "记忆库", "归档", "窗口",
    "压缩", "上下文", "系统", "claude", "模型", "session", "对话归档", "贴纸", "表情包", "语音", "图片",
}


# 繁 → 简(2026-09-30):语音转写(ears)常把普通话输出成繁体(「測試」「說」「海邊」),
# 而记忆库全是简体,子串匹配一个字都对不上 —— 她用语音说「海边」永远翻不到。跟她手机设置无关。
# 用 opencc-python-reimplemented(Apache-2.0,纯 Python;没选 zhconv 是因为它是 GPL,本仓库 MIT)。
# 包缺了/坏了就原样返回:宁可语音翻不到,也不能让 /api/recall 整个报错。
try:
    from opencc import OpenCC as _OpenCC
    _T2S = _OpenCC("t2s")
except Exception:  # pragma: no cover - 依赖缺失时的退路
    _T2S = None


def to_simplified(text: str) -> str:
    if not text or _T2S is None:
        return text or ""
    try:
        return _T2S.convert(text)
    except Exception:
        return text


def clean_query(text: str) -> str:
    """去掉桥自动写的那部分,只留她真说的话(2026-09-30)。
    - 「(她发来一个贴纸)」「(她发来一张图片…)」「(她给你的…点了 ❤)」这类括号句全是桥写的,整段去掉;
    - 语音转写 `[语音] 她说的话(语气:…)`:她说的话是真的,留下;后面那段语气分析去掉。
    ⚠️ 桥用的括号冒号有半角也有全角(语音那句是全角),下面两种都认。"""
    L, R, C = "[\\(\uff08]", "[\\)\uff09]", "[:\uff1a]"
    t = text or ""
    t = re.sub(L + "她[^()\uff08\uff09]*" + R, " ", t)
    t = re.sub(r"\[语音\]\s*", " ", t)
    t = re.sub(L + "语气(?:" + C + "|分析)[^()\uff08\uff09]*" + R, " ", t)
    return to_simplified(re.sub(r"\s+", " ", t).strip())


class WordDF:
    """一个词在全库多少条记忆里出现过(名字 + 正文 + 标签,不分大小写)。按需算、算过缓存。"""
    def __init__(self, buckets: list[dict]):
        self.docs = []
        for b in buckets:
            meta = b.get("metadata", {})
            tags = " ".join(str(t) for t in (meta.get("tags") or []))
            self.docs.append(f"{meta.get('name', '')} {b.get('content', '')} {tags}".lower())
        self._cache: dict = {}

    def get(self, word: str, default: int = 0) -> int:
        w = (word or "").lower()
        if w not in self._cache:
            self._cache[w] = sum(1 for d in self.docs if w in d)
        return self._cache[w]


def rare_limit(n_buckets: int) -> int:
    return max(RARE_MIN, math.ceil(n_buckets * RARE_RATIO))


def rare_tags_in(query: str, tags: list, df, limit: int) -> list[str]:
    """这个桶的标签里,哪些**原样出现在她这句话里**且在全库不常见。"""
    q = (query or "").lower()
    hits = []
    for t in tags or []:
        t = str(t).strip().lower()
        if len(t) >= MIN_TAG_LEN and t not in STOP_WORDS and t in q and df.get(t, 0) <= limit:
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
    df = WordDF(all_buckets)
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

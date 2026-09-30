// recall.mjs — 自动浮现(2026-09-30)的纯逻辑:她每句话进晏之前,问 OB 有没有一件相关的旧事。
// 借鉴 Mia06250603ian/Latent-memory 的 Passive Recall 思路(**只借思路,代码自己写**——那边许可证不许分发)。
//
// 挑哪一件由 OB 的 GET /api/recall 决定(OB 仓库根目录 recall.py:只读、宁可空手、只信稀有词);
// 这里只管 shim 这边的事:开没开、这句要不要问、冷却、每窗上限、怎么写成一行提示、观察记录。
//
// 三档(RECALL_MODE,也能在运行时用 POST /recall 改,改了不丢窗口,重启回到变量值):
//   off     —— 不问 OB,这条路径和没这功能时**逐字相同**(不设变量就是 off)
//   observe —— 问 OB、记下「本来会递什么」,**不递给晏**(GET /recall 看记录)
//   on      —— 真递:在她那句话前加一行【系统·浮现】
// ⚠️ 递进去的字会**永久留在晏的窗口里**(跟时间/天气那几行一样进了会话历史),所以有每窗上限。
//
// 纯函数都在这里,server.js 只接线;node test-recall.mjs 单测(不碰网络、不碰 claude 进程,踩坑 3 无关)。

export function recallMode(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "on" || s === "observe" ? s : "off";
}

// 这句该不该去问 OB。返回空串 = 该问;否则是不问的原因(进观察记录)。
export function skipReason({ mode, configured, text, reset, systemTurn, windowCount, windowMax }) {
  if (mode === "off") return "off";
  if (!configured) return "not_configured";
  if (systemTurn) return "system_turn";          // 查岗/写信提醒那类不是她说的话
  if (reset) return "reset";                     // 晚安/归档/换窗口这几句不附旧事
  if (String(text || "").trim().length < 2) return "too_short";
  if (windowMax > 0 && windowCount >= windowMax) return "window_full";
  return "";
}

// 还在冷却中的桶 id(顺手清掉过期的)。cooldown: Map<id, 上次递出的毫秒时间>
export function coolingIds(cooldown, now, hours) {
  const out = [];
  for (const [id, t] of cooldown) {
    if (now - t < hours * 3600e3) out.push(id);
    else cooldown.delete(id);
  }
  return out;
}

export function buildUrl(base, { q, n, exclude, minAgeH }) {
  const u = new URL(base);
  u.searchParams.set("q", String(q || "").slice(0, 2000));
  if (n) u.searchParams.set("n", String(n));
  if (minAgeH != null) u.searchParams.set("min_age_hours", String(minAgeH));
  if (exclude && exclude.length) u.searchParams.set("exclude", exclude.join(","));
  return u.toString();
}

// 递给晏的那一行。标注里自带用法,**不用改他的 CLAUDE.md**(改人设要她逐字批准、还得再部署)。
export function formatHint(pick) {
  if (!pick || !pick.id) return "";
  const date = pick.created ? `${pick.created} ` : "";
  const name = pick.name ? `「${pick.name}」` : "";
  return `【系统·浮现】记忆库里自动翻到一件可能相关的旧事(系统附的,不是她说的;用得上就自然接住,用不上就当没看见;别提这行标注):`
    + `${date}${name}${pick.excerpt || ""}(全文:dream(detail_ids="${pick.id}"))`;
}

// 调 OB。任何失败都返回 { error },调用方照常发消息、只是不附。
export async function fetchRecall({ url, token, timeoutMs, fetchImpl = fetch }) {
  const t0 = Date.now();
  try {
    const r = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { error: `http_${r.status}`, ms: Date.now() - t0 };
    const j = await r.json();
    return { ...j, ms: Date.now() - t0 };
  } catch (e) {
    return { error: e?.name === "TimeoutError" ? "timeout" : "fetch_failed", ms: Date.now() - t0 };
  }
}

// 观察记录的一条。preview 只留她那句话的开头,方便对照「这句配这件旧事合不合适」。
export function observation({ mode, text, res, injected, skip }) {
  return {
    at: new Date().toISOString(),
    mode,
    preview: String(text || "").replace(/\s+/g, " ").slice(0, 24),
    skip: skip || null,
    reason: res ? (res.error || res.reason || null) : null,
    ms: res?.ms ?? null,
    pick: res?.pick ? { id: res.pick.id, name: res.pick.name, rare: res.pick.rare } : null,
    candidates: (res?.candidates || []).map((c) => ({ name: c.name, score: c.score, skip: c.skip })),
    injected: !!injected,
  };
}

export function pushRing(ring, item, max = 50) {
  ring.push(item);
  while (ring.length > max) ring.shift();
  return ring;
}

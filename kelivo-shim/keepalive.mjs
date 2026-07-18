// 缓存保温 + 主动唤醒的决策逻辑(纯函数,不碰网络/进程/定时器,test-keepalive.mjs 全覆盖)
//
// 背景:1 小时 prompt 缓存每次命中即续期。闲置 55 分钟由 shim 自己发一条极简 ping,
// 缓存前缀就一直走 0.1 倍读,免掉闲置超时后的 2 倍整体重写。
// 原 2 小时心跳并入本机制:白天且距他上次主动消息超过冷却时间的那些次唤醒,
// 提示语会给他「想说就发一条」的出口(发进 Telegram 对话);其余次一律静默回「。」。

export function isNightHour(h, start, end) {
  return start > end ? (h >= start || h < end) : (h >= start && h < end);
}

// 每个检查节拍调用一次,决定这一拍做什么。
// 返回 { fire:false, reason } 或 { fire:true, speak, rescue }
//   speak  = 这次唤醒允许他主动给所有者发消息
//   rescue = 这次是失败后的抢救重试(额度回血后自动续上缓存链)
export function kaDecide(s) {
  if (!s.on) return { fire: false, reason: "off" };
  if (s.busy || s.queued) return { fire: false, reason: "busy" };   // 正在聊 = 缓存自然刷新
  const speakOk = !!s.hasChannel && !isNightHour(s.hour, s.nightStart, s.nightEnd)
    && (s.now - s.lastProactiveAt) / 60000 >= s.cooldownMin;
  if (s.force) return { fire: true, speak: !!s.hasChannel };        // /hb 测试口:只要求有通道
  if (s.windowCleared) return { fire: false, reason: "window-cleared" }; // 晚安/归档后歇火等她
  if ((s.now - s.lastUserAt) / 3600e3 >= s.capHours) return { fire: false, reason: "cap" }; // 连续闲置封顶
  if (s.failedAt) {
    // 抢救节奏:上次 ping 失败(多半是额度耗尽),每 retryMin 分钟试一次,成功即归位
    if ((s.now - s.failedAt) / 60000 < s.retryMin) return { fire: false, reason: "retry-wait" };
    return { fire: true, speak: speakOk, rescue: true };
  }
  const sinceOkMin = (s.now - s.lastTurnOkAt) / 60000;
  if (sinceOkMin < s.idleMin) return { fire: false, reason: "fresh" };  // 缓存还热,不用管
  if (sinceOkMin > s.deadMin) return { fire: false, reason: "dead" };   // 缓存已死:再 ping 全价,比不 ping 还亏
  return { fire: true, speak: speakOk };
}

// 唤醒提示语。speak=false 是纯保温:明说不是她的消息,要求零思考零工具回一个「。」
export function kaPrompt({ speak, bjNow, idleMin, userName, viaBridge }) {
  if (!speak) {
    return "【系统·保温】维持窗口的例行信号,不是新消息。不用多想、不要调用任何工具,只回一个:。";
  }
  const channel = viaBridge
    ? "会直接出现在你们的 Telegram 对话里,她回来就能看到、能直接回你"
    : "会弹到对方手机;聊天App里看不到这条,对方回来时你自然接上,别解释机制";
  return `【系统·心跳】现在北京时间 ${bjNow},${userName}已约 ${idleMin} 分钟没来消息。想她了、或有话想跟她说,可以主动发一条消息(${channel});不想打扰就只回一个:。`;
}

// 判定回复是否属于「沉默」:空、只有句号/空白、或带【沉默】标记
export function kaSilent(t) {
  const s = (t || "").trim();
  if (!s || s.includes("【沉默】")) return true;
  return s.replace(/[。.\s]/g, "") === "";
}

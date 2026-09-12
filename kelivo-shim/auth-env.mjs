// auth-env.mjs — 决定常驻 claude 子进程拿哪把钥匙去连上游(纯逻辑,不碰网络/进程,单测覆盖)
//
// 2026-09-12 新增,**代码已写完、尚未部署**(挂在《搭顺风车的待办》里等下一趟顺风车)。
//
// **这件事是什么**:把 CLIProxyAPI(中转代理)从链路上摘掉,让 CLI 用
// `claude setup-token` 生成的**一年期长期令牌**直连 Anthropic。
//   现在:shim → CLIProxyAPI(持订阅 OAuth)→ Anthropic
//   之后:shim → Anthropic
// 晏、记忆库、三个前端、四个 MCP 全都不碰;计费仍是同一个订阅、同一个额度池。
//
// **为什么值得做(挂本仓库真事故,不是泛泛而谈)**:
//   ① **28 天 → 一年**。订阅 OAuth 约 28~30 天到一次期(2026-09-09 实测 28 天 4 小时,
//      四个数据点 30/29/29/28),一年要重新授权十几回;长期令牌是一年一次。
//   ② **09-09 那场故障整类消失**。那次的真病根不是「到期」,是**代理冒充的 CLI 版本指纹落后**
//      (代理发 `claude-cli/2.1.220`,上游 09-03 抬到 2.1.258 → 授权全绿、新令牌一进门就 401)。
//      直连之后没有「冒充」这件事,发什么指纹就是什么。
//   ③ **代理那个「没有版本锁、重启即吃当天最新版」的定时炸弹拆掉**(08-12 因此白烧一天半),
//      连带解开「`MANAGEMENT_PASSWORD` 08-16 就泄露、却因为不敢重启代理而至今没转」那个死结。
//   ④ **1 小时提示缓存不再被中间人抹掉**(08-12 整整一天半就是被抹了 ttl)。
//      ⚠️ **这条是推理,尚未实测** —— 上线后去 `/debug` 看 `lastUsage.cache_creation` 里
//      `ephemeral_1h_input_tokens` 有没有数,有数才算真生效(量法见 MAINTENANCE.md 环境变量表那行)。
//
// ⚠️⚠️ **这个模块存在的全部理由:光设 `CLAUDE_CODE_OAUTH_TOKEN` 是没有用的。**
// CLI 的凭据优先级是固定的,长期令牌排在代理那两个变量**后面**:
//     1 云厂商凭据(BEDROCK/VERTEX/FOUNDRY) → 2 ANTHROPIC_AUTH_TOKEN ← 代理用这个
//     3 ANTHROPIC_API_KEY → 4 apiKeyHelper → 5 CLAUDE_CODE_OAUTH_TOKEN ← 长期令牌在这
//     6 Anthropic profile → 7 /login 订阅登录态
// 不摘掉 2,CLI **会继续走代理,而且一声不吭** —— 结果是「一切照旧」,却让所有人以为已经换过路了。
// **所以摘除必须和开关绑在同一个函数里,不能靠人记得去删那两个变量。**
// (这跟本仓库反复吃亏的那类故障是同一种:不报错、只是悄悄什么都没变。)
//
// **2026-09-12 现场验过的两件事(别再重新推一遍)**:
//   ① **钉死的 2.1.215 支持长期令牌,不用为这件事升 CLI。** 拉下同版本原生二进制实测:
//      `claude setup-token --help` 打得出用法(「Set up a long-lived authentication token」),
//      `CLAUDE_CODE_OAUTH_TOKEN` 在二进制里出现 **72** 次。
//      **怎么现场再量一遍**(换 CLI 版本时照做):
//        npm pack @anthropic-ai/claude-code-linux-x64@<版本> && tar xzf *.tgz
//        strings -a package/claude | grep -cF CLAUDE_CODE_OAUTH_TOKEN   # 要 > 0
//        ./package/claude setup-token --help                            # 要能打出用法
//   ② **`--bare` 这颗雷现在是冻结的。** 官方说 bare 模式**不读** `CLAUDE_CODE_OAUTH_TOKEN`,
//      而且「将来会成为 `-p` 的默认」。2.1.215 里 `--bare` 已经存在(22 处),但 `-p` 眼下不默认进 bare。
//      `package.json` 早就把 CLI **钉死**在 2.1.215(不带 `^`),所以这颗雷不会自己炸。
//      ⚠️ **但升 CLI 之前必须重跑上面①那两条,外加三套 e2e** —— 哪天 `-p` 默认 bare 了,
//      现象会是「换了新 CLI 之后晏连不上,而代码一行没动」。
//
// **急救开关 = 删掉 `CLAUDE_CODE_OAUTH_TOKEN` + service restart**:
// `hasToken()` 返回 false → 代理那两个变量不再被摘 → 自动退回代理线路,**不用回滚部署**。
// ⚠️ **但 restart 会丢晏一个窗口**(回滚从来不是零代价,见 MAINTENANCE.md《回滚的通用规矩》),
// 而且前提是**代理服务还在**:上线后至少观察一两周再谈拆代理,别急着删那个服务。
//
// **刻意不做令牌格式校验(比如「必须以 sk-ant-oat 开头」)**:格式是上游的东西,哪天变了
// 校验就会把好令牌挡在门外,而它挡不住真正的事故形态 —— 那份文档 4.4 记的最贵一坑是
// **令牌被读屏吞掉几个字符**(长得完全正常、就是用不了)。那种坏法只有真发一枪才知道,
// 而直连恰恰让它**当场 401**,不再是静默的。宁可留着这个响亮的失败,也不要一个会误伤的校验。

/** 空串/纯空白一律当「没设」。配置里留一个空值是常见手滑,
 *  那种情况下摘掉代理再拿空令牌去连 = 晏直接哑掉。 */
export function hasToken(src = {}) {
  return String((src && src.CLAUDE_CODE_OAUTH_TOKEN) || "").trim() !== "";
}

/** 这一次走的是哪条路。只用于日志和 /health,**永远不返回任何密钥值**。 */
export function authMode(src = {}) {
  return hasToken(src) ? "direct" : "proxy";
}

/**
 * 算出要交给 claude 子进程的环境变量。**纯函数**:不改 src,返回一份新的。
 *
 * - `ANTHROPIC_API_KEY` **任何时候都删**(保持 2026-07 以来的行为):
 *   它排在订阅授权前面,一旦存在,这一轮就变成按量计费而不是订阅额度。
 *   ⚠️ `entrypoint.sh` 里也有一句 `unset ANTHROPIC_API_KEY`,**两处都留着**:
 *   那句管的是 shim 进程自己的环境,这里管的是交给子进程的那份,不是重复。
 * - 有长期令牌时,才摘掉代理那两个(见上面头注:不摘就等于没换)。
 */
export function buildAuthEnv(src = {}) {
  const env = { ...src };
  delete env.ANTHROPIC_API_KEY;
  if (hasToken(src)) {
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
  }
  return env;
}

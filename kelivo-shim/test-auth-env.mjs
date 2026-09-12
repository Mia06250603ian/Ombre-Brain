// test-auth-env.mjs — 直连/代理选路的单测,部署前跑一遍:node test-auth-env.mjs
// 全绿输出 "ALL PASS";不碰网络、不碰 claude 进程。
import { buildAuthEnv, authMode, hasToken } from "./auth-env.mjs";

let n = 0, bad = 0;
function ok(cond, name) { n++; if (!cond) { bad++; console.error("FAIL:", name); } }
function eq(got, want, name) { ok(got === want, `${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

// ---- hasToken:空值一律当「没设」 ----
// 配置里留一个空值是常见手滑。判错了的后果不对称:
// 误判成「设了」→ 摘掉代理 + 拿空令牌去连 = 晏当场哑掉。
ok(hasToken({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-xxx" }), "正常令牌 = 设了");
ok(!hasToken({ CLAUDE_CODE_OAUTH_TOKEN: "" }), "空串 = 没设");
ok(!hasToken({ CLAUDE_CODE_OAUTH_TOKEN: "   " }), "纯空格 = 没设");
ok(!hasToken({ CLAUDE_CODE_OAUTH_TOKEN: "\t\n" }), "纯空白 = 没设");
ok(!hasToken({ CLAUDE_CODE_OAUTH_TOKEN: undefined }), "undefined = 没设");
ok(!hasToken({ CLAUDE_CODE_OAUTH_TOKEN: null }), "null = 没设");
ok(!hasToken({}), "整个没这个键 = 没设");
ok(!hasToken(), "不传参数不炸");
ok(hasToken({ CLAUDE_CODE_OAUTH_TOKEN: "  sk-ant-oat01-xxx  " }), "两边有空格仍算设了");

// ---- authMode:只报两个字,永远不吐值 ----
eq(authMode({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-xxx" }), "direct", "有令牌 = direct");
eq(authMode({ ANTHROPIC_AUTH_TOKEN: "proxy-key" }), "proxy", "只有代理 = proxy");
eq(authMode({}), "proxy", "什么都没有 = proxy(= 改动前的行为)");
eq(authMode(), "proxy", "不传参数不炸");
for (const bad of ["", "   ", undefined, null]) {
  eq(authMode({ CLAUDE_CODE_OAUTH_TOKEN: bad }), "proxy", `空令牌(${JSON.stringify(bad)})当没设`);
}

// ---- buildAuthEnv:设了长期令牌 = 必须摘掉代理那两个 ----
// ⚠️ 这是整个模块存在的理由:CLI 凭据优先级里 ANTHROPIC_AUTH_TOKEN(2) 排在
// CLAUDE_CODE_OAUTH_TOKEN(5) **前面**,不摘它,CLI 会继续走代理**而且不报错**。
{
  const env = buildAuthEnv({
    ANTHROPIC_BASE_URL: "https://miaianhome.example",
    ANTHROPIC_AUTH_TOKEN: "proxy-key",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-xxx",
    PATH: "/usr/bin",
  });
  eq("ANTHROPIC_AUTH_TOKEN" in env, false, "不摘 AUTH_TOKEN 会静默压过长期令牌");
  eq("ANTHROPIC_BASE_URL" in env, false, "BASE_URL 也要摘,否则照样拨去代理那个地址");
  eq(env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-xxx", "令牌本身要留着");
  eq(env.PATH, "/usr/bin", "不相干的变量原样带过去");
}

// ---- buildAuthEnv:没设长期令牌 = 逐字回到改动前的行为 ----
// 这条钉死「默认休眠」:变量没配上之前,这次改动对线上等于不存在。
{
  const env = buildAuthEnv({
    ANTHROPIC_BASE_URL: "https://miaianhome.example",
    ANTHROPIC_AUTH_TOKEN: "proxy-key",
  });
  eq(env.ANTHROPIC_AUTH_TOKEN, "proxy-key", "没令牌就别动代理的钥匙");
  eq(env.ANTHROPIC_BASE_URL, "https://miaianhome.example", "没令牌就别动代理的地址");
}
{
  // 空令牌 = 没设,同样一个都别摘 —— 否则手滑留个空值就会把晏弄哑
  const env = buildAuthEnv({ ANTHROPIC_AUTH_TOKEN: "proxy-key", CLAUDE_CODE_OAUTH_TOKEN: "  " });
  eq(env.ANTHROPIC_AUTH_TOKEN, "proxy-key", "空令牌不许触发摘除");
}

// ---- ANTHROPIC_API_KEY:两条路都要删(保持 2026-07 以来的行为)----
// 它排在订阅授权前面,一旦存在,这一轮就变成按量计费而不是订阅额度。
for (const src of [
  { ANTHROPIC_API_KEY: "sk-ant-api-xxx", ANTHROPIC_AUTH_TOKEN: "proxy-key" },
  { ANTHROPIC_API_KEY: "sk-ant-api-xxx", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-xxx" },
]) {
  eq("ANTHROPIC_API_KEY" in buildAuthEnv(src), false, "API key 任何时候都不进子进程");
}

// ---- 纯函数:不许改调用方那份 process.env ----
{
  const src = {
    ANTHROPIC_BASE_URL: "https://miaianhome.example",
    ANTHROPIC_AUTH_TOKEN: "proxy-key",
    ANTHROPIC_API_KEY: "sk-ant-api-xxx",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-xxx",
  };
  buildAuthEnv(src);
  eq(src.ANTHROPIC_AUTH_TOKEN, "proxy-key", "源对象不能被改(server.js 传的是 process.env)");
  eq(src.ANTHROPIC_API_KEY, "sk-ant-api-xxx", "源对象不能被改(API key 那条同理)");
}
{
  const env = buildAuthEnv();
  eq(typeof env, "object", "不传参数返回一个空环境,不炸");
  eq(Object.keys(env).length, 0, "不传参数不会凭空造出变量");
}

// ---- 一致性:authMode 说 direct,buildAuthEnv 就必须真摘干净 ----
// 两个函数分头判断的话,迟早会出现「/health 说 direct、实际还在走代理」那种最坏情况:
// 报告和事实分家,比坏了更难查。
for (const src of [
  { CLAUDE_CODE_OAUTH_TOKEN: "x", ANTHROPIC_AUTH_TOKEN: "p", ANTHROPIC_BASE_URL: "u" },
  { CLAUDE_CODE_OAUTH_TOKEN: " ", ANTHROPIC_AUTH_TOKEN: "p", ANTHROPIC_BASE_URL: "u" },
  { ANTHROPIC_AUTH_TOKEN: "p", ANTHROPIC_BASE_URL: "u" },
]) {
  const env = buildAuthEnv(src);
  const stripped = !("ANTHROPIC_AUTH_TOKEN" in env) && !("ANTHROPIC_BASE_URL" in env);
  eq(stripped, authMode(src) === "direct", "/health 报的模式必须和真实摘除结果一致");
}

console.log(bad === 0 ? `ALL PASS (${n})` : `${bad}/${n} FAILED`);
process.exit(bad === 0 ? 0 : 1);

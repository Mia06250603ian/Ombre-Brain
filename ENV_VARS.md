# 环境变量参考

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `OMBRE_API_KEY` | 是 | — | Gemini / OpenAI-compatible API Key，用于脱水(dehydration)和向量嵌入 |
| `OMBRE_BASE_URL` | 否 | `https://generativelanguage.googleapis.com/v1beta/openai/` | API Base URL（可替换为代理或兼容接口） |
| `OMBRE_TRANSPORT` | 否 | `stdio` | MCP 传输模式：`stdio` / `sse` / `streamable-http` |
| `OMBRE_PORT` | 否 | `8000` | HTTP/SSE 模式监听端口（仅 `sse` / `streamable-http` 生效） |
| `OMBRE_BUCKETS_DIR` | 否 | `./buckets` | 记忆桶文件存放目录（绑定 Docker Volume 时务必设置） |
| `OMBRE_HOOK_URL` | 否 | — | Breath/Dream Webhook 推送地址（POST JSON），留空则不推送 |
| `OMBRE_HOOK_SKIP` | 否 | `false` | 设为 `true`/`1`/`yes` 跳过 Webhook 推送（即使 `OMBRE_HOOK_URL` 已设置） |
| `OMBRE_DASHBOARD_PASSWORD` | 否 | — | 预设 Dashboard 访问密码；设置后覆盖文件存储的密码，首次访问不弹设置向导 |
| `OMBRE_DEHYDRATION_MODEL` | 否 | `deepseek-chat` | 脱水/打标/合并/拆分用的 LLM 模型名（覆盖 `dehydration.model`） |
| `OMBRE_DEHYDRATION_BASE_URL` | 否 | `https://api.deepseek.com/v1` | 脱水模型的 API Base URL（覆盖 `dehydration.base_url`） |
| `OMBRE_MODEL` | 否 | — | `OMBRE_DEHYDRATION_MODEL` 的别名（前者优先） |
| `OMBRE_EMBEDDING_MODEL` | 否 | `gemini-embedding-001` | 向量嵌入模型名（覆盖 `embedding.model`） |
| `OMBRE_EMBEDDING_BASE_URL` | 否 | — | 向量嵌入的 API Base URL（覆盖 `embedding.base_url`；留空则复用脱水配置） |
| `OMBRE_AWAKEN_FULL_SESSIONS` | 否 | `2` | awaken 的「最近对话归档」区出全文的条数（钳在 1~3）。默认 2 = 日记桶 + 原话桶各一条 |
| `OMBRE_AWAKEN_PINNED_FULL` | 否 | `1` | awaken 的「钉选」区是否出正文全文（2026-08-21）。设 `0` 回到只出摘要行的旧行为——**急救开关**，改值 + restart 即生效 |
| `OMBRE_AWAKEN_PINNED_CHARS` | 否 | `800` | 钉选区**每条**正文的字数上限，超出截断并标注（下限 100） |
| `OMBRE_AWAKEN_PINNED_TOTAL` | 否 | `6000` | 钉选区**整区**正文的字数总预算，用光后剩余的桶退回摘要行（仍列出，只是不带正文；下限 500） |
| `OMBRE_NETWORK_EDGES_PER_NODE` | 否 | `6` | 「记忆网络」页每个桶最多连几条边（2026-09-01）。设 `0` = 不封顶（相似度 >0.5 的边在 438 桶下实测约 1.2 万条，前端会卡）。改值 + restart 即生效，详见 `INTERNALS.md` 1.10 |

## 说明

- `OMBRE_API_KEY` 也可在 `config.yaml` 的 `dehydration.api_key` / `embedding.api_key` 中设置，但**强烈建议**通过环境变量传入，避免密钥写入文件。
- `OMBRE_DASHBOARD_PASSWORD` 设置后，Dashboard 的"修改密码"功能将被禁用（显示提示，建议直接修改环境变量）。未设置则密码存储在 `{buckets_dir}/.dashboard_auth.json`（SHA-256 + salt）。

## Webhook 推送格式 (`OMBRE_HOOK_URL`)

设置 `OMBRE_HOOK_URL` 后，Ombre Brain 会在以下事件发生时**异步**（fire-and-forget，5 秒超时）`POST` JSON 到该 URL：

| 事件名 (`event`) | 触发时机 | `payload` 字段 |
|------------------|----------|----------------|
| `breath` | MCP 工具 `breath()` 返回时 | `mode` (`ok`/`empty`), `matches`, `chars` |
| `dream` | MCP 工具 `dream()` 返回时 | `recent`, `chars` |
| `breath_hook` | HTTP `GET /breath-hook` 命中（SessionStart 钩子） | `surfaced`, `chars` |
| `dream_hook` | HTTP `GET /dream-hook` 命中 | `surfaced`, `chars` |

请求体结构（JSON）：

```json
{
  "event": "breath",
  "timestamp": 1730000000.123,
  "payload": { "...": "..." }
}
```

Webhook 推送失败仅在服务日志中以 WARNING 级别记录，**不会影响 MCP 工具的正常返回**。

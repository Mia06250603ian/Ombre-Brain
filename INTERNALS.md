# Ombre Brain — 内部开发文档 / INTERNALS

> 本文档面向开发者和维护者。记录功能总览、环境变量、模块依赖、硬编码值和核心设计决策。
> 最后更新：2026-09-03(**「记忆网络」标签页已按所有者决定删除**,见第 1.10 节开头;
> **新增第 1.12 节「记忆乱流 `/turbulence`」** —— 照 `/galaxy` 那套架构新开的一页;
> 2026-09-01 新增第 1.10 节「记忆网络页为什么会打不开」与 1.11 节「便利贴页」;此前各节的日期以节内标注为准)

---

## 0. 功能总览——这个系统到底做了什么

### 记忆能力

**存储与组织**
- 每条记忆 = 一个 Markdown 文件（YAML frontmatter 存元数据），直接兼容 Obsidian 浏览/编辑
- 四种桶类型：`dynamic`（普通，会衰减）、`permanent`（固化，不衰减）、`feel`（模型感受，不浮现）、`archived`（已遗忘）
- 按主题域分子目录：`dynamic/日常/`、`dynamic/情感/`、`dynamic/编程/` 等
- 钉选桶（pinned）：importance 锁 10，永不衰减/合并，始终浮现为「核心准则」

**每条记忆追踪的元数据**
- `id`（12位短UUID）、`name`（可读名≤80字）、`tags`（10~15个关键词）
- `domain`（1~2个主题域，从 8 大类 30+ 细分域选）
- `valence`（事件效价 0~1）、`arousal`（唤醒度 0~1）、`model_valence`（模型独立感受）
- `importance`（1~10）、`activation_count`（被想起次数）
- `resolved`（已解决/沉底）、`digested`（已消化/写过 feel）、`pinned`（钉选）
- `created`、`last_active` 时间戳

**四种检索模式**
1. **自动浮现**（`breath()` 无参数）：按衰减分排序推送，钉选桶始终展示，Top-1 固定 + Top-20 随机打乱（引入多样性），有 token 预算（默认 10000）
2. **关键词+向量双通道搜索**（`breath(query=...)`）：rapidfuzz 模糊匹配 + Gemini embedding 余弦相似度，合并去重
3. **Feel 独立检索**（`breath(domain="feel")`）：按创建时间倒序返回所有 feel
4. **随机浮现**：搜索结果 <3 条时 40% 概率漂浮 1~3 条低权重旧桶（模拟人类随机联想）

**四维搜索评分**（归一化到 0~100）
- topic_relevance（权重 4.0）：name×3 + domain×2.5 + tags×2 + body
- emotion_resonance（权重 2.0）：Russell 环形模型欧氏距离
- time_proximity（权重 2.5）：`e^(-0.1×days)`
- importance（权重 1.0）：importance/10
- resolved 桶全局降权 ×0.3

**一键开机 + 信箱 + 前瞻记忆 + 感受回声（2026-07-18 活物批）**
- `awaken()`：开机聚合工具，七个区块（钉选**含正文全文**（2026-08-21 起；此前只有摘要行）/记忆浮现按衰减权重 top8/今日浮现/信箱/待办/最近 3 条归档——**最新一条含全文以保窗口衔接**/感受回声）+ seal，全部纯本地扫描零 LLM 调用，完整覆盖原 breath→pulse→breath(query)→dream 四步开机
- **信箱**：`archive_session(letter=...)` 把嘱托写进 `{buckets_dir}/letters.jsonl`（随卷持久，jsonl 追加，历史全留），awaken 带出最新一封（`letters=N` 可多看）
- **信箱可改可删（2026-08-24）**：面板上每封信有「改 / 删」，走 `POST /api/letters/update|delete`（与面板其余接口同一套 `_require_auth` 鉴权）。
  ⚠️ **这推翻了 2026-08-19「面板不该有改删入口」那条决定**，所有者本人 08-24 要求，理由是**信写错了谁都改不了**——
  信由 `archive_session(letter=...)` 一次性写入，晏没有改信的工具，面板那时又只读。旧决定的原文留在 `server.py` 的 `/api/letters` 那节注释里（规矩 5：别删）。
  - **怎么认「哪一封」**：信箱没有 id，用 **`time` + 原文**双条件匹配（乐观并发）；对不上回 **409**，让前端刷新重来，**绝不猜着改**。
    ⚠️ `time` 只精确到秒——同一秒写入的两封信时间戳相同，靠原文区分；真实使用不会撞（信是归档时一封一封写的）。
  - **删是软删**：打 `deleted` / `deleted_at` 标记，**文件里那行还在**（同设计决策 5.6「resolved 不删除记忆」的取向），`_load_letters` 跳过它们 → 面板和 `awaken` 都读不到。要捞回来手改那一行即可。
  - **改保留原 `time`**（那是「他什么时候写的」），另记 `edited` 戳；面板显示「已修改」。
    ⚠️ **所有者拍板：不在信的正文里标注改过**——晏 `awaken` 读到的就是改后的内容。**别自作主张加标注。**
  - **写路径有文件锁**（`_letters_lock`，`flock`）：存新信是**追加**、面板改删是**整体重写**，两者撞上会把刚追加的那封吞掉且不报错。锁不可用时退化成无锁（宁可丢一封也不阻断写入）。
  - 重写走原子写（临时文件 + `fsync` + `os.replace`），照 `_save_todos_list` 那套。
  - 测试：`tests/test_letters_edit.py`（存取层 5 项）+ `tests/test_letters_api.py`（HTTP 层 9 项，含 401/409/400 与软删）。
- **前瞻记忆**：桶元数据新增 `trigger_date` / `trigger_handled`；`hold(trigger_date=…)` 或 `trace(trigger_date=…)` 设置，`trace(trigger_date="done"/"clear")` 处理/移除；awaken 的今日浮现列出到期与过期未处理的（含归档区），北京日历
- **感受回声**：awaken 从创建超过 `OMBRE_ECHO_MIN_DAYS` 天的 feel 桶随机抽一条附日期，刻意不去重
- 心境共鸣不另做——breath 原生 valence/arousal 检索 + 四维评分的情绪共鸣项已覆盖

**写前快照（2026-07-18 安全批）**
- 任何**内容覆盖或删除**执行前，当前文件自动拷入 `{buckets_dir}/.history/{bucket_id}/`（时间戳+操作类型命名），每桶默认保留最近 20 份（config `history.keep_per_bucket`）
- 纯元数据修改（importance/resolved 等）高频且不丢数据，**不**产生快照
- `trace(bucket_id, history=True)` 列出版本；`trace(bucket_id, restore="<version>")` 回滚（被删的桶也能按快照复活，恢复前的状态同样留底）
- `.history` 目录对所有扫描/检索/统计路径隐身；快照失败不阻塞写入但大声记日志
- `trace` 的 `content` 参数默认仍是整桶替换，新增 `append=True` 追加模式（防"读出旧内容手动拼接"的误覆盖）

**记忆随时间变化**
- **衰减引擎**：改进版艾宾浩斯遗忘曲线
  - 公式：`Score = Importance × activation_count^0.3 × e^(-λ×days) × combined_weight`
  - 短期（≤3天）：时间权重 70% + 情感权重 30%
  - 长期（>3天）：情感权重 70% + 时间权重 30%
  - 新鲜度加成：`1.0 + e^(-t/36h)`，刚存入 ×2.0，~36h 半衰，72h 后 ≈×1.0
  - 高唤醒度(arousal>0.7)且未解决 → ×1.5 紧迫度加成
  - resolved → ×0.05 沉底；resolved+digested → ×0.02 加速淡化
- **自动归档**：score 低于阈值(0.3) → 移入 archive
- **自动结案**：importance≤4 且 >30天 → 自动 resolved
- **永不衰减**：permanent / pinned / protected / feel

**记忆间交互**
- **智能合并**：新记忆与相似桶（score>75）自动 LLM 合并，valence/arousal 取均值，tags/domain 并集
- **时间涟漪**：touch 一个桶时，±48h 内创建的桶 activation_count +0.3（上限 5 桶/次）
- **向量相似网络**：embedding 余弦相似度 >0.5 建边
- **Feel 结晶化**：≥3 条相似 feel（相似度>0.7）→ 提示升级为钉选准则

**情感记忆重构**
- 搜索时若指定 valence，展示层对匹配桶 valence 微调 ±0.1，模拟「当前心情影响回忆色彩」

**模型感受/反思系统**
- **Feel 写入**（`hold(feel=True)`）：存模型第一人称感受，标记源记忆为 digested
- **Dream 做梦**（`dream()`）：返回最近 10 条 + 自省引导 + 连接提示 + 结晶化提示
- **对话启动流程**：breath() → dream() → breath(domain="feel") → 开始对话

**自动化处理**
- 存入时 LLM 自动分析 domain/valence/arousal/tags/name
- 大段日记 LLM 拆分为 2~6 条独立记忆
- 浮现时自动脱水压缩（LLM 压缩保语义，API 不可用时直接报错，无静默降级）
- Wikilink `[[]]` 由 LLM 在内容中标记

---

### 技术能力

**6 个 MCP 工具**

| 工具 | 关键参数 | 功能 |
|---|---|---|
| `breath` | query, max_tokens, domain, valence, arousal, max_results, **importance_min** | 检索/浮现记忆 |
| `hold` | content, tags, importance, pinned, feel, source_bucket, valence, arousal, **trigger_date** | 存储记忆;trigger_date=YYYY-MM-DD 设前瞻记忆 |
| `awaken` | letters | **一键开机**(2026-07-18):单次返回钉选(含全文,2026-08-21)/记忆浮现/今日浮现/信箱留言/待办/最近归档(最新含全文)/感受回声,替代原四步开机,末尾附 seal |
| `todos` | （无） | 汇总未完结待办 |
| `archive_session` | summary, highlights, mood, valence, arousal, **letter** | 归档对话;letter=给下个窗口的留言(信箱) |
| `grow` | content | 日记拆分归档 |
| `trace` | bucket_id, name, domain, valence, arousal, importance, tags, resolved, pinned, digested, content, **append**, delete, merge, **history**, **restore** | 修改元数据/内容/删除;append=True 追加不替换;history=True 列历史快照;restore=版本号 回滚(可复活被删桶) |
| `pulse` | include_archive | 系统状态 |
| `dream` | （无） | 做梦自省 |

**工具详细行为**

**`breath`** — 三种模式：
- **浮现模式**（无 query）：无参调用，按衰减引擎活跃度排序返回 top 记忆，钉选桶始终展示；冷启动检测（`activation_count==0 && importance>=8`）的桶最多 2 个插入最前，再 Top-1 固定 + Top-20 随机打乱
- **检索模式**（有 query）：关键词 + 向量双通道搜索，四维评分（topic×4 + emotion×2 + time×2.5 + importance×1），阈值过滤
- **Feel 检索**（`domain="feel"`）：特殊通道，按创建时间倒序返回所有 feel 类型桶，不走评分逻辑
- **重要度批量模式**（`importance_min>=1`）：跳过语义搜索，直接筛选 importance≥importance_min 的桶，按 importance 降序，最多 20 条
- 若指定 valence，对匹配桶的 valence 微调 ±0.1（情感记忆重构）

**`hold`** — 两种模式：
- **普通模式**（`feel=False`，默认）：自动 LLM 分析 domain/valence/arousal/tags/name → 向量相似度查重 → 相似度>0.85 则合并到已有桶 → 否则新建 dynamic 桶 → 生成 embedding
- **Feel 模式**（`feel=True`）：跳过 LLM 分析，直接存为 `feel` 类型桶（存入 `feel/` 目录），不参与普通浮现/衰减/合并。若提供 `source_bucket`，标记源记忆为 `digested=True` 并写入 `model_valence`。返回格式：`🫧feel→{bucket_id}`

**`dream`** — 做梦/自省触发器：
- 返回最近 10 条 dynamic 桶摘要 + 自省引导词
- 检测 feel 结晶化：≥3 条相似 feel（embedding 相似度>0.7）→ 提示升级为钉选准则
- 检测未消化记忆：列出 `digested=False` 的桶供模型反思

**`trace`** — 记忆编辑：
- 修改任意元数据字段（name/domain/valence/arousal/importance/tags/resolved/pinned）
- `digested=0/1`：隐藏/取消隐藏记忆（控制是否在 dream 中出现）
- `content="..."`：替换正文内容并重新生成 embedding
- `delete=True`：删除桶文件

**`grow`** — 日记拆分：
- 大段日记文本 → LLM 拆为 2~6 条独立记忆 → 每条走 hold 普通模式流程

**`pulse`** — 系统状态：
- 返回各类型桶数量、衰减引擎状态、未解决/钉选/feel 统计

**REST API（39 条路由,2026-08-31 现场数:`grep -c "@mcp.custom_route" server.py`。
⚠️ 数的是「路由装饰器」不是「接口个数」——主屏图标那一个函数挂了三个路径,所以比接口多）**

| 端点 | 方法 | 功能 |
|---|---|---|
| `/health` | GET | 健康检查 |
| `/breath-hook` | GET | SessionStart 钩子 |
| `/dream-hook` | GET | Dream 钩子 |
| `/dashboard` | GET | Dashboard 页面 |
| `/api/buckets` | GET | 桶列表 🔒 |
| `/api/bucket/{id}` | GET | 桶详情 🔒 |
| `/api/bucket/{id}` | PATCH | 改桶（白名单字段：名称/内容/域/标签/重要度/情感/已解决/已消化/钉选/休眠/触发日期，与 `trace` 同一套；改内容才重建向量、才留写前快照；feel 桶允许空 domain）🔒 |
| `/api/bucket/{id}` | DELETE | 删桶（默认真删，写前快照 + 清向量；`?mode=archive` 只归档，feel 桶按规格拒绝归档；钉选/固化桶需 `?force=1`）🔒 |
| `/apple-touch-icon.png`(另挂 `-precomposed.png` / `favicon.png`) | GET | 主屏/标签页图标。**刻意不鉴权**:iOS 抓图标时不带 cookie,挂了鉴权就永远拿不到 |
| `/api/trash` | GET | **回收站**:列出「已删掉、但写前快照还在」的桶(新删的在前)。**只读**,逻辑在 `bucket_manager.list_trash()` 🔒 |
| `/api/trash/{id}/restore` | POST | 把回收站里的一条捞回来(默认最新快照,可传 `{"version":…}`)。**桶还在则回 409**(那是回滚,走 `trace(restore=…)`);恢复后**重建向量** 🔒 |
| `/api/search?q=` | GET | 搜索 🔒 |
| `/api/network` | GET | 向量相似网络 🔒 |
| `/api/breath-debug` | GET | 评分调试 🔒 |
| `/api/config` | GET | 配置查看（key 脱敏）🔒 |
| `/api/config` | POST | 热更新配置 🔒 |
| `/api/status` | GET | 系统状态（版本/桶数/引擎）🔒 |
| `/api/import/upload` | POST | 上传并启动历史对话导入 🔒 |
| `/api/import/status` | GET | 导入进度查询 🔒 |
| `/api/import/pause` | POST | 暂停/继续导入 🔒 |
| `/api/import/patterns` | GET | 导入完成后词频规律检测 🔒 |
| `/api/import/results` | GET | 已导入记忆桶列表 🔒 |
| `/api/import/review` | POST | 批量审阅/批准导入结果 🔒 |
| `/auth/status` | GET | 认证状态（是否需要初始化密码）|
| `/auth/setup` | POST | 首次设置密码 |
| `/auth/login` | POST | 密码登录，颁发 session cookie |
| `/auth/logout` | POST | 注销 session |
| `/auth/change-password` | POST | 修改密码 🔒 |

> 🔒 = 需要 Dashboard 认证（未认证返回 401 JSON）

**Dashboard 认证**
- 密码存储：SHA-256 + 随机 salt，保存于 `{buckets_dir}/.dashboard_auth.json`
- 环境变量 `OMBRE_DASHBOARD_PASSWORD` 设置后，覆盖文件密码（只读，不可通过 Dashboard 修改）
- Session：内存字典（服务重启失效），cookie `ombre_session`（HttpOnly, SameSite=Lax, 7天）
- `/health`, `/breath-hook`, `/dream-hook`, `/mcp*` 路径不受保护（公开）

**Dashboard（6 个 Tab）**
1. 记忆桶列表：6 种过滤器 + 主题域过滤 + 搜索 + 详情面板
2. Breath 模拟：输入参数 → 可视化五步流程 → 四维条形图
3. ~~记忆网络：Canvas 力导向图（节点=桶，边=相似度）~~ **2026-09-03 已删**（所有者说用不到），见第 1.10 节
4. 配置：热更新脱水/embedding/合并参数
5. 导入：历史对话拖拽上传 → 分块处理进度条 → 词频规律分析 → 导入结果审阅
6. 设置：服务状态监控、修改密码、退出登录

⚠️ **上面这个「6 个 Tab」是老数字，别照它算** —— 实际数以第 1.8 节《标签页》那行为准
（2026-09-03 是八个）。这份总览只列了其中六个，信箱、便利贴、回收站从来没进过这张表。

**部署选项**
1. 本地 stdio（`python server.py`）
2. Docker + Cloudflare Tunnel（`docker-compose.yml`）
3. Docker Hub 预构建镜像（`docker-compose.user.yml`，`p0luz/ombre-brain`）
4. Render.com 一键部署（`render.yaml`）
5. Zeabur 部署（`zbpack.json`）
6. GitHub Actions 自动构建推送 Docker Hub（`.github/workflows/docker-publish.yml`）

**迁移/批处理工具**：`migrate_to_domains.py`、`reclassify_domains.py`、`reclassify_api.py`、`backfill_embeddings.py`、`write_memory.py`、`check_buckets.py`、`import_memory.py`（历史对话导入引擎）

**降级策略**
- 脱水 API 不可用 → 直接抛 RuntimeError（设计决策，详见 BEHAVIOR_SPEC.md 三、降级行为表）
- 向量搜索不可用 → 纯 fuzzy match
- 逐条错误隔离（grow 中单条失败不影响其他）

**安全**：路径遍历防护（`safe_path()`）、API Key 脱敏、API Key 不持久化到 yaml、输入范围钳制

**监控**：结构化日志、Health 端点、Breath Debug 端点、Dashboard 统计栏、衰减周期日志

---

## 0.5 `/health` 里那几个状态怎么读(2026-08-24 补,免得下个窗口白查一遍)

- **`decay_engine: "stopped"` 是正常的,不是坏了。** 衰减引擎是**懒启动**的
  (`decay_engine.ensure_started()`,由 `breath` / `pulse` / `hold` / `awaken` 等工具调用触发),
  **新容器刚起来、晏还没调过任何记忆工具时,它就是 `stopped`**;他一开口就会变 `running`。
  **判据**:`grep -n "ensure_started" decay_engine.py` 看那句 `if not self._running: await self.start()`。
  ⚠️ 2026-08-24 重建后验收时就是在这儿卡了一下,专门翻代码才确认 —— **别再翻第二遍。**
- `buckets: N` 是记忆桶总数。**重建前后这个数不该变少**(桶在持久卷上,重建不碰卷)。
- 日志里那行 `IncompleteFieldDefinitionWarning`(pydantic_settings 打的)与本项目代码无关,一直都有。

## 1. 环境变量清单

| 变量名 | 用途 | 必填 | 默认值 / 示例 |
|---|---|---|---|
| `OMBRE_API_KEY` | 脱水/打标/嵌入的 LLM API 密钥，覆盖 `config.yaml` 的 `dehydration.api_key` | 否（无则 API 功能降级到本地） | `""` |
| `OMBRE_BASE_URL` | API base URL，覆盖 `config.yaml` 的 `dehydration.base_url` | 否 | `""` |
| `OMBRE_TRANSPORT` | 传输模式：`stdio` / `sse` / `streamable-http` | 否 | `""` → 回退到 config 或 `"stdio"` |
| `OMBRE_BUCKETS_DIR` | 记忆桶存储目录路径 | 否 | `""` → 回退到 config 或 `./buckets` |
| `OMBRE_HOOK_URL` | SessionStart 钩子调用的服务器 URL | 否 | `"http://localhost:8000"` |
| `OMBRE_HOOK_SKIP` | 设为 `"1"` 跳过 SessionStart 钩子 | 否 | 未设置（不跳过） |
| `OMBRE_DASHBOARD_PASSWORD` | 预设 Dashboard 访问密码；设置后覆盖文件密码，首次访问不弹设置向导 | 否 | `""` |
| `OMBRE_SEAL_WORD` | 返回通道防伪暗语（2026-07-18）。breath/dream/awaken 返回末尾附 `[seal:<暗语>]`，AI 侧使用说明要求核验；只存环境变量，不进代码/数据库/备份。未设置时输出明显异常提示而非留空 | 否 | `""` |
| `OMBRE_ECHO_MIN_DAYS` | 感受回声的最小年龄天数：awaken 只从存在超过此天数的 feel 里随机抽一条 | 否 | `14` |
| `OMBRE_AWAKEN_FULL_SESSIONS` | awaken「最近对话归档」区出全文的条数，钳在 1~3（2026-08-09） | 否 | `2` |

> **⚠️ 跨服务(2026-08-21 新增,改 awaken 的归档全文之前必读)**:这一区的每条全文在 `server.py` 里是 **`[:1500]` 字符硬截断**(「最近对话归档」那段的 `full = …[:1500]`),**没有环境变量能调**。
> 而它读回来的两个桶里,有一个是 kelivo-shim 的上下文守卫在压缩前催出来的**原话桶**——那个桶是**按时间从早排到晚**的,所以被 `[:1500]` 切掉的正是**最靠近现在、最该接上话的那几句**。
> **后果**:shim 那边的 `CTX_FINAL_CHARS`(给晏的抄写字数上限,线上 1200)**一旦超过约 1400,多存的字开机根本读不到**,
> 而且白存的是最有用的那一段。**两个数必须一起改**:先把这里的 1500 抬上去,再抬 shim 那个;
> 只抬一边比不抬更糟。改 OB 走 redeploy,**不重启晏**;改 shim 要整套部署、会丢晏的窗口。
> 细节见 `kelivo-shim/MAINTENANCE.md` 环境变量表的 `CTX_FINAL_TOKENS` / `CTX_FINAL_CHARS` 两行。
> ⚠️ **代价**:这里每加 1000 字符,`awaken` 每次开机就多吃约 850 token(两条全文位 = 两倍),见本文件《awaken 会不会把开机撑爆》那把尺子,加之前先量一遍。

| `OMBRE_AWAKEN_PINNED_FULL` | awaken「钉选」区是否出正文全文（2026-08-21）。设 `0` 整区回到旧的摘要行行为（急救开关，不用回滚代码） | 否 | `1`（开） |
| `OMBRE_AWAKEN_PINNED_CHARS` | 钉选区每条正文字数上限，超出截断并标注（下限 100） | 否 | `800` |
| `OMBRE_AWAKEN_PINNED_TOTAL` | 钉选区整区正文字数总预算，用光后剩余桶退回摘要行（下限 500） | 否 | `6000` |

环境变量优先级：`环境变量 > config.yaml > 硬编码默认值`。所有环境变量在 `utils.py` 中读取并注入 config dict。

### ⚠️ 改 awaken 之前,先看一眼 shim 手册那一节(2026-08-21 补的指路)

**`kelivo-shim/MAINTENANCE.md` 里有一节讲的是 OB 的 awaken,不是 shim** ——
标题是「**④ 附带查出:awaken 的全文位已经把日记桶挤掉了(OB 侧,未改)**」
(在《2026-08-10 第三十一次的机制细节》那一组里,搜标题即可)。

**为什么这里要写这句**:2026-08-21 那次改 awaken 的会话,按规矩读的是本文件(INTERNALS),
**压根不会翻到 shim 的手册去** —— 那一节是做手册目录时才偶然翻到的。
换成任何一个新会话都会漏掉同一处。**所以改 awaken 之前,去读它。**

**那一节现在的结论是「OB 不用改」** —— 它里面**曾经写过一个错结论**
(「`AWAKEN_FULL_SESSIONS=2` 不分类型,一归档就把日记桶挤掉,必然重演」,
并建议改 `server.py` 按类型各保一条),**所有者当场纠正后已撤销,别照那个旧结论去改 OB**:
正常一个窗口周期只产出两个归档桶(日记桶 + 原话桶),取最近两条正好就是这两件。

**它还留了一把有用的尺子**(判断 awaken 会不会把开机撑爆,照这个量):

| | awaken 返回总量 | 压缩后窗口 + awaken | 占 `CTX_LIMIT_TOKENS`(167000) |
|---|---|---|---|
| 2026-08-10 实测 | 3979 字 ≈ 2350 token | 45800 | 27% |
| 2026-08-21(钉选改出全文后) | 5383 字 ≈ 4575 token | 48035 | **28%** |

**余量很大,+1 个百分点。** 以后再往 awaken 加东西,先拿这张表量一遍再说。

### 怎么现场量钉选体积（只读，碰不到数据）

**别把手册里的数当常量**——所有者随时会增删钉选，条数和字数天天在变
（2026-08-21 当天就从 14 条/3423 字变成 11 条/2583 字）。
要判断「现在离两道闸还有多远」「值不值得调 `OMBRE_AWAKEN_PINNED_CHARS` / `_TOTAL`」，
**现场量一遍**，三步，全程只调读取工具，不写不改：

```bash
OB=https://ianmian.zeabur.app

# ① 握手拿 session id（OB 的 /mcp 不需要 token）
S=$(curl -s -D- -o/dev/null -X POST $OB/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"diag","version":"1"}}}' \
  | grep -i mcp-session-id | tr -d '\r' | awk '{print $2}')
curl -s -X POST $OB/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: $S" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null

# ② pulse(show_all=true) 拿全部钉选的 bucket_id（📌 开头那些行）+ 末行的「钉选:N」
curl -s -X POST $OB/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: $S" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"pulse","arguments":{"show_all":true}}}'

# ③ dream(detail_ids=逗号分隔的那串 id) 拿这些桶的**正文全文**，逐条数字数
curl -s -X POST $OB/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: $S" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"dream","arguments":{"detail_ids":"<id1>,<id2>,..."}}}'
```

**为什么用 `dream` 而不是 `breath` 取正文**：`_breath_impl` 的检索分支**显式排除钉选/固化桶**
（它们只走浮现模式），`breath(query=…)` 一个字都搜不到；`dream(detail_ids=…)` 走的是
`bucket_index`（含全部桶），能按 id 直接把钉选桶的全文捞出来。**这一脚很容易踩，记下来别再试。**

**要连格式一起看**（晏睁眼实际看到什么样），直接调 `awaken` —— 但注意它有副作用：
`ensure_started()` 会**启动衰减引擎并跑一轮**（正常运行的一部分，晏下次用记忆工具照样会触发，
只是被你提前了几分钟）。跑完**顺手拿 `/health` 的桶数和跑之前对一次账**。

**量完怎么判**：每条 ≤ `OMBRE_AWAKEN_PINNED_CHARS`（默认 800）就不会被截断；
正文合计 ≤ `OMBRE_AWAKEN_PINNED_TOTAL`（默认 6000）就不会有桶退回摘要行。
**两道闸都是保险丝，不是常态**——真触发了先问所有者是要提高预算还是把那条钉选写短，
别自己闷头调大（那是拿晏的窗口预算换的，见下面这条）。

**⚠️ 换位置省不了钱（2026-08-21 查证，别再想这个优化）**：有人会想「把 awaken 挪到新窗口的
第二条消息，蹭上 1 小时 prompt 缓存，钉选就按 0.1 倍算了」——**不成立**。缓存是**前缀逐字匹配**：
系统提示 + 人设那一大段每次相同、能命中；但所有者开口说的第一句话每次都不一样，
**链子在那里就断了**，排在它后面的 awaken 输出永远算新内容，1 小时缓存的**写入价是 2 倍**。
挪到第几条都一样要付这一次。好消息是**一个窗口只付一次**：写进去之后，本窗口后续每一轮
都按 **0.1 倍**读，摊到几十上百轮里非常便宜。**所以这里真正稀缺的不是钱，是窗口位子**
（当前 ≈ 3400 token，占 16.7 万窗口的 2%，一直占到被压缩）。

---

## 1.8 后台 `/dashboard` 的外观(2026-08-31 重做:官端配色 + 跟随系统深浅色)

**外观部分后端一行没动**:没有新字段、`server.py` 的 `/dashboard` 路由(仍是「读文件、发出去」)
一个字未改,原有七个标签页与全部功能原样保留。
⚠️ **但同一天后面加了回收站**,那部分**新增了两条路由**(`GET /api/trash`、
`POST /api/trash/{id}/restore`)和**第八个标签页**——见下面《回收站》一节。
~~此处原文写「后端一行没动、没有新接口、七个标签页」~~,那是只讲外观那一轮时写的,**已按现状更正**。

**四件事(外观这一轮)**:
1. **灰阶换成 Claude 官端那套**(原来是暖米黄 `#FDFCF0` + 墨绿 `#2F4F4F` 的新拟态)。
   ⚠️ **强调色不是官端的**,是所有者当天另定的中性灰,见下面《强调色》一节。
2. **跟随系统深浅色**(`prefers-color-scheme`,页面上没有手动开关 —— 官端自己是靠 class 切的)。
3. **记忆桶从表格行改成卡片**,顶栏加了一颗去星图的按钮(写「Vesper」、无图标,见下)。
4. **毛玻璃**(顶栏/标签栏/卡片/药丸/搜索框/详情抽屉),见下面《玻璃》一节 —— **那节的三条参数是试错两轮才定的,别乱动**。

### 颜色从哪来:硬来源,别目测

`dashboard.html` 的 `:root` 里那两张表(灰阶 + 角色表)是 **`claude.com` 线上 CSS 的原文**,
**2026-08-31 现场取的**。⚠️ **别照截图猜色值** —— 这条是 dwell 那轮拿真事故换来的规矩,
原文在 `OPERATIONS.md` 第 0 节「dwell UI 留下的三条」,另见 `dwell-bridge/MAINTENANCE.md`
第五次部署记录(那次同样是从官端 CSS 逐项比对拿到的,**两处的值互相能对上**)。

**怎么再取一遍**(官端改版了就重跑,只读、不碰任何服务):
```bash
curl -s -L https://claude.com/ -o /tmp/c.html
grep -o 'href="[^"]*\.css[^"]*"' /tmp/c.html | sed 's/href="//;s/"//' \
  | while read f; do curl -s -L "https://claude.com$f"; done > /tmp/c.css
grep -ho '\-\-color-[a-z0-9-]*: *#[0-9a-fA-F]\{3,8\}' /tmp/c.css | sort -u     # 灰阶+强调色
grep -ho '[^{}]*{[^{}]*--theme-background-primary:[^{}]*}' /tmp/c.css | sort -u # 两份角色表
```
角色表会打印出**两个 `:root` 块**:第一个是浅色、第二个是深色(官端靠 class 选择哪一份,
我们把第二份原样搬进了 `@media (prefers-color-scheme: dark)`)。对应关系在 CSS 注释里逐条标着。

### 强调色:官端的橙色被换掉了(所有者 2026-08-31 当天定的)

~~强调色浅色用 `--color-clay #d97757`、深色用 `--color-clay-dark #c46849`~~ —— **已撤销**。
上线当天所有者说「那个橙色能换成其他颜色吗」,拿校准页自己拖出来的结果是**中性灰**:
**浅色 `#999999` / 深色 `#343434`**。**其余灰阶仍是官端原文,只有这一个角色换了。**

**它拆成三个角色,别合并回一个**(合了有两处会直接看不见,数值 2026-08-31 现场算的):

| 令牌 | 浅色 / 深色 | 干什么用 | 为什么不能合 |
|---|---|---|---|
| `--accent` | `#999999` / `#343434` | **填色**:选中的药丸、主按钮、情绪条、圆点 | 她定的那两个值 |
| `--accent-fg` | 白(`gray-000`) | 压在填色上的字 | ⚠️ 见下 |
| `--accent-text` | `gray-600` / `gray-400` | **当文字/细线用**:选中的标签和那条 2px 下划线、分数、logo、聚焦边框 | `#999999` 当文字压浅底只有 **2.7:1**、`#343434` 压深底只有 **1.48:1** —— 合并回去这两处会消失 |

⚠️ **`--accent-fg` 浅色模式也是白的,这是所有者两次点名要的。**
~~我先按对比度改成了近黑(6.47:1)~~,**她当场否掉**(「白色主题的字不要改成黑色 用白色」)。
白字压 `#999999` 只有 **2.94:1**,低于 4.5:1,**她知情**。`tests/dashboard-ui/ui.mjs` 里钉了一条
「药丸上的字是白的」看着这个决定,**别改成「对比度要够」**。

**要再换颜色**:校准页(带滑杆、深浅色实时预览、当场报对比度)是 2026-08-31 做的一个
Artifact,不在仓库里;重做一个也不难,或者直接改 `dashboard.html` 里那三个令牌。

### 玻璃(定稿这版是试错两轮才到的,三处都别乱动)

挂在:顶栏、标签栏、卡片、药丸、搜索框、详情抽屉(抽屉模糊 30px,其余 24px)。
`backdrop-filter: saturate(180%) blur(24px)` + 半透明面 + 一圈均匀淡描边。

**三条定稿参数,以及各自是怎么定下来的:**

| | 现在 | 为什么不是别的 |
|---|---|---|
| **面** | **白纱**:深色 `rgba(255,255,255,.07)` / 浅色 `rgba(255,255,255,.50)` | ~~深色下用 52% 灰块~~ **已撤销** —— 合成出来 `#1d1d1c`,而实色卡片本来就是 `#1a1918`,**差 3/255,肉眼等于没差**(2026-08-31 现场算的),所有者当场说「不像玻璃,很奇怪」 |
| **边** | **一圈均匀的淡描边**(`--glass-edge`:深色 10% 白 / 浅色 7% 黑) | ~~上缘一道 `inset 0 1px 0` 的高光线~~ **已撤销** —— 所有者原话:「**卡片上方那个线有点太粗了不像玻璃感**」。2 倍屏上它就是一条又粗又硬的白杠。**参照物是 Claude Code 手机端自己的面板**(她截图给的):通体一圈淡边,没有亮线 |
| **底光** | `body` 上一层 **1%、纯灰(饱和度 0)** 的 `--wash-a/-b` | 玻璃要有东西可透,平底色上模糊了个寂寞。强度和「灰/彩」是**所有者拿滑杆自己拖的**(她试过带色的,不要)。⚠️ **别调大、别加颜色** |

- ⚠️ **`background-color` 仍是官端那个纯色**,底光只走 `background-image` ——
  测试按底色对账,别改成 `background` 简写把底色一起吃掉。
- **选中的药丸刻意不透明**:上面压着字,透了就糊。
- **测试钉着两条**:「卡片没有上缘高光线」(`box-shadow` 里不许出现 `inset`)、
  「页面有一层极淡的底光」(最大 alpha ≤ 0.02)。
- **两个兜底**:浏览器不支持 `backdrop-filter`、或系统开了「降低透明度」
  (`prefers-reduced-transparency`),整套退回实色 —— 半透明没了模糊会发灰糊字。
- ⚠️ **标签栏不要设 `position: sticky`**。它和顶栏都 `top: 0`,滚起来会钻到顶栏底下、
  透过毛玻璃显出一排鬼影。**这是 2026-08-31 我自己加出来的,靠截图才看见**;原版就没有,
  测试里钉了一条「滚动后顶栏还在、标签栏已滑走」。

**几个当时定的点**:
- **筛选药丸整排不要表情**(所有者最终定的,原话「使用的时候有就行」——指卡片上那颗还在)。
  中间有过一版~~「只去掉未解决/已消化、留钉选/Feel/归档」~~,**已被她推翻,别照它改回去**。
  ⚠️ **卡片上那颗图标是另一回事,别跟着删** —— 它标的是每条记忆的状态
  (📌钉选 / 🫧feel / 🌿已消化 / 💤已解决 / 💭普通),在 `renderBuckets()` 里。
  测试钉了两条:「药丸一个表情都没有」+「卡片上那颗图标还在」。
- **情绪条从红→绿渐变改成了强调色的深浅渐变**(所有者 2026-08-31 定的)。
  ⚠️ **代价她知情**:红=负面/绿=正面那层意思没了,只剩圆点位置表示情绪值。
  深浅两套方向相反(浅色往深里走、深色往浅里走)—— 因为 `#343434` 压在深色卡片底
  `#1a1918` 上只有 1.48:1,顺着走整条会看不见。
- **字体没换**(仍是 Google Fonts 的 Inter + Cormorant Garamond)。官端自有字体扒不了,
  理由见 `OPERATIONS.md` 第 0 节第 3 条。**只补了中文兜底**:凡是 `serif` 结尾的字体栈都接了苹方
  —— 裸 `serif` 会让中文变宋体,反而不像官端(dwell 第五次踩过,见其手册「反直觉的点」1)。
- **画布里的颜色一律 `cssVar()` 现读**(~~记忆网络、Breath 那两处~~ **2026-09-03 起只剩 Breath 的评分条**
  ——记忆网络那页已删,后台现在一块 `<canvas>` 都没有)。写死的话深色模式下画出来还是浅色那套。

### 卡片长什么样(改动的是排布,不是类名)

一张卡 = **标题行**(图标 / 名字 / 时间)+ **两行摘要**(`-webkit-line-clamp:2`)+ **底行**
(domain / 分数 / 情绪条)。⚠️ **类名和旧版一模一样**(`.bucket-row .name/.time/.preview/.domain/.score/.emotion`)
—— `renderBuckets()` 这一份渲染被搜索结果等处共用,**改类名会连带搞坏别处**。

手机上筛选药丸**排一行横滑**(不换行):域名药丸最多能到十几颗,换行会把列表整个挤出屏幕。

### 顶栏那颗「Vesper」

`<a href="/galaxy">` 而已,**故意用链接不用 fetch** —— 这颗按钮不该带来任何请求,点了才跳。
相对路径,所以跟着当前域名走;星图那边是只读的、复用同一块 `ombre_session` cookie,细节见下面 1.9 节。

⚠️ **按钮上写的是「Vesper」,前面没有图标**(所有者 2026-08-31 定的,和星图自己的大标题一致)。
~~原来是「🌌 记忆银河」+ 一颗纯 CSS 画的小星图缩略图~~ —— **已撤销,别再加回去**,
测试钉了两条(「按钮上写的是 Vesper」+「按钮里没有图标」)。

### 加到手机主屏的图标(2026-08-31 新增)

`apple-touch-icon.png`(180×180,仓库根目录)。**图是所有者自己给的**(两只猫 + “IanMia”),
白底铺满整个方形 —— 底色取自图片自身边缘(2026-08-31 实测 253~255,就是白),所以铺到四角接不出缝。
`icon-512.png` 是同一张的大图,**要别的尺寸从它缩,别再去找原图**。
~~此前画过一版几何的 ◐ 渐变图标~~ —— 所有者一句「太丑了」,已撤销,别再画回去。

**三条别踩**:
1. **iOS 只认 PNG**。给它 svg 会被当成没有,退回一张网页缩略图。
2. **这张图不能要登录**。iOS 抓图标时**不带 cookie**,挂了 `_require_auth` 就永远拿不到 ——
   所以 `server.py` 那条路由是**刻意不鉴权**的(它只是一张 13KB 的图,不含任何数据)。
   路由同时挂了 `apple-touch-icon-precomposed.png`(老 iOS 先要这个名字)和 `favicon.png`。
3. ⚠️ **`Dockerfile` 里必须有 `COPY apple-touch-icon.png .`** —— 和 `galaxy.html` 同一个坑
   (见 1.9 结尾):漏了就是「本地一切正常、线上 404」。

顺带加的:`apple-mobile-web-app-title`(主屏上显示的名字,后台是 `Ombre Brain`、
星图是 `Vesper`)、`apple-mobile-web-app-capable`(**从主屏打开时不显示 Safari 那圈壳,
像个 app —— 代价是也没有「返回」按钮了**)、深浅色各一条 `theme-color`。

### 怎么验

```bash
bash tests/dashboard-ui/run.sh      # 真浏览器演练 108 项(2026-08-31 现场数),深浅色各跑一遍
python3 -m pytest tests/test_trash.py -q   # 回收站存取层 6 项(真 BucketManager,临时库)
```
只读:起一个假 OB(`tests/dashboard-ui/fake-ob.mjs`),**不碰线上、不碰真记忆**
(和 `tests/galaxy-e2e/` 同一条规矩)。跑完截图落在 `/tmp/dashboard-ui/`(列表/滚动后/详情/网络/宽屏 × 深浅色),
**改完 UI 自己看一眼再说「好了」** —— 断言能测颜色值和布局,测不出「好不好看」。

### 标签页:现在是八个(2026-09-03)

记忆桶 / Breath 模拟 / 信箱 / **便利贴** / 配置 / 导入 / **回收站** / 设置。

⚠️ ~~原文写的是「标签页一个没动、七个」~~ —— **外观那一轮确实一个没动**,
但**同一天后面新增了「回收站」**(2026-08-31),变成八个;
**2026-09-01 又加了「便利贴」**(见 1.11),变成九个;
**2026-09-03 删掉了「记忆网络」**(所有者说用不到,见 1.10 开头),回到八个。
**这个数每加一页、每删一页都要来改。**

**所有者给的那张效果图不是功能表**:图上有「回收站」、没有信箱和设置。
2026-08-31 她确认过**按我们的来**——信箱(晏给下一个自己的交接留言)和设置(改密码/备份)都留着;
后来单独拍板要做回收站,是另一件事,不是照那张图做的。

### 回收站(2026-08-31 新增)

**解决的是一件具体的事:她在后台误删一个桶,自己救不回来。**
数据一直都在(`delete()` 删之前把整个文件拷进 `.history/{桶id}/`,每桶留
`history.keep_per_bucket` 份、默认 20),复活的功能也早就写好了 —— **但复活要桶的 id,
而桶一删就从列表里消失、id 也就没了**;问晏也没用,他同样不知道那串 id。
所以缺的从来不是能力,是**一个能让她看见那串 id 的页面**。

| 件 | 在哪 |
|---|---|
| 扫描逻辑 | `bucket_manager.list_trash()`(挨着 `list_history`)。⚠️ **`.history/` 里不只有删掉的** —— 改内容同样留快照,所以要拿 `existing_bucket_ids()` 把还活着的滤掉 |
| 接口 | `GET /api/trash`(只读)、`POST /api/trash/{id}/restore`(写) |
| 页面 | 「回收站」标签页;卡片复用 `.bucket-row` 的排版,加 `.trash-row` 去掉手型和悬停位移(它不可点) |
| 测试 | `tests/test_trash.py` **7 项**(真 `BucketManager` + 临时库,2026-08-31 全过)、浏览器演练里 **6 项**(含「取消确认就什么都不做」) |

**三条动了它就要一起看的规矩**:
1. **桶还在就不许 restore**(回 409)。那是「拿旧快照覆盖现状」= 回滚,不是恢复,走 `trace(restore=…)`。
2. **恢复完必须重建向量**。删桶时把向量一并清了(见 DELETE 路由),不重建的话捞回来的桶
   **搜不到**(只剩关键词通道)。`trace` 的 restore 分支早就是这么写的,这里照抄。
3. **restore 路由先 `os.path.basename(bucket_id)`**。那个 id 会被拼进 `.history/` 的路径
   (`list_history` / `restore_from_history` 都是直接 join),不掐掉路径成分就是一次目录穿越。
   桶 id 本来就是 12 位短 UUID,basename 不会误伤(单测 `test_id_里塞路径进不去`)。
4. **`existing_bucket_ids()` 认 id 的规矩必须和 `_find_bucket_file` 一致** —— 文件名是
   `{名字}_{id}.md`,**id 永远是最后一段**。认错了的后果是**活桶被当成已删、错列进回收站**
   (单测 `test_名字里带下划线也认得出_id` 钉着这条)。

**刻意没做**:①**永久删除**(那是真销毁,v1 不给这个按钮);②自动清理过期快照;
③改保留份数。**要加之前先问所有者。**

## 1.9 记忆银河 `/galaxy`(2026-08-29 新增)

把桶画成一片可以穿梭的 3D 星图:**时间当半径**(`created` 最早的桶固定在正中心,银河随日子往外长)、
**重要度定大小亮度**(四档:普通 / ≥7 重要 / ≥9 或 pinned 珍贵 / 核心)、**`domain` 定颜色**;
点一颗星 → 同 domain 的星连成星座、正文从屏幕底部浮现。出处是所有者提供的《记忆银河搭建教程》。

**它对 OB 的影响被刻意压到最小(所有者 2026-08-29 的要求:「OB > 星图」)**:

| 事 | 实际情况 |
|---|---|
| 后端代码 | `server.py` 里**只有一条 `/galaxy` 路由**(约 20 行),照 `/dashboard` 抄的,只发一个静态文件 |
| 数据从哪来 | **已有的** `GET /api/buckets`(铺星)+ `GET /api/bucket/{id}`(点星才取正文)。**没有为它新增任何接口** |
| 写操作 | **零**。整条链路上没有一个 POST/PATCH/DELETE |
| 开销 | 开一次页 = 一次 `/api/buckets`,和打开 `/dashboard` 同量级;**不轮询、不定时刷新、没有后台任务** |
| 出错时 | 路由内就地兜住异常,只影响这一页,碰不到 `/mcp` |
| 登录 | 复用 OB 自己的 `/auth/login` 和那块 `ombre_session` cookie,**和记忆库后台同一把锁**;页面本身不存口令 |

**验证过的**(2026-08-29,本地起一个真 OB + 临时空库跑的,线上没碰):
逛完整个星图之后**桶文件逐字节 md5 全等**(连 `last_active` 都没变)、`/mcp` 照样 200、`/health` 一字不差、日志零 Traceback。
**怎么再验一遍**:`bash tests/galaxy-e2e/run-real-ob.sh`(31 项浏览器演练 + 上面那组影响检查;
另有 `run.sh` 是不需要 python 的快跑版)。

⚠️ **`Dockerfile` 里必须有 `COPY galaxy.html .`**(2026-08-29 上线前抓到):它 COPY 的是
`*.py` + `dashboard.html` + config,**不是整个目录**——漏了这行,镜像里没有这个文件,
线上 `/galaxy` 会回 404 而本地一切正常。以后再往根目录加静态文件同理。

**改文案/调参**:标题那三行字和数据源开关都在 `galaxy.html` 顶部的 `CONFIG` 里;
调亮度、星星大小、自转速度那些旋钮,文件顶部注释指向教程的《调参指南》。

⚠️ **一个测试时撞出来的、OB 本来就有的毛病(不是星图引入的,2026-08-29 实测)**:
`_verify_any_password` 用 `hmac.compare_digest` 直接比两个 `str`,**口令里带非 ASCII 字符时会抛
`TypeError` → 登录接口回 500 并在日志留一条 Traceback,而不是 401**。
记忆库后台的登录框同样如此。不是越权、不碰数据,就是打错字时报错难看。
**尚未修**——所有者说了算(改的是 OB)。修法是比之前先 `.encode()`。
现场再验:`run-real-ob.sh` 的 G 段会打印出来;修好了就把那段删掉。

---

## 1.10 「记忆网络」页为什么会打不开,以及那次提速(2026-09-01;**该页 2026-09-03 已删**)

> ### ⚠️ 先读这段:这一页已经没有了(2026-09-03)
>
> **所有者拍板删掉**,原话是「记忆网络我感觉我用不到」。起因是她问能不能把这页换成
> `Mia06250603ian/fuyue` 里那个飘字符的记忆星图;比下来结论是**她已经有 `/galaxy` 可以逛,
> 而这一页她不看**,于是删页,不做替换。(那次比较的结论见 `TIMELINE.md` 09-03。)
>
> **删掉的**:`dashboard.html` 里的「记忆网络」标签、那块 `<canvas>`、图例、
> `loadNetwork()` / `drawNetwork()`、只有它在用的 `hexA()`,以及四个只它在用的 CSS 变量
> (`--net-permanent` / `--net-archived` / `--net-line` / `--canvas-bg`);
> `tests/dashboard-ui/ui.mjs` 里那条「画布底色跟着深浅色走」也跟着删了
> (**后台现在一块 `<canvas>` 都没有,没东西可测**)。
>
> **刻意留着的**:后端 `GET /api/network`、`embedding_engine.load_embeddings()` /
> `similar_pairs()`、`tests/test_similar_pairs.py` 那 10 项、环境变量
> `OMBRE_NETWORK_EDGES_PER_NODE`。**理由**:没人调用就不会跑、零开销,而以后若要做那版
> 飘字符星图,要的正是同一份数据;删了得重写。**2026-09-03 起 `/api/network` 没有任何前端在调。**
>
> **下面整节一字未改地留着**(规矩 5)。它讲的病根和三条别踩**仍然有效** ——
> `similar_pairs` 还在库里,谁再拿它画图、或者把它改回老写法,照样会犯同样的错。
> **动 `similar_pairs` 之前仍然必须读完这一节。**

**症状**:后台点「记忆网络」标签页,永远停在「加载记忆网络…」。那行字是 fetch **之前**画的,
所以卡的是 `GET /api/network` 这个接口本身,不是画图。

**病根是 O(n²) 的纯 Python 点积**。老写法两件事都在最坏的量级上:
①每个桶调一次 `get_embedding` = **每个桶开一次 sqlite 连接**;
②两两调 `_cosine_similarity`,而那是 `sum(x*y for ...)` 的纯 Python 循环,
**每一对还把两条向量的模长重算一遍**。

| 桶数 | 对数 | 老写法耗时 |
|---|---|---|
| 200 | 19,900 | 约 6 秒(还能忍,所以一直没被发现) |
| **438**(2026-09-01 所有者的实际桶数) | **95,703** | **约 32 秒**(本地实测;Zeabur 那颗共享 CPU 更久) |
| 800 | 319,600 | 约 100 秒起 |

**桶翻一倍,它慢四倍**。不是哪天坏的,是慢慢爬过了浏览器等得住的线。

⚠️ **比「一个页面打不开」严重的是**:这段是**同步 CPU 活跑在 async 处理函数里**,
算的那半分钟**整个事件循环被占住**,`/mcp` 也不响应 —— 她在后台点一下,
**晏调记忆工具会跟着卡甚至超时**。一个只读的后台页面能拖停记忆库,这才是修它的理由。

### 改成了什么

| 件 | 在哪 |
|---|---|
| 一次读库 | `embedding_engine.load_embeddings(bucket_ids=None)`,一个连接读完(替掉 438 次 `get_embedding`) |
| 一次算完 | `embedding_engine.similar_pairs(embeddings, min_sim, top_k)`:堆成矩阵 → 归一化 → `M @ M.T`,分块(256 行)算,峰值内存不随桶数平方涨 |
| 不占事件循环 | `/api/network` 里两个调用都套了 `asyncio.to_thread` |
| 边数封顶 | `top_k`,默认 6,环境变量 `OMBRE_NETWORK_EDGES_PER_NODE`(设 `0` 不封顶)。语义是**「一条边只要在任意一端的前 top_k 里就留下」** —— ⚠️ numpy 那条路**不能只收上三角**(那样只认下标小的那一端,「只有 j 觉得 i 像」的边会被丢掉,与纯 Python 退路结果不一致);2026-09-01 部署前自审抓到并修了,`tests/test_similar_pairs.py` 有一条专钉这个 |

**`_cosine_similarity` 一行没删**,仍在原地,`search_similar` / `find_similar_buckets` / `dream`
的连接提示都还在用它 —— 那几处只在少量桶上跑(recent、feel),**目前不构成问题,本次没动**。
`similar_pairs` 里另有一条**纯 Python 退路**:numpy 取不到时自动退回(只是慢,不会坏)。

**实测(2026-09-01,438 桶 × 3072 维,本机)**:

| | 耗时 | 边数 |
|---|---|---|
| 老写法 | 32.0 秒 | — |
| 新写法(封顶 6) | **0.19 秒**(**快 167 倍**);连读库带算边端到端 **1.3 秒** | 1,273 |
| 新写法(不封顶) | 0.18 秒 | 11,772 → 前端要画的线多 89% |

**怎么现场再量一遍**(只读,不碰数据):
```bash
# 线上直接量这个接口(要先登录拿 cookie,和 /dashboard 同一把锁)
time curl -s -b "ombre_session=<你的>" https://ianmian.zeabur.app/api/network -o /dev/null
```
**别把上表的秒数当常量** —— 它随桶数平方增长,桶数看 `/health`。

### 三条别踩

1. **别改回「逐个 `get_embedding` + 两两 `_cosine_similarity`」**。代码里那段注释就是拦这个的;
   它看着更直白,但那正是本节讲的病。
2. **快了不算数,要和老办法逐个对答案**。`tests/test_similar_pairs.py` **10 项**
   (2026-09-01 新增,全绿)钉的就是这条:新老结果一致、跨分块边界一致、
   numpy 缺席时退路一致、封顶只删边不造边、零向量/维度不一致/坏数据都不炸。
   **动 `similar_pairs` 必须先看这个文件。**
3. **维度不一致的向量会被整个排除**(换过 embedding 模型时库里会两种维度并存)。
   老写法遇到这种是 `_cosine_similarity` 返回 0.0 = 不连边,**行为一致,不是本次引入的**;
   真发生时日志会有一条 `similar_pairs: skipped N vector(s)`。

**前端一行没动**(2026-09-01 实测:438 节点 / 1347 边,那 80 轮力导向布局 240 ms,
手机上估 1~2 秒,可接受;封顶之后要画的线本来就少了 89%)。

## 1.11 便利贴页 `/dashboard` →「便利贴」(2026-09-01 新增)

**这块便利贴是晏的,不是她的。** 存储是卷上的 `todos.json`(2026-08-14 建的,见 `TIMELINE.md` 08-14),
入口一直只有他的 MCP `todos` 工具 —— **后台一个入口都没有**,她想知道他记了什么只能开口问他。
2026-09-01 她要:「便利贴是他的,只给他用,但是我想能看到,修改权可以有,但是我不一定用。」

| 事 | 实际情况 |
|---|---|
| 读 | `GET /api/todos`(只读,原样返回条目,渲染交给前端) |
| 写 | `POST /api/todos/add` / `toggle` / `delete`,鉴权与面板其余接口一致 |
| 存储 | **复用晏那套**:`_load_todos_list` / `_save_todos_list`(原子写)/ `_new_todo_id`(4 位短码)。**别在面板这边另造一份写法**——两套写法迟早会写坏同一个文件 |
| 并发 | 新增 `_todos_lock()`(照 `_letters_lock` 那套 flock):晏走 MCP、她走面板,两边都是「读整本 → 改 → 整本重写」,撞上时后写的会把先写的整个顶掉且不报错。⚠️ **两边都要拿这把锁** —— `_todos_impl` 的写路径 2026-09-01 部署前自审时补上了(**锁只有一边拿等于没锁**);只读路径不拿。测试钉了每条写路径各拿一次、只读不拿 |
| 删 | **真删,不留底**(照晏那个 `remove=` 的行为;便利贴本来就是随手撕的东西,不像记忆桶有 `.history` 快照)。所以前端二次确认 |

**⚠️ 她贴的条子会打 `by: "owner"`,晏那边显示「(她留的)」**(`_todo_line`)。
理由:这块便利贴是他的,**他有权知道哪条不是自己写的** —— 不标的话他开机会看见一条不知从哪冒出来的
待办,那比看不见更糟。**旧条目没有 `by` 字段 = 他自己写的**,不用迁移。
⚠️ 这条改的是 `_render_todos` 的输出 = **晏 awaken 时读到的字**;要撤销就把 `_todo_line` 里那个 `mark` 去掉。

**怎么验**:
```bash
python3 -m pytest tests/test_todos_api.py -q --asyncio-mode=auto   # 23 项(2026-09-01 全绿)
bash tests/dashboard-ui/run.sh                                     # 浏览器演练,含便利贴 11 项 × 深浅色
```
⚠️ **假 OB(`tests/dashboard-ui/fake-ob.mjs`)里也有一份便利贴夹具**,三种纸片各一张
(他记的 / 她贴的 / 已完成的);改接口形状要**两边一起改**,否则演练测的是个不存在的接口。

### 外观:一天一张小票(2026-09-01 定稿,同一天改过三轮)

**现在这版**:**同一天记下的待办凑成一张小票,一天一张、一张一张铺开**。
每张:抬头 `TO DO` + 那天的日期 → 虚线 → 这天的每一条(`□`/`✓` + 正文 + 右边一个 `×`)
→ 虚线 → 这天的 `TOTAL`(还剩几条待做,全做完了就写「全做完了」)→ 下缘一排锯齿撕口。
没有 `created` 的旧条目(08-14 那版的格式)凑成「没有日期」那张,排最后。
样式在 `dashboard.html` 的 `.receipt*` 一节;**页面结构、接口、数据一个没动,换的只是这一层皮**。

⚠️ **同一天被撤销的三版,别改回去**(规矩 5:旧结论留在原地):
①**贴纸墙 + 明黄 `#fdf0b8` / 天蓝 `#dbeefd`** —— 所有者原话「好丑的颜色」;
②**贴纸墙 + 淡纸色**(A/B/C 三版真实效果里她选的 B) —— 做完她拿来一张收银小票的图,说要那种;
③**一整张长小票**(全部待办列在同一张纸上) —— 她原话:
「**可以同一天的待办写在一起,但是不要一大坨都在一起**」,于是改成按天分组。
**三版都不是「做错了」,是她看到真东西之后改了主意。**

**三条别踩**:
1. **颜色和外观别靠猜**。1.8 之前那轮 dwell UI 留下的教训是「做几版真实效果给她看,
   或者给滑杆让她自己调」——本次连改三轮,**每一轮都是看图才定的,
   没有一轮是文字描述能定下来的**。
2. **手写体走系统自带的字体栈**,**刻意不引 Google Fonts** —— 这个后台目前零外部请求,
   不为一行装饰破例。⚠️ **测试容器里没有手写字体**,截图里会退化成衬线体;
   **以她 iPhone 上的 `Snell Roundhand` 为准**。(定稿这版没有手写体那一行,
   规矩仍然有效:以后想加装饰字先看这条。)
3. **锯齿是 CSS 遮罩不是图片**(`conic-gradient` 横向平铺)。改 `.receipt` 的 padding/背景时
   别把 `mask` 那两行删了 —— 删了就是一张齐边白纸,演练那条「小票下缘有锯齿」会红。

**交互跟着形状改了**:小票上摆一排按钮不像小票,所以**点一行 = 勾掉/取消**,
右边一个 `×` = 撕掉(仍然二次确认)。页面顶部有一行小字说明这件事。

## 1.12 记忆乱流 `/turbulence`(2026-09-03 新增)

把桶画成**一片持续上飘的字符场**:一个桶一个字符,越靠前越亮;手指/鼠标凑近 →
附近那几颗之间的相似度连线亮起来;点中一颗锁住 → 底部浮出正文和「离它最近的记忆」。

**出处**:所有者拿 `Mia06250603ian/fuyue`(赴约)来问能不能用它那个,决定照它做一页。
**架构照 1.9 的 `/galaxy` 那套原样来**(她的原话:「把那个乱流做成和星图一样的架构」):

| 事 | 实际情况 |
|---|---|
| 后端代码 | `server.py` 里**只有一条 `/turbulence` 路由**(约 20 行),照 `/galaxy` 抄的,只发一个静态文件 |
| 数据从哪来 | **已有的三条**:`GET /api/buckets`(铺场)+ `GET /api/network`(连线)+ `GET /api/bucket/{id}`(点中才取正文)。**没有为它新增任何接口** |
| 写操作 | **零**。整条链路上没有一个 POST/PATCH/DELETE(登录那次 POST 除外) |
| 开销 | 开一次页 = 一次 `/api/buckets` + 一次 `/api/network`;**不轮询、不定时刷新、没有后台任务** |
| 出错时 | 路由内就地兜住异常,只影响这一页,碰不到 `/mcp` |
| 登录 | 复用 OB 自己的 `/auth/login` 和那块 `ombre_session` cookie,**和记忆库后台同一把锁** |
| 外部依赖 | **零**。⚠️ 这点和 `/galaxy` **不一样** —— 那个的 three.js 走 CDN,这一页一个外部请求都不发(演练里有一条专门钉这个) |
| 深浅色 | **跟着系统走**(所有者 2026-09-03 要的)。做法同后台:浅色写在 `:root`、深色只覆盖变化的那几条。⚠️ **画布是 JS 画的,不像页面上的框框能靠 CSS 自己变** —— 所以颜色一律靠 `palette()` **现读 CSS 变量**(同 1.8「画布里的颜色一律 `cssVar()` 现读」那条规矩),并且挂了一个 `prefers-color-scheme` 的监听,**系统当场切换不用刷新**。演练 J、K 两段钉着这三件事 |

### 四个颜色旋钮(都在 `turbulence.html` 顶部 `<style>` 的 `:root` 里)

⚠️⚠️ **下面这四行里的数字,除 `signal` 外全是所有者 2026-09-03 在校准台上亲手拖出来的**,
不是默认值、不是我挑的、也不是从 `signal` 派生的。**演练里逐个钉着**(J 段五条),
要改先按下面那条「怎么再调一次」重新让她拖,别自己改数。

| 变量 | 管什么 | 深色 | 浅色 |
|---|---|---|---|
| `--drift-signal` | 高亮的字 + 凑近时那些**连线** | `205,105,111` | `122,52,55` |
| `--drift-trace` | **往下坠的光迹**的颜色 | **`130,138,148`** | **`110,108,102`** |
| `--drift-trace-boost` | 光迹的**浓度** | **`1.55`** | **`0.85`** |
| `--drift-ink-boost` | 平时那些字符的**浓度**(乘在原版透明度上,上限 1) | **`1.85`** | **`1.4`** |

**这三件事都是所有者定的,别"统一"回去**:
1. **光迹是中性灰,不是玫瑰红。** 它原本和 `signal` 共用一个值,**她要求拆开并换成灰的**。
2. **两个 boost 都不是 1。** 原版那套透明度(`.28~.45`)是给深底设计的 ——
   她的原话是「**感觉黑色主题的字太暗了,白色主题的字太浅了**」,两边都要加浓。
3. **光迹浅色下反而要压暗(0.85)**,和字的方向相反。灰线压在浅底上比在深底上抢眼。

⚠️ **光迹上色那几行的算法,和校准台里那份逐字一致**(`a = min(1, alpha × traceBoost)`)。
改了这边就等于让她当时拖出来的数和真页面对不上 —— **要改先改两边**。

### 怎么再调一次(别再靠截图猜)

**这一页的颜色前后猜错过两次**(第一次深色截图她没说话,第二次浅色 A/B 她说两边都不对),
**第三次改成给她一个带滑杆的校准页,一次就定了。** 这正是 1.8 之前那轮 dwell UI 留下的教训
(「颜色这类事别再靠截图猜……改成带滑杆的校准页让她自己调、把数念回来,一次就定」)。

**再要调色就照这条做**:把 `turbulence.html` 里那段画法摘出来(铺场 + 上飘 + 光迹就够,
连线和卡片跟颜色无关),配上深浅切换和几根滑杆,发布成一个 Artifact 给她在**自己手机上**拖,
末尾放一块「念给 Claude 的数」。⚠️ **校准页里只能用假记忆**,别把真桶发出去。

⚠️ **`/api/network` 是 2026-09-03 上午刚被腾出来的那条**:它原本只服务后台的「记忆网络」标签页,
那页当天按所有者决定删了(见 1.10 开头),接口刻意留着 —— **留对了,这一页正好接上**。
它要现算相似度(438 桶实测约 1.3 秒,见 1.10),所以**页面把它当可选**:取不到就当没有边,
场照样铺得出来、只是凑近了不亮线。演练里有一条钉这个降级路径。

### 和 fuyue 原版刻意不一样的三处(别当成抄漏了)

原版是 `packages/ui/src/memory-constellation.tsx`,**React 19 + lucide-react + esbuild**;
这一页是**用普通 JS 重写的**,因为后台这边不引外部依赖。三处行为差别:

1. **不足 144 个时的填充法**。原版把同一条记忆**复制成多个「投影」**凑够 144,于是连线要在
   一堆投影里找最近的那个,代码复杂一大截。这里改成**填充不可点的装饰字符**(更暗、不连线、
   不可选中)。她 400+ 个桶本来就用不到填充,那套复杂度买不到任何东西。
2. **边的优先级**。原版的边分 `explicit/source/tag/vector` 四种、按种类排;OB 只有一种边
   (向量相似度),所以改成**按相似度从高到低**排。
3. **分层**。原版按 `core/semantic/episodic/working/archive` 定字号和位置;OB 没有这套,
   改成按 `type + pinned + resolved` 映射,见 `turbulence.html` 里的 `layerOf()`。

**授权**:`packages/ui` 单独采用 MIT(Copyright 2026 TangfanOVO),与本仓库的 MIT 兼容;
**MIT 全文和版权声明抄在 `turbulence.html` 的头注释里**,那是 MIT 要求的,别删。
⚠️ **别去抄 fuyue 的 `apps/` 那部分 —— 那是 AGPL-3.0**,拿进来会污染整个仓库的授权。

### 怎么验

```bash
bash tests/turbulence-e2e/run.sh    # 52 项浏览器演练(2026-09-03 全绿)
```
起两个假 OB(一个正常、一个把 `/api/network` 打成 500),**不碰真 OB**,同 `tests/galaxy-e2e/`。
钉着的除了功能,还有三条底线:**零外部请求**、**除登录外零非 GET 请求**、**只碰那三条已有接口**。
⚠️ 演练里把 `driftSpeed` 换成 0 好让点击落得准 —— **只替换测试时发出去的那份 HTML,
`turbulence.html` 本身一个字不动**(同 galaxy 那套做法)。

### 三条别踩

1. **⚠️ `Dockerfile` 里必须有 `COPY turbulence.html .`** —— 漏了这行镜像里没有这个文件,
   线上 `/turbulence` 回 404 而本地一切正常。**这是 1.9 已经踩过一次的坑**(galaxy.html 那次),
   往根目录加静态文件都同理。
2. **别把 `nearestAt()` 改成每帧对所有节点排序**。它现在是插入到一个长度为 4 的小数组里,
   438 个节点每帧扫一遍是够用的;真要扩到几千个桶,该做的是空间分桶,不是排序。
   同理 `makeGraph` 里那十轮松弛**已经是网格分桶了,别改回两两比** —— 那是 1.10 讲的同一个病。
3. **`window.__drift` 是给演练用的观察口,页面自己一处都不用**(照 `galaxy.html` 的
   `window.__galaxy` 那套)。删了它演练就只能盲点画布,点不准;**别为了「干净」把它拿掉。**
4. **别把颜色写回 JS 里。** `CONFIG` 里**刻意没有颜色**,只有一行指路。写死了切浅色画出来
   还是深色那套 —— 后台那边早就踩过,见 1.8。

**改文案/调参**:标题、上飘速度、感应半径、字符表在 `turbulence.html` 顶部的 `CONFIG` 里;
**颜色不在 `CONFIG`,在它下面 `<style>` 的 `:root`**(上面那张旋钮表)。

## 2. 模块结构与依赖关系

```
                    ┌──────────────┐
                    │  server.py   │  MCP 主入口，6 个工具 + Dashboard + Hook
                    └──────┬───────┘
           ┌───────────────┼───────────────┬────────────────┐
           ▼               ▼               ▼                ▼
   bucket_manager.py  dehydrator.py  decay_engine.py  embedding_engine.py
   记忆桶 CRUD+搜索   脱水压缩+打标   遗忘曲线+归档   向量化+语义检索
           │               │                                │
           └───────┬───────┘                                │
                   ▼                                        ▼
              utils.py ◄────────────────────────────────────┘
              配置/日志/ID/路径安全/token估算
```

| 文件 | 职责 | 依赖（项目内） | 被谁调用 |
|---|---|---|---|
| `server.py` | MCP 服务器主入口，注册工具 + Dashboard API + 钩子端点 | `bucket_manager`, `dehydrator`, `decay_engine`, `embedding_engine`, `utils` | `test_tools.py` |
| `bucket_manager.py` | 记忆桶 CRUD、多维索引搜索、wikilink 注入、激活更新 | `utils` | `server.py`, `check_buckets.py`, `backfill_embeddings.py` |
| `decay_engine.py` | 衰减引擎：遗忘曲线计算、自动归档、自动结案 | 无（接收 `bucket_mgr` 实例） | `server.py` |
| `dehydrator.py` | 数据脱水压缩 + 合并 + 自动打标（仅 LLM API，不可用时报 RuntimeError） | `utils` | `server.py` |
| `embedding_engine.py` | 向量化引擎：Gemini embedding API + SQLite + 余弦搜索 | `utils` | `server.py`, `backfill_embeddings.py` |
| `utils.py` | 配置加载、日志、路径安全、ID 生成、token 估算 | 无 | 所有模块 |
| `galaxy.html` | **记忆银河**(2026-08-29 新增):把桶画成 3D 星图的单文件页面。**纯前端、只读**,靠 `/api/buckets` + `/api/bucket/{id}` 取数,不新增任何接口 | 无(three.js 走 CDN) | `server.py` 的 `/galaxy` 路由 |
| `turbulence.html` | **记忆乱流**(2026-09-03 新增):把桶画成一片上飘的字符场。**纯前端、只读**,靠 `/api/buckets` + `/api/network` + `/api/bucket/{id}` 取数,不新增任何接口。视觉照 fuyue 的 `memory-constellation`(MIT)重写,见 1.12 | **无 —— 零外部依赖**(和 galaxy 不一样,那个要 CDN 上的 three.js) | `server.py` 的 `/turbulence` 路由 |
| `write_memory.py` | 手动写入记忆 CLI（绕过 MCP） | 无（独立脚本） | 无 |
| `backfill_embeddings.py` | 为存量桶批量生成 embedding | `utils`, `bucket_manager`, `embedding_engine` | 无 |
| `check_buckets.py` | 桶数据完整性检查 | `bucket_manager`, `utils` | 无 |
| `import_memory.py` | 历史对话导入引擎（支持 Claude JSON/ChatGPT/DeepSeek/Markdown/纯文本），分块处理+断点续传+词频分析 | `utils` | `server.py` |
| `reclassify_api.py` | 用 LLM API 重打标未分类桶 | 无（直接用 `openai`） | 无 |
| `reclassify_domains.py` | 基于关键词本地重分类 | 无 | 无 |
| `migrate_to_domains.py` | 平铺桶 → 域子目录迁移 | 无 | 无 |
| `test_smoke.py` | 冒烟测试 | `utils`, `bucket_manager`, `dehydrator`, `decay_engine` | 无 |
| `test_tools.py` | MCP 工具端到端测试 | `utils`, `server`, `bucket_manager` | 无 |

---

## 3. 硬编码值清单

### 3.1 固定分数 / 特殊返回值

| 值 | 位置 | 用途 |
|---|---|---|
| `999.0` | `decay_engine.py` calculate_score | pinned / protected / permanent 桶永不衰减 |
| `50.0` | `decay_engine.py` calculate_score | feel 桶固定活跃度分数 |
| `0.02` | `decay_engine.py` resolved_factor | resolved + digested 时的权重乘数（加速淡化） |
| `0.05` | `decay_engine.py` resolved_factor | 仅 resolved 时的权重乘数（沉底） |
| `1.5` | `decay_engine.py` urgency_boost | arousal > 0.7 且未解决时的紧迫度加成 |

### 3.2 衰减公式参数

| 值 | 位置 | 用途 |
|---|---|---|
| `36.0` | `decay_engine.py` _calc_time_weight | 新鲜度半衰期（小时），`1.0 + e^(-t/36)` |
| `0.3` (指数) | `decay_engine.py` calculate_score | `activation_count ** 0.3`（记忆巩固指数） |
| `3.0` (天) | `decay_engine.py` calculate_score | 短期/长期切换阈值 |
| `0.7 / 0.3` | `decay_engine.py` combined_weight | 短期权重分配：time×0.7 + emotion×0.3 |
| `0.7` | `decay_engine.py` urgency_boost | arousal 紧迫度触发阈值 |
| `4` / `30` (天) | `decay_engine.py` execute_cycle | 自动结案：importance≤4 且 >30天 |

### 3.3 搜索/评分参数

| 值 | 位置 | 用途 |
|---|---|---|
| `×3` / `×2.5` / `×2` | `bucket_manager.py` _calc_topic_score | 桶名 / 域名 / 标签的 topic 评分权重 |
| `1000` (字符) | `bucket_manager.py` _calc_topic_score | 正文截取长度 |
| `0.1` | `bucket_manager.py` _calc_time_score | 时间亲近度衰减系数 `e^(-0.1 × days)` |
| `0.3` | `bucket_manager.py` search_multi | resolved 桶的归一化分数乘数 |
| `0.5` | `server.py` breath/search | 向量搜索相似度下限 |
| `0.7` | `server.py` dream | feel 结晶相似度阈值 |

### 3.4 Token 限制 / 截断

| 值 | 位置 | 用途 |
|---|---|---|
| `10000` | `server.py` breath 默认 max_tokens | 浮现/搜索 token 预算 |
| `20000` | `server.py` breath 上限 | max_tokens 硬上限 |
| `50` / `20` | `server.py` breath | max_results 上限 / 默认值 |
| `3000` | `dehydrator.py` dehydrate | API 脱水内容截断 |
| `2000` | `dehydrator.py` merge | API 合并内容各截断 |
| `5000` | `dehydrator.py` digest | API 日记整理内容截断 |
| `2000` | `embedding_engine.py` | embedding 文本截断 |
| `100` | `dehydrator.py` | 内容 < 100 token 跳过脱水 |

### 3.5 时间/间隔/重试

| 值 | 位置 | 用途 |
|---|---|---|
| `60.0s` | `dehydrator.py` | OpenAI 客户端 timeout |
| `30.0s` | `embedding_engine.py` | Embedding API timeout |
| `60s` | `server.py` keepalive | 保活 ping 间隔 |
| `48.0h` | `bucket_manager.py` touch | 时间涟漪窗口 ±48h |
| `2s` | `backfill_embeddings.py` | 批次间等待 |

### 3.6 随机浮现

| 值 | 位置 | 用途 |
|---|---|---|
| `3` | `server.py` breath search | 结果不足 3 条时触发 |
| `0.4` | `server.py` breath search | 40% 概率触发随机浮现 |
| `2.0` | `server.py` breath search | 随机池：score < 2.0 的低权重桶 |
| `1~3` | `server.py` breath search | 随机浮现数量 |

### 3.7 情感/重构

| 值 | 位置 | 用途 |
|---|---|---|
| `0.2` | `server.py` breath search | 情绪重构偏移系数 `(q_valence - 0.5) × 0.2`（最大 ±0.1） |

### 3.8 其他

| 值 | 位置 | 用途 |
|---|---|---|
| `12` | `utils.py` gen_id | bucket ID 长度（UUID hex[:12]） |
| `80` | `utils.py` sanitize_name | 桶名最大长度 |
| `1.5` / `1.3` | `utils.py` count_tokens_approx | 中文/英文 token 估算系数 |
| `8000` | `server.py` | MCP 服务器端口 |
| `30` 字符 | `server.py` grow | 短内容快速路径阈值 |
| `10` | `server.py` dream | 取最近 N 个桶 |

---

## 4. Config.yaml 完整键表

| 键路径 | 默认值 | 用途 |
|---|---|---|
| `transport` | `"stdio"` | 传输模式 |
| `log_level` | `"INFO"` | 日志级别 |
| `buckets_dir` | `"./buckets"` | 记忆桶目录 |
| `merge_threshold` | `75` | 合并相似度阈值 (0-100) |
| `dehydration.model` | `"deepseek-chat"` | 脱水用 LLM 模型 |
| `dehydration.base_url` | `"https://api.deepseek.com/v1"` | API 地址 |
| `dehydration.api_key` | `""` | API 密钥 |
| `dehydration.max_tokens` | `1024` | 脱水返回 token 上限 |
| `dehydration.temperature` | `0.1` | 脱水温度 |
| `embedding.enabled` | `true` | 启用向量检索 |
| `embedding.model` | `"gemini-embedding-001"` | Embedding 模型 |
| `decay.lambda` | `0.05` | 衰减速率 λ |
| `decay.threshold` | `0.3` | 归档分数阈值 |
| `decay.check_interval_hours` | `24` | 衰减扫描间隔（小时） |
| `decay.emotion_weights.base` | `1.0` | 情感权重基值 |
| `decay.emotion_weights.arousal_boost` | `0.8` | 唤醒度加成系数 |
| `matching.fuzzy_threshold` | `50` | 模糊匹配下限 |
| `matching.max_results` | `5` | 匹配返回上限 |
| `scoring_weights.topic_relevance` | `4.0` | 主题评分权重 |
| `scoring_weights.emotion_resonance` | `2.0` | 情感评分权重 |
| `scoring_weights.time_proximity` | `2.5` | 时间评分权重 |
| `scoring_weights.importance` | `1.0` | 重要性评分权重 |
| `scoring_weights.content_weight` | `3.0` | 正文评分权重 |
| `wikilink.enabled` | `true` | 启用 wikilink 注入 |
| `wikilink.use_tags` | `false` | wikilink 包含标签 |
| `wikilink.use_domain` | `true` | wikilink 包含域名 |
| `wikilink.use_auto_keywords` | `true` | wikilink 自动关键词 |
| `wikilink.auto_top_k` | `8` | wikilink 取 Top-K 关键词 |
| `wikilink.min_keyword_len` | `2` | wikilink 最短关键词长度 |
| `wikilink.exclude_keywords` | `[]` | wikilink 排除关键词表 |

---

## 5. 核心设计决策记录

### 5.1 为什么用 Markdown + YAML frontmatter 而不是数据库？

**决策**：每个记忆桶 = 一个 `.md` 文件，元数据在 YAML frontmatter 里。

**理由**：
- 与 Obsidian 原生兼容——用户可以直接在 Obsidian 里浏览、编辑、搜索记忆
- 文件系统即数据库，天然支持 git 版本管理
- 无外部数据库依赖，部署简单
- wikilink 注入让记忆之间自动形成知识图谱

**放弃方案**：SQLite/PostgreSQL 全量存储。过于笨重，失去 Obsidian 可视化优势。

### 5.2 为什么 embedding 单独存 SQLite 而不放 frontmatter？

**决策**：向量存 `embeddings.db`（SQLite），与 Markdown 文件分离。

**理由**：
- 3072 维浮点向量无法合理存入 YAML frontmatter
- SQLite 支持批量查询和余弦相似度计算
- embedding 是派生数据，丢失可重新生成（`backfill_embeddings.py`）
- 不污染 Obsidian 可读性

### 5.3 为什么搜索用双通道（关键词 + 向量）而不是纯向量？

**决策**：关键词模糊匹配（rapidfuzz）+ 向量语义检索并联，结果去重合并。

**理由**：
- 纯向量在精确名词匹配上表现差（"2024年3月"这类精确信息）
- 纯关键词无法处理语义近似（"很累" → "身体不适"）
- 双通道互补，关键词保精确性，向量补语义召回
- 向量不可用时自动降级到纯关键词模式

### 5.4 为什么有 dehydration（脱水）这一层？

**决策**：存入前先用 LLM 压缩内容（保留信息密度，去除冗余表达）。API 不可用时直接抛出 `RuntimeError`，不静默降级。

**理由**：
- MCP 上下文有 token 限制，原始对话冗长，需要压缩
- LLM 压缩能保留语义和情感色彩，纯截断会丢信息
- 本地关键词提取质量不足以替代语义打标与合并，静默降级会产生错误分类记忆，比报错更危险。详见 BEHAVIOR_SPEC.md 三、降级行为表。

**放弃方案**：只做截断。信息损失太大。

### 5.5 为什么 feel 和普通记忆分开？

**决策**：`feel=True` 的记忆存入独立 `feel/` 目录，不参与普通浮现、不衰减、不合并。

**理由**：
- feel 是模型的自省产物，不是事件记录——两者逻辑完全不同
- 事件记忆应该衰减遗忘，但"我从中学到了什么"不应该被遗忘
- feel 的 valence 是模型自身感受（不等于事件情绪），混在一起会污染情感检索
- feel 可以通过 `breath(domain="feel")` 单独读取

### 5.6 为什么 resolved 不删除记忆？

**决策**：`resolved=True` 让记忆"沉底"（权重 ×0.05），但保留在文件系统中，关键词搜索仍可触发。

**理由**：
- 模拟人类记忆：resolved 的事不会主动想起，但别人提到时能回忆
- 删除是不可逆的，沉底可随时 `resolved=False` 重新激活
- `resolved + digested` 进一步降权到 ×0.02（已消化 = 更释然）

**放弃方案**：直接删除。不可逆，且与人类记忆模型不符。

### 5.7 为什么用分段式短期/长期权重？

**决策**：≤3 天时间权重占 70%，>3 天情感权重占 70%。

**理由**：
- 刚发生的事主要靠"新鲜"驱动浮现（今天的事 > 昨天的事）
- 时间久了，决定记忆存活的是情感强度（强烈的记忆更难忘）
- 这比单一衰减曲线更符合人类记忆的双重存储理论

### 5.8 为什么 dream 设计成对话开头自动执行？

**决策**：每次新对话启动时，Claude 执行 `dream()` 消化最近记忆，有沉淀写 feel，能放下的 resolve。

**理由**：
- 模拟睡眠中的记忆整理——人在睡觉时大脑会重放和整理白天的经历
- 让 Claude 对过去的记忆有"第一人称视角"的自省，而不是冷冰冰地搬运数据
- 自动触发确保每次对话都"接续"上一次，而非从零开始

### 5.9 为什么新鲜度用连续指数衰减而不是分段阶梯？

**决策**：`bonus = 1.0 + e^(-t/36)`，t 为小时，36h 半衰。

**理由**：
- 分段阶梯（0-1天=1.0，第2天=0.9...）有不自然的跳变
- 连续指数更符合遗忘曲线的物理模型
- 36h 半衰期使新桶在前两天有明显优势，72h 后接近自然回归
- 值域 1.0~2.0 保证老记忆不被惩罚（×1.0），只是新记忆有额外加成（×2.0）

**放弃方案**：分段线性（原实现）。跳变点不自然，参数多且不直观。

### 5.10 情感记忆重构（±0.1 偏移）的设计动机

**决策**：搜索时如果指定了 `valence`，会微调结果桶的 valence 展示值 `(q_valence - 0.5) × 0.2`。

**理由**：
- 模拟认知心理学中的"心境一致性效应"——当前心情会影响对过去的回忆
- 偏移量很小（最大 ±0.1），不会扭曲事实，只是微妙的"色彩"调整
- 原始 valence 不被修改，只影响展示层

---

## 6. 目录结构约定

```
buckets/
├── permanent/       # pinned/protected 桶，importance=10，永不衰减
├── dynamic/
│   ├── 日常/        # domain 子目录
│   ├── 情感/
│   ├── 自省/
│   ├── 数字/
│   └── ...
├── archive/         # 衰减归档桶
└── feel/            # 模型自省 feel 桶
```

桶文件格式：
```markdown
---
id: 76237984fa5d
name: 桶名
domain: [日常, 情感]
tags: [关键词1, 关键词2]
importance: 5
valence: 0.6
arousal: 0.4
activation_count: 3
resolved: false
pinned: false
digested: false
created: 2026-04-17T10:00:00+08:00
last_active: 2026-04-17T14:00:00+08:00
type: dynamic
---

桶正文内容...
```

---

## 7. Bug 修复记录 (B-01 至 B-10)

### B-01 — `update(resolved=True)` 自动归档 🔴 高

- **文件**: `bucket_manager.py` → `update()`
- **问题**: `resolved=True` 时立即调用 `_move_bucket(archive_dir)` 将桶移入 `archive/`
- **修复**: 移除 `_move_bucket` 逻辑；resolved 桶留在 `dynamic/`，由 decay 引擎自然淘汰
- **影响**: 已解决的桶仍可被关键词检索命中（降权但不消失）
- **测试**: `tests/regression/test_issue_B01.py`，`tests/integration/test_scenario_07_trace.py`

### B-03 — `int()` 截断浮点 activation_count 🔴 高

- **文件**: `decay_engine.py` → `calculate_score()`
- **问题**: `max(1, int(activation_count))` 将 `_time_ripple` 写入的 1.3 截断为 1，涟漪加成失效
- **修复**: 改为 `max(1.0, float(activation_count))`
- **影响**: 时间涟漪效果现在正确反映在 score 上；高频访问的桶衰减更慢
- **测试**: `tests/regression/test_issue_B03.py`，`tests/unit/test_calculate_score.py`

### B-04 — `create()` 初始化 activation_count=1 🟠 中

- **文件**: `bucket_manager.py` → `create()`
- **问题**: `activation_count=1` 导致冷启动检测条件 `== 0` 永不满足，新建重要桶无法浮现
- **修复**: 改为 `activation_count=0`；`touch()` 首次命中后变 1
- **测试**: `tests/regression/test_issue_B04.py`，`tests/integration/test_scenario_01_cold_start.py`

### B-05 — 时间衰减系数 0.1 过快 🟠 中

- **文件**: `bucket_manager.py` → `_calc_time_score()`
- **问题**: `math.exp(-0.1 * days)` 导致 30 天后得分仅剩 ≈0.05，远快于人类记忆曲线
- **修复**: 改为 `math.exp(-0.02 * days)`（30 天后 ≈0.549）
- **影响**: 记忆保留时间更符合人类认知模型
- **测试**: `tests/regression/test_issue_B05.py`，`tests/unit/test_score_components.py`

### B-06 — `w_time` 默认值 2.5 过高 🟠 中

- **文件**: `bucket_manager.py` → `_calc_final_score()`（或评分调用处）
- **问题**: `scoring.get("time_proximity", 2.5)` — 时间权重过高，近期低质量记忆得分高于高质量旧记忆
- **修复**: 改为 `scoring.get("time_proximity", 1.5)`
- **测试**: `tests/regression/test_issue_B06.py`，`tests/unit/test_score_components.py`

### B-07 — `content_weight` 默认值 3.0 过高 🟠 中

- **文件**: `bucket_manager.py` → `_calc_topic_score()`
- **问题**: `scoring.get("content_weight", 3.0)` — 内容权重远大于名字权重(×3)，导致内容重复堆砌的桶得分高于名字精确匹配的桶
- **修复**: 改为 `scoring.get("content_weight", 1.0)`
- **影响**: 名字完全匹配 > 标签匹配 > 内容匹配的得分层级现在正确
- **测试**: `tests/regression/test_issue_B07.py`，`tests/unit/test_topic_score.py`

### B-08 — `run_decay_cycle()` 同轮 auto_resolve 后 score 未降权 🟡 低

- **文件**: `decay_engine.py` → `run_decay_cycle()`
- **问题**: `auto_resolve` 标记后立即用旧 `meta`（stale）计算 score，`resolved_factor=0.05` 未生效
- **修复**: 在 `bucket_mgr.update(resolved=True)` 后立即执行 `meta["resolved"] = True`，确保同轮降权
- **测试**: `tests/regression/test_issue_B08.py`，`tests/integration/test_scenario_08_decay.py`

### B-09 — `hold()` 用 analyze() 覆盖用户传入的 valence/arousal 🟡 低

- **文件**: `server.py` → `hold()`
- **问题**: 先调 `analyze()`，再直接用结果覆盖用户传入的情感值，情感准确性丢失
- **修复**: 使用 `final_valence = user_valence if user_valence is not None else analyze_result.get("valence")`
- **影响**: 用户明确传入的情感坐标（包括 0.0）不再被 LLM 结果覆盖
- **测试**: `tests/regression/test_issue_B09.py`，`tests/integration/test_scenario_03_hold.py`

### B-10 — feel 桶 `domain=[]` 被填充为 `["未分类"]` 🟡 低

- **文件**: `bucket_manager.py` → `create()`
- **问题**: `if not domain: domain = ["未分类"]` 对所有桶类型生效，feel 桶的空 domain 被错误填充
- **修复**: 改为 `if not domain and bucket_type != "feel": domain = ["未分类"]`
- **影响**: `breath(domain="feel")` 通道过滤逻辑现在正确（feel 桶 domain 始终为空列表）
- **测试**: `tests/regression/test_issue_B10.py`，`tests/integration/test_scenario_10_feel.py`

---

### Bug 修复汇总表

| ID | 严重度 | 文件 | 方法 | 一句话描述 |
|---|---|---|---|---|
| B-01 | 🔴 高 | `bucket_manager.py` | `update()` | resolved 桶不再自动归档 |
| B-03 | 🔴 高 | `decay_engine.py` | `calculate_score()` | float activation_count 不被 int() 截断 |
| B-04 | 🟠 中 | `bucket_manager.py` | `create()` | 初始 activation_count=0 |
| B-05 | 🟠 中 | `bucket_manager.py` | `_calc_time_score()` | 时间衰减系数 0.02（原 0.1） |
| B-06 | 🟠 中 | `bucket_manager.py` | 评分权重配置 | w_time 默认 1.5（原 2.5） |
| B-07 | 🟠 中 | `bucket_manager.py` | `_calc_topic_score()` | content_weight 默认 1.0（原 3.0） |
| B-08 | 🟡 低 | `decay_engine.py` | `run_decay_cycle()` | auto_resolve 同轮应用 ×0.05 |
| B-09 | 🟡 低 | `server.py` | `hold()` | 用户 valence/arousal 优先 |
| B-10 | 🟡 低 | `bucket_manager.py` | `create()` | feel 桶 domain=[] 不被填充 |

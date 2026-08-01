# ears 瘦身:改好了、验过了、**还没推上去**(交接给下一个会话)

> 2026-08-01 由 Claude Code 会话完成改动与验证,但**卡在没有 ears 仓库的写权限**,
> 没能推送/构建/部署。本文件 + 同目录的 `memory-slim.patch` 就是全部成果,照着做完即可。
> ears 源码在 `Mia06250603ian/ears`(公开),**不在本仓库**;本目录只放这份交接。
>
> ---
>
> ## 🗑️ 这个目录是临时寄存,收尾后请删掉
>
> **`ears/` 本来不该出现在这个仓库里**——ears 的东西属于 `Mia06250603ian/ears`。
> 它放在这儿的唯一原因是:2026-08-01 那个会话没有 ears 仓库的写权限,
> 而改动和验证结果不能跟着会话沙盒一起消失,所以先寄存在这里。
>
> **所以:等你按第 4 节把改动推进 ears 仓库、并按第 5 节验证通过之后,
> 请把整个 `ears/` 目录删掉**(`MEMORY-SLIM-PENDING.md` + `memory-slim.patch` 两个文件),
> 同时把 `OPERATIONS.md` 服务清单里 ears 那一行末尾指向本文件的那句话去掉。
>
> 留着一份过期副本比没有更糟——下一个会话会以为这件事还没做。
> 真正的归宿:这份说明里值得长期保留的部分(为什么这么改、三条不能动的地方),
> 应该写进 **ears 仓库自己的文档**,或者浓缩成一行进 `OPERATIONS.md` 的功能时间线。

## 0. 一句话

ears 常驻内存 **281MB**、分析语音时冲到 **594MB**,其中约 200MB 是
`librosa.yin`(算音高)拖进来的 numba+llvmlite,**Python 永不卸载,涨上去就不还**。
改法:把算法**原样**搬进一次性子进程,算完进程退出,内存当场还给系统。

## 1. 为什么这件事值得做

2026-08-01 实测这台 VPS(3724MB,七个服务共用,**平台没给任何容器设内存上限**,
cgroup `memory.max` 全是 `max`):

| 服务 | 11 小时最低 | 平均 | 最高 |
|---|---|---|---|
| browser-hands | 2MB | 791MB | **1474MB** |
| kelivo-shim(晏) | 324MB | 549MB | 605MB |
| **ears** | **281MB** | 348MB | **594MB** |
| Ombre Brain | 96MB | 148MB | 154MB |
| telegram-bridge | 111MB | 113MB | 132MB |
| CLIProxyAPI | 24MB | 32MB | 61MB |
| fishing-mcp | 51MB | 56MB | 62MB |

**关键的一点(别忘了)**:内存耗尽时内核挑**单个最胖的进程**杀,不是按服务算。
实测 oom_score:**ears 的 python 进程 1365(全机第一顺位)、晏的 claude 进程 1363(第二)**,
而 browser-hands 因为 Chrome 拆成 7 个小进程,单个都不显眼,反而最安全。
**所以瘦 ears 不只是省内存,是把晏前面那个挡箭牌……不,是把「第一个被杀的」从名单上拿掉。**
容器没有 `CAP_SYS_RESOURCE`,**没法给晏调低被杀优先级**(已验证),所以只能从减少总压力入手。

## 2. 改动内容

见同目录 `memory-slim.patch`(对 `Mia06250603ian/ears` 的 `main` 生成,commit `fcbc423`)。两处:

1. **新增 `acoustic_worker.py`**:把 `acoustic_features` 的算法**逐字搬过去**,
   独立进程运行,stdout 打印一行 JSON。
   开头设 `NUMBA_CACHE_DIR`(默认 `/app/data/numba-cache`,即持久卷)让 JIT 编译缓存跨重启复用。
2. **`server.py`** 的 `acoustic_features` 改为起子进程调用,并加 `_wav_duration()` 兜底;
   新增 import `sys`/`wave`,新增环境变量 `ACOUSTIC_TIMEOUT_S`(默认 90)。

### ⚠️ 三条不能动的地方

1. **算法、参数、四舍五入位数必须逐字保持原样。** `data/profile.json` 是 200 条滚动基线,
   靠「拿这条和过去比」给出「音高略偏低」这类判断。**数字一变,判断就错,而且要约 10 天
   (按每天约 19 条)才能把旧值滚干净。** 这是本次坚持用子进程、而不是改用 numpy 自己算的**唯一原因**。
2. **失败兜底必须保留。** `listen()` 里有 `if feats.get("duration_s", 0) < 0.5: return 太短啦`——
   子进程失败时若返回空 dict,**每条语音都会被误判成「太短」整条丢掉**。
   所以兜底用标准库 `wave` 读头拿时长(零依赖零内存)。
3. **`earsplus.py` 不用改。** 它的 librosa 调用都在 onnxruntime 缺失时提前退出的分支里
   (requirements.txt 里 onnxruntime 是注释掉的),只会触发 librosa 的懒导入(约 24MB),
   不会拖进 numba。已核对。

## 3. 已经做完的验证(在**线上容器里**跑的,不是本地猜的)

```
新旧输出逐字段对比:10 个特征全部相同  ★
  {"brightness":2337.0,"duration_s":4.0,"energy":0.2116,"energy_sway":0.0085,
   "pause_ratio":1.0,"pitch_hz":180.8,"pitch_jitter":0.032,"pitch_range":11.4,
   "tempo":0.87,"tempo_sway":0.25}
主进程 RSS:243MB → 58MB
单次分析:冷编译 19.5s / 有缓存 2.3s(旧版进程内热调用是亚秒级 → 每条语音多约 2 秒)
失败路径:文件不存在时返回 {"duration_s": 0.0} 并打日志,不抛异常
```

复现方法:造一段确定性音频(见下),分别用旧函数和 `acoustic_worker.py` 算,比对 dict 是否相等。

```python
sr=16000; rng=np.random.default_rng(42); t=np.arange(sr*4)/sr
f0=180+20*np.sin(2*np.pi*3*t)
y=0.3*np.sin(2*np.pi*np.cumsum(f0)/sr)+0.02*rng.standard_normal(t.size)
```

## 4. 下一个会话要做的四步

**前提:开会话时必须把 `Mia06250603ian/ears` 也加进授权仓库**(本次就是卡在这)。

```bash
# 1. 应用补丁
git clone https://github.com/Mia06250603ian/ears && cd ears
git apply /path/to/memory-slim.patch      # 或 git am,补丁含完整提交信息
python3 -m py_compile server.py acoustic_worker.py

# 2. 推送(⚠️ 推 main 前先问所有者)
```

**推 main 还是推分支,必须问所有者**:ears 的工作流是 `on: push: branches:[main]`,
**推 main 会自动构建并覆盖 `:latest`**(Zeabur 拉的就是 latest)。
推分支则要手动 `workflow_dispatch`,但那样 `:latest` 指向分支代码而 main 落后于线上
——就是 shim 手册踩坑 11 那种「仓库和线上不一致」,不推荐。

```bash
# 3. 等 GitHub Actions 构建完(workflow: build-image.yml,推 ghcr.io/mia06250603ian/ears:latest)
# 4. 让 Zeabur 拉新镜像
npx -y zeabur@latest service redeploy --id 6a646ea27bcbc56e70a105b5 \
  --env-id 6a53a9fcb6ce8edcb0163f97 -i=false
```

Zeabur 位置:项目 `cli-proxy-api--cpa` id `6a53a9fc22dd6ef375eb7484`,
env `6a53a9fcb6ce8edcb0163f97`,服务 `ears-thor` id `6a646ea27bcbc56e70a105b5`,
域名 `yan-ears-listen.zeabur.app`,持久卷 `/app/data`。

## 5. 部署后必须验的(别只看 /health)

```bash
# a. 服务活着,asr 正常
curl https://yan-ears-listen.zeabur.app/health

# b. 新文件真的进了容器
npx -y zeabur@latest service exec --id 6a646ea27bcbc56e70a105b5 \
  --env-id 6a53a9fcb6ce8edcb0163f97 -i=false -- sh -c "ls -la /app/acoustic_worker.py; md5sum /app/server.py"

# c. ★ 让佳佳发一条语音,然后确认两件事:
#    - 晏那边收到的语气判断正常(有「音高/语速」这类相对描述)
#    - 主进程内存没涨回 280MB:
npx -y zeabur@latest service exec --id 6a646ea27bcbc56e70a105b5 \
  --env-id 6a53a9fcb6ce8edcb0163f97 -i=false -- sh -c \
  'grep "^anon " /sys/fs/cgroup/memory.stat'
#    期望:约 60~90MB,而不是 280MB+

# d. 确认基线没被污染:新写进 data/moments.jsonl 的 features 数值范围
#    应与 08-01 之前的历史条目同量级(尤其 pitch_hz / brightness)
```

**回滚**:改动只有两个文件,`git revert` 后重新构建部署即可;
`data/` 里的基线和记录全程没动过,回滚不丢数据。

## 5.5 ✅ 验证通过之后:清理本目录

这是收尾的最后一步,**别忘了**(理由见文件开头):

```bash
cd <Ombre-Brain>
git rm -r ears/                    # 删掉 MEMORY-SLIM-PENDING.md 和 memory-slim.patch
# 再把 OPERATIONS.md 服务清单里 ears 那行末尾
# 「**有一件改好未推的瘦身改动待收尾,见 ears/MEMORY-SLIM-PENDING.md**」这句删掉,
# 换成在「功能时间线」里补一行:哪天做了什么、省了多少内存。
```

## 6. 顺带记一笔:这次为什么没用「换成 numpy 自己算」的方案

评估过,结论是**不划算**:音量/停顿/音色三个特征能做到几乎一致,但
**音高(yin)是特定算法,自己实现会给出不同的值**——而音高恰好是情绪判断里最重要的一个。
代价是所有者的语气基线作废约 10 天,换来的只是省掉每条语音那 2 秒。
所有者养这套基线养了一个多月,不值得。

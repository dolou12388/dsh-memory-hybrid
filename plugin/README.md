# dsh-memory-hybrid

混合架构长期记忆插件 —— KV 权威层 + 向量派生索引 + 艾宾浩斯衰减 + 心情调制 + 可选 Jev 判别。
**自带 sqlite 存储后端**，无需宿主安装任何存储插件。

写给 DeepSeek Harness（dsh）。目标不是「把所有对话塞进向量库」，而是让记忆**有轻重、会遗忘、可复活**。

配置入口有两个，看的是同一份数据：左侧边栏的**记忆**图标，和**设置 → 插件 → 记忆**。

---

## 一、它解决什么

主流记忆插件的问题是同一种：**只增不减**。存得越多检索越糊，最后变成一个又慢又吵的日志。

本插件的立场：

- **KV 是权威，向量是派生**。删掉索引不丢数据，索引可随时由 KV 重建。
- **遗忘不等于删除**。权重归零转 `dormant`，剥离向量索引，但记录留在 KV 里。
- **遗忘的记忆可被关联唤醒**。通过记忆之间的边重新命中，然后回到 `active`。
- **写入有门槛**。不是每句话都值得记，阈值由「心情」调制。

---

## 二、三层状态机

```
                 ┌──────────────────────────────────────────┐
                 │                                          │
   写入 ──▶ active ──(S≥30 且 召回≥2 次)──▶ long ──────────┐│
              │  ▲                          │             ││
              │  │                          │(R<0.20)     ││
              │  │(关联唤醒 revive)          ▼             ││
              │  └────────────────────── dormant ◀─────────┘│
              │                          │                  │
              └──(R<0.05)────────────────┘                  │
                                                             │
              dormant ──(长期无人碰)──▶ 保持 dormant（不删）◀─┘
```

| 状态 | 含义 | 是否入向量索引 | 可被检索 |
|---|---|---|---|
| `active` | 可增减记忆点 | 是 | 向量 + 词法 + 图 |
| `long` | 长期记忆 | 是 | 向量 + 词法 + 图 |
| `dormant` | 已遗忘（未删除） | **否** | 仅图通道 |

关键设计：`dormant` 被 `index.drop()` 剥离后，**向量召回不到它**，但图扩展通道能通过相邻记忆命中。命中后触发 `revive()`，重新入索引。这就是「遗忘但不删除、可通过互联记忆点唤醒」的落地方式。

---

## 三、三量模型

借用 FSRS/DSR 的思路，每个记忆点存三个量：

| 量 | 字段 | 含义 |
|---|---|---|
| 重要性 | `importance` | 0~1，由档位决定，内容属性 |
| 稳定度 | `stability` | 单位「天」，存活期尺度的倒数 |
| 可提取度 | `retrievability` | `R = exp(−t / S_eff)`，派生量不落盘 |

`S_eff` 对 `long` 施加 `LAMBDA_LONG=4.0` 的放大，即长期记忆衰减慢 4 倍。

### 档位

写入时按内容判档，`importance` 只由档位决定：

| 档位 | importance | 初始 S（天） |
|---|---|---|
| `trivial` | 0.15 | 0.5 |
| `normal` | 0.40 | 3.0 |
| `important` | 0.70 | 14.0 |
| `critical` | 0.95 | 60.0 |

### 间隔效应（重要）

被再次提及时的稳定度增益：

```js
spacingGain = exp(SPACING_K * (1 - R)) - 1     // SPACING_K = 1.5
gEff        = G_BASE * spacingGain * fMood      // G_BASE = 0.5
S'          = min(S * (1 + gEff), S_MAX)        // S_MAX = 365
```

这个形状有个必须保留的性质：**R=1 时增益恰为 0**。

写成 `1 + (1-R)` 之类的形式会让「刚记下就重复」拿到 2 倍增益 —— 那是错的。密集重复应该几乎不涨，间隔越久、越接近遗忘再想起来，涨得越多：

| R | 增益倍率 |
|---|---|
| 1.00 | 1.000× |
| 0.80 | 1.175× |
| 0.40 | 1.730× |
| 0.05 | 2.579× |

---

## 四、心情调制

心情是**自制插件**能力，不走外部依赖。接口返回「类别 + 1/2/3 档强度」，如 `开心3`、`疲惫2`。

### 二维映射

采用效价-唤醒（valence-arousal）模型，两轴独立 EMA（`α=0.55`）：

- **V（效价）**：决定「话值不值得记」—— 调制写入阈值 `θ`
- **A（唤醒）**：决定「记住后巩固多快」—— 调制召回增益，**不分正负**

```
θ = THETA_BASE · (1 − K_V · V)    // 0.55 · (1 − 0.50·V)，θ ∈ [0.275, 0.825]
f_gain = 1 + K_A · |A|            // 1 + 0.10·|A|
```

`θ` 是重要性的准入门槛：`importance ≥ θ` 才写入。

注意 `θ` 用的是**乘性**形式而非 `θ_base − K_V·V`。加性写法在 `V=−1` 时会算出 `1.050`，越出 `[0,1]`；乘性写法天然把区间约束在 `θ_base(1±K_V)` 内。

| 心情 | V | A | θ | 可写入档位 |
|---|---|---|---|---|
| 开心3 | 1.00 | 0.55 | 0.275 | normal 及以上 |
| 专注3 | 0.40 | 0.60 | 0.440 | normal 及以上 |
| 开心3 + 焦虑3 | 0.00 | 1.00 | 0.550 | important 及以上 |
| 平静2 | 0.00 | 0.00 | 0.550 | important 及以上 |
| 疲惫3 | −0.50 | −1.00 | 0.688 | important 及以上 |
| 焦虑3 | −1.00 | 0.85 | 0.825 | 仅 critical |
| 低落3 | −0.80 | −0.60 | 0.770 | 仅 critical |

### 为什么 V 只调 θ，不调 importance

早期版本让 `importance` 随 V 浮动，结果两个因子同向驱动、互相抵消 —— 需要连续开心 7 轮才能写入一条 normal 记忆。现在的划分是：

- **档位** = 内容属性（这条信息本身多重）
- **θ** = 情境属性（此刻愿不愿意记）

### 组合心情的区分度

`开心3+焦虑3` 与 `平静2` 的 V 都是 0，θ 都是 0.550，写入行为相同；但 A 分别为 1.00 / 0.00，`f_gain` 为 1.10 / 1.00。**唤醒维度确实区分了二者**，只是体现在「召回后巩固多快」，而不是「收不收」。这是有意的设计，不是缺陷。

---

## 五、装配

### 安装

```bash
# 本包走 link 分发（package.json 里 dsh.install.preferred = "link"）
dsh plugin --profile <name> add "link:<本包绝对路径>"
```

**`bundles` 会自动登记，不需要手改 `package.json`。** 依据是
`dsh-plugin-manager` 的 `runProfilePnpm` → `reconcile()`（`operations.js:44-72`）：
pnpm 退出码为 0 且未超时，就逐个比对本次新增的 `dependencies`，
凡是 `package.json` 里声明了 `dsh.bundle.patch` 的，自动 push 进 `dsh.profile.bundles`。
实测 `dsh plugin --profile bundletest add "link:..."` 之后：

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-memory-hybrid"] } }
```

但有三条边界，任一条成立都不会自动登记：

| 情形 | 结果 | 原因 |
|---|---|---|
| 包没声明 `dsh.bundle.patch` | 只装成普通依赖 | 代码里有 `warning: ... declares no dsh.bundle` 分支 |
| 包**早就在** `dependencies` 里 | 不补登记 | `reconcile` 只看「本次新增」（`beforeDeps.has(name)` 就 `continue`） |
| 桌面客户端 UI 安装 | 走另一条路 | 服务端路径 `activateNewBundles: false`，改由 UI 的激活步骤处理 |

所以**升级或重新 `add` 一个早已安装的包时不会补回 bundles**。这种情况下才需要手改。
本包自己声明了 `dsh.bundle.patch: "./cordis.patch.yml"`，首次安装属于第一种边界之外的正常路径。

手工 link（不推荐，因为不会触发 `reconcile`，bundles 必须自己加）：

```bash
# 在 profile 目录下
# Windows
powershell -c "New-Item -ItemType Junction -Path node_modules/dsh-memory-hybrid -Target <本包绝对路径>"
# *nix
ln -sfn <本包绝对路径> node_modules/dsh-memory-hybrid
```

⚠️ Windows 上 `ln -sfn` 会静默失败（`realpathSync` 报 ENOENT），必须用 Junction。

### 升级：`github:` 装法不会跟进新提交

装好之后再推新代码，重新执行同一条 `add "github:owner/repo"` **拿到的还是旧版本**，
输出却照样显示 `+ dsh-memory-hybrid x.y.z`。

根因是 pnpm 首次安装就把分支 HEAD 解析成具体 commit 钉进 lockfile：

```yaml
version: https://codeload.github.com/owner/repo/tar.gz/8e19f36dba...
```

此后 `pnpm add` 同一规格只比对包名与版本号，版本没变就跳过下载。而
`dsh plugin add` 内部就是 `pnpm add`（`dsh-plugin-manager/lib/index.js`
里 `runPnpm(["add", spec, ...])`），所以从 dsh 侧看不出任何异常。

三种正确做法：

```bash
# ① 钉 commit（最稳）
dsh plugin --profile <name> add "github:dolou12388/dsh-memory-hybrid#<sha>"

# ② 摘掉再装
dsh plugin --profile <name> remove dsh-memory-hybrid
dsh plugin --profile <name> add "github:dolou12388/dsh-memory-hybrid"

# ③ profile 目录里跑 update（只有它重新解析 git 依赖，add 不会）
pnpm update dsh-memory-hybrid
```

因此**每次推新代码都要升 `package.json` 与 `plugin/package.json` 的版本号**，
两份一起改。`test/manifest.test.mjs` 会在 `plugin/` 有改动而版本号未变时报失败。

### 补丁

`cordis.patch.yml` 已随包提供：

```yaml
- insert:
    - id: dsh-memory-hybrid
      name: 'dsh-memory-hybrid'
      config:
        autoRecall: true
        recallLimit: 6
        dim: 256
        contextOrder: 10500
        jevEndpoint: ''
        jevApiKey: ''
        jevModel: jev-1.14.0
        sweepOnStart: true
        verbose: false
        storageMode: auto
        sqliteFile: ''
        embedSource: inherit
        embedBaseURL: ''
        embedApiKey: ''
        embedModel: ''
```

⚠️ **不要在这个 patch 里手写 `inject`**。patch 的 `inject` 会**覆盖**模块的导出，
一旦与实现不一致，插件会停在 `never-started`，而且不报错 —— 只在
`dsh` 输出里留一行 `warning: N entry did not activate` 加一条栈。
本插件踩过这个坑：patch 里写着 `storageDomain`，而实现已改成软探测，结果插件永远不启动。

### 前置

不需要任何存储插件。`inject` 里只要求 `storage` / `storageDomain` / `systemPrompt` / `tools`，
其中前两个由 dsh 的 base bundle 提供（`@deepseek-ai/dsh-storage` 与 `-storage-domain`）。

profile 的 `storage-domain` 通常配成：

```yaml
- id: storage-domain
  config:
    backend: json
```

**保持原样即可**。插件默认 `storageMode: auto`，会自带 sqlite 后端；若 profile 没把
`memory_hybrid` 这个 domain 路由到 sqlite，插件会自建一个 domain facility 去用它，
不修改你的 profile 配置。

## 五之二、存储后端

### 为什么自带 sqlite，而且是自带**引擎**

宿主**没有** `@deepseek-ai/dsh-storage-sqlite` 这个包（只有 `dsh-storage-json`）。

一种看起来可行的做法是用 Node 22.5+ 内置的 `node:sqlite`。但那不叫「自带」——
它是 Node 运行时自带的能力，可用性取决于**用户装的是哪个 Node 版本**。
换台机器、换个运行时、用打包过的单文件二进制，这个假设就可能不成立。

所以引擎本身随包分发：

```
vendor/sqlite/
  sql-wasm.cjs     48,788 字节   SQLite wasm 的 UMD 加载器
  sql-wasm.wasm   659,806 字节   SQLite 官方源码经 Emscripten 编译的产物
  LICENSE           2,199 字节   sql.js 的 MIT 许可证
```

加载方式决定了「零外部依赖」是否成立：

```js
const wasmBinary = readFileSync(wasmPath);   // 读插件自带的字节
const SQL = await initSqlJs({ wasmBinary }); // 直传给初始化器
```

`wasmBinary` 是关键 —— 它让 Emscripten 不去文件系统里找 `.wasm`，
不联网、不查系统目录、不看 Node 版本。全程只碰插件包内的两个文件。

据此，`package.json` 里 **`dependencies` / `devDependencies` /
`optionalDependencies` / `peerDependencies` 全为空**。

| | json 后端 | 自带 sqlite 后端 |
|---|---|---|
| per-record 布局 | 一条记录一个文件 | 一条记录一行 |
| 10 万条记忆 | 10 万个小文件 | 单文件，行级索引 |
| `loadAll` | `readdir` 整个目录 | 主键索引扫描 |
| 可读性 | 直接 `cat` | 需 sqlite 工具（有只读导出口） |
| 持久化粒度 | 每次写即落盘 | 合并落盘（一拍内合并，见下） |

### 三种模式

| `storageMode` | 行为 |
|---|---|
| `auto`（默认） | 优先自带 sqlite；失败时退回 profile 路由 |
| `sqlite` | 强制 sqlite，失败则**拒绝启动**（fail loud，不静默降级） |
| `json` | 不注册 sqlite 后端，完全沿用 profile 的 `storage-domain` 路由 |

引擎随包分发后，「用户机器没装 sqlite」不再是降级理由。`auto` 的降级分支
只剩环境类故障：包文件被裁掉、磁盘不可写、库文件损坏且无法改名。
`sqlite` 显式指定时静默退回 json 会让「我明明配了 sqlite」变成难查的悬案，
所以直接抛错。

### 持久化模型：内存库 + 整库导出

wasm 引擎没有文件系统层，整个库常驻内存。`db.export()` 才拿到完整的文件字节。
因此写路径是：

```
改内存 → 标记 dirty → setTimeout(0) 合并落盘 → 临时文件 → fsync → rename
```

实测 1 万条约 2.5MB，export 约 1ms，所以每次写完落盘是可接受的；
合并窗口让「一个 turn 内连写十几条」只落盘一次。

落盘用 `临时文件 → fsync → rename`。顺序不能反：反过来的话，
断电可能换来一个「已改名成功但内容还是空」的文件，那是真正的数据丢失。

**代价必须说清楚**：进程被 `kill -9` 会丢掉最后一次落盘之后的写入。
json 后端是逐条写即持久，这一项弱于 json。缓解手段是 `beforeExit` 兜底 ——
事件循环空转时补一次同步落盘，覆盖 Ctrl+C、宿主 shutdown、单次 CLI 结束
这三种常见退出。

### 引擎 PRAGMA：为什么要关掉回滚日志

```js
PRAGMA journal_mode = OFF
PRAGMA synchronous  = OFF
PRAGMA foreign_keys = ON
PRAGMA temp_store   = MEMORY
```

`journal_mode = OFF` 不是「为了快」而是「不该有」：sqlite 的回滚日志是为
了「进程崩溃时库文件仍一致」。但这里磁盘上的文件只在落盘时整体覆盖写，
崩溃时旧文件是完整的 —— 内存里的回滚日志毫无用处，纯粹是每次写入
创建/删除空文件的开销。

2000 条插入的四阶段实测：

| 做法 | 耗时 |
|---|---|
| 逐条 `prepare` + `step`（无缓存） | 192ms |
| 复用语句对象 | 188ms |
| 复用 + `journal_mode=OFF` | 35ms |
| 复用 + `journal_mode=OFF` + `synchronous=OFF` | 21ms |

两个优化点都反直觉，值得记下来：

1. **语句缓存**。每次 `db.prepare()` 都要把 SQL 文本编组进 wasm 堆。
   单独测「2000 条 × prepare/free」是 217ms，复用语句对象只要 6ms —— 36 倍。
   缓存必须能被 `export()` 失效：`export` 会释放所有语句并重开句柄。
2. **关掉回滚日志**。收益来自「不再每次写入创建/删除空文件」，
   而不是让写入本身变快 —— 见上表第二行到第三行的落差。

这个取舍的安全性完全依赖上面的原子落盘，不能单独拿掉任何一边。

⚠ **`db.export()` 会重置 PRAGMA**。sql.js 的 export 关掉并重开底层句柄，
`journal_mode` 从 `off` 打回 `delete`、`synchronous` 从 `0` 打回 `2`。
只在启动时设一次等于没设 —— 这是实测踩出来的：写入耗时一直停在 200ms
量级，查 PRAGMA 才发现。所以每次 `flushNow` 之后都要补一遍。

### 库文件位置

默认 `<dsh home>/storages/memory_hybrid.sqlite`，可用 `sqliteFile` 覆盖任意绝对路径。

### 表结构

```
meta                               unit 名 → 版本戳
_global                            unit 名 → global 槽位 JSON
_backup                            backupRecord 移出的记录（保留原始字节）
u_memory_hybrid__memories          key / ver / body
u_memory_hybrid__edges             同上
u_memory_hybrid__journal           同上
```

表名规则是 `u_<unit>__<table>`。记录体对后端是**不透明 JSON**，
schema 由 domain 层用 zod 负责 —— 后端只管存取，不理解内容。

### 库文件损坏怎么办

不能删用户数据。做法是改名保留：`memory_hybrid.sqlite` →
`memory_hybrid.sqlite.corrupt-<ISO 时间戳>`，然后从空库重建，
原因写进 `backend.stats().lastError` 与启动日志。

只改名、绝不删除 —— 万一「损坏」判断是错的（比如引擎版本兼容问题），
用户的数据还在那个文件里。改名失败则直接抛错，走上层「后端不可用 → 降级」
的路径，而不是吞掉错误再覆盖写。

⚠ sql.js 的 `new Database(bytes)` 是**惰性加载**：坏字节不会在构造时抛错，
要等第一次真正读表才报 `file is not a database`。所以 `create()` 里主动
探一次 `SELECT count(*) FROM sqlite_master`，把错误提前到可控位置。

### 版本语义

严格按契约分两档：

- **per-record**：逐条判版本。版本不在 `compatibleVersions` 里的那条**读作不存在**，
  其余照读。这是「一条坏记录不毁整库」的基础。
- **single**：exact-version。任一条版本不符，整个 unit 拒绝打开。

### 只读导出

sqlite 是二进制，不能像 json 那样直接看。两种方式：

**一、用插件自带的引擎读**（无需用户装任何 sqlite 工具）

⚠️ 下面的路径是 `./plugin/src/...`，**必须在工作区根目录执行**（`plugin/` 的上一层）。
若你当前在 `plugin/` 里，把路径去掉前缀 `plugin/` 即可。

```bash
node --input-type=module -e "
import { loadSqlite } from './plugin/src/storage/sqlite-engine.js';
import { readFileSync } from 'node:fs';
const SQL = await loadSqlite();
const db = new SQL.Database(new Uint8Array(readFileSync(process.argv[1])));
const st = db.prepare('SELECT key, body FROM u_memory_hybrid__memories');
while (st.step()) { const r = st.getAsObject(); console.log(r.key, JSON.parse(r.body)); }
st.free(); db.close();
" ~/.dsh/storages/memory_hybrid.sqlite
```

**二、用宿主的 sqlite 工具**（若装了）

```bash
sqlite3 ~/.dsh/storages/memory_hybrid.sqlite \
  "SELECT key, body FROM u_memory_hybrid__memories"
```

或直接用 `memory_manage` 工具的 `list` 动作 —— 这是最省事的路径。

后端还提供了 `exportBytes()`，把整库字节交出来，可以另存一份用别处打开。

### 迁移：json → sqlite

两者数据格式不通用（一个目录一棵文件树，一个单库多表）。迁移步骤：

1. 用 `storageMode: json` 启动一次，`memory_manage list` 导出全部条目
2. 切换到 `storageMode: sqlite`
3. 用 `memory_remember` 逐条回灌（或用脚本走 `runJob`）
4. 确认无误后删除旧的 `storages/memory_hybrid/` 目录

**没有自动迁移**。理由是迁移要读旧写新，一旦中途失败就两份数据都不完整。
宁可手动几步，也不要一个跑了半截的迁移器。

---

## 六、配置项

**全部配置都可以在 dsh 客户端里改**，不需要手编 YAML：打开 **设置 → 插件 → 记忆**，或点左侧边栏的**记忆**图标，改完即时生效、无需重启。

这一页由插件自己提供，不是宿主变出来的。`ctx.settings.describe()` 只回传 schema **数据**（`autoGenerate` 只决定是否把 schema 一起给你），宿主**不会**据此渲染表单 —— `settings.plugins.tab` 插槽里原本只有官方那个只读的插件清单，没有任何通用渲染器。所以本插件带了一份浏览器端代码 `plugin/client.js`，自己往插槽里注册了一个 id 为 `memory-hybrid` 的 tab，外加一对侧栏图标 + 主面板。

这个页面是真正的可视化表单，不是一堆待填的文本框 —— 每个字段按语义选控件：

| 字段类型 | 控件 | 用到的宿主件 |
|---|---|---|
| 布尔（`autoRecall` / `sweepOnStart` / `verbose`） | 拨动开关 | `Switch`（`role="switch"`，键盘可操作） |
| 枚举（`embedSource` / `storageMode`） | 分段选择器 | `SegmentedControl`（`role="tablist"`，方向键切换） |
| 数字（`recallLimit` / `contextOrder` / `dim`） | 数字输入框 | `SettingsValueField` + `numeric` |
| 文本（路径 / 端点 / 模型 id） | 文本输入框 | `SettingsValueField` |
| 密钥（`embedApiKey` / `jevApiKey`） | 只写输入框 | `SettingsSecretField` |

`Switch` 与 `SegmentedControl` 都是 `@deepseek-ai/dsh-client-ui-primitives` 的正式导出，与官方设置页用的是同一套件，所以视觉、键盘操作、无障碍语义完全一致，不需要自己画控件或维护类名。

有两处取舍值得记下来：

- **开关的状态要自己翻成草稿文本。** 表单模型的内部表达是「文本草稿」，`Switch` 只报开/关，所以 `onChange` 里译成 `"true"` / `"false"`。**不要**在开关里直接 `mutate`：那样这一个字段会立刻落盘，其余字段还在草稿里，形成「半保存」状态，最难向用户解释。
- **「已覆盖 / 恢复默认」的徽标位挪到了说明文字旁。** 宿主的 `Switch` / `SegmentedControl` 没有 `SettingsValueField` 那个徽标槽，所以把「恢复默认」渲染成标签右侧的小按钮。信息没丢，位置换了。

带 `role("secret")` 的字段（`embedApiKey` / `jevApiKey`）渲染成只写输入框：一旦存过就只显示「已配置」，值不再回传给前端，输入框留空保存也不会把已存的密钥清掉。

### 侧栏面板：同一份配置的第二个入口

除了「设置 → 插件 → 记忆」，左侧边栏还有一个**记忆**图标，点开就是同一张表单。两个入口不是两套实现 —— 都由同一个 `MemoryCardController` 供数，改一边、另一边看到的就是改后的值，不存在同步问题。

注册要占两个插槽，且**必须成对**：

```js
const PANEL_ID = "memory-hybrid";   // 侧栏 id
const PANEL_ORDER = 2;              // 排在官方面板之后的顺序位

// ① 侧栏图标：list 类插槽，必须有 id
ctx.slots.inject("sidebar.panellist", () =>
  ctx.slots.register(
    { name: "sidebar.panellist", id: PANEL_ID, order: PANEL_ORDER, locale: NS, label: () => t("panel") },
    MemoryIcon,
  ),
);

// ② 主面板：keyed 类插槽，key 必须等于上面那个 id
ctx.slots.inject("main", () =>
  ctx.slots.register(
    { name: "main", key: PANEL_ID, locale: NS, inject: props },
    MemoryPanelPage,
  ),
);
```

**`sidebar` 的 `id` 与 `main` 的 `key` 必须严格相等。** 宿主点图标时执行的是 `ctx.layout.selectPanel(id)`，`main` 槽按 `key` 取组件；两边对不上，图标点下去**什么都不发生**，控制台连一行警告都没有。这是本节唯一一个「错了也静默」的地方，所以专门写了测试锁住它（见下）。

两者的插槽种类不同，字段要求也不同：

| 插槽 | 种类 | 必需字段 | 少了会怎样 |
|---|---|---|---|
| `sidebar.panellist` | `list` | `id` | 注册被槽校验拒掉，图标不存在 |
| `main` | `keyed` | `key` | 同上，面板永远不渲染 |

`label` 给的是 `() => t("panel")` 而不是字符串 —— 字符串在注册那一刻就被求值，用户切语言不会跟着变。

`MemoryIcon` 是三层递减的圆角矩形，用 `currentColor` 上色并读 `props.active` 调透明度（`active ? 1 : 0.85`）。**不要写死颜色**，侧栏在选中/悬停/深色模式下都由宿主改父级 `color`，写死就跟主题脱节。

`MemoryPanelPage` 只是一层壳：`main` 槽给的是个空盒子（`MainPanel` 直接 `renderSlot("main")`，不带内边距），而 `MemoryCard` 返回的 `SettingsForm` 是给设置页正文用的、不自带边距，直接塞进去会贴窗口边。所以外面包了 `padding: 28px 32px 48px` + `maxWidth: 720` 居中。

### 三处注册怎么收口 —— 以及为什么不能用同一个守卫

设置页 tab、侧栏图标、主面板是**三次** `ctx.slots.inject`。收口分两步：每处 `inject` 各自返回自己的 disposer，再合成一个交给 `ctx.effect`。

```js
const slot = (name, options, component) =>
  ctx.slots.inject(name, () => ctx.slots.register({ name, ...options }, component));

// 设置页 tab 单独走 whileServed —— 它真的依赖命名空间可写
const guardedTab = () =>
  ctx.configForms.whileServed([NS], () =>
    slot("settings.plugins.tab", { id: "memory-hybrid", order: 20, ... }, MemoryCard),
  );

ctx.effect(() => {
  const offs = [
    guardedTab(),                                        // ① 有守卫
    slot("sidebar.panellist", { id: PANEL_ID, ... }, MemoryIcon),   // ② 无守卫
    slot("main", { key: PANEL_ID, ... }, MemoryPanelPage),          // ③ 无守卫
  ];
  return () => {
    for (const off of offs) {
      try { off?.(); } catch {}
    }
  };
}, "memory-hybrid: page");
```

`try/catch` 不是防御性冗余：三次 `register` 的返回类型由宿主决定，其中一个返回 `undefined` 时不该让另外两个漏掉。

**注意**：上面这段是上一版的写法，它修掉了「whileServed 包住侧栏」的问题，但**侧栏仍然不出现** —— 因为同一个病还有第二种、更彻底的形态。见下面两节。

#### 事故一：把三处都包进 whileServed，整个侧栏消失

最初三处**全**包在 `ctx.configForms.whileServed([NS], ...)` 里，理由是「命名空间没被服务时不要露出空页面」。代价是：**侧栏图标根本不出现**。

根因是 `whileServed` 的语义和它守护的对象不匹配：

| | 依赖什么 | 该不该用 whileServed |
|---|---|---|
| 设置页 tab | 命名空间**可写**（表单要保存） | 该 —— 不可写时露出页面只是让人白填 |
| 侧栏图标 / 主面板 | 只要 `slots` 服务在 | **不该** —— 侧栏不关心配置能否写 |

更麻烦的是 `whileServed` **静默不触发**。宿主没把该命名空间放进 describe 镜像时，它只是不调用回调，不抛错、不打日志。于是：

- 插件的 Host 端 `apply` 正常跑（记忆库照建、工具照注册）
- 浏览器端 `apply` 也正常跑完
- 但 `slot()` 一次都没被调用 → 侧栏没有图标，设置页没有 tab
- 控制台干干净净

用户看到的就是「装了插件但左侧没入口」，而日志里找不到任何线索。

**判据**：需要命名空间里**可编辑的表单**才用 `whileServed`；纯粹展示、或只读 `slots` 的界面，直接注册。

#### 事故二（更彻底）：把 configForms 写进顶层 inject

修掉事故一之后侧栏**依然不出现**。继续查才发现同一处代码还有第二个坑：

```js
const inject = ["slots", "locale", "configForms"];   // ← 错
```

`inject` 不是「import 声明」，是**硬门禁**。cordis 的语义是「列出的服务全部就绪后才调用 apply」；等服务期间不报错、不打日志、不降级 —— 就是安静地不执行。

所以 `configForms` 一旦因为任何上游原因迟到（settings 插件没起来、`remote` 通道未就绪、describe 镜像还没建），整个 `apply` 都不会跑：侧栏、主面板、设置页 tab **一起消失**，比事故一还干净。

而本插件对 `configForms` 的依赖强度其实只是「有了才能填设置表单」，不是「没有就不该工作」。侧栏图标和主面板根本不需要它。

**修法 —— 按依赖强度拆开**（对应插件开发标准「必需依赖用 inject 声明，可选依赖用 ctx.get() 判空」）：

| 服务 | 依赖强度 | 声明方式 |
|---|---|---|
| `slots` / `locale` | 硬 —— 缺了整个插件没意义 | 顶层 `inject` |
| `configForms` | 软 —— 只影响设置表单 | 自己的 `ctx.inject(["configForms"], cb)` |

用到 `configForms` 的两处各自独立等待，互不牵连：

```js
// ① 控制器：服务到了才建；没到就一直等，apply 不受影响
ctx.inject(["configForms"], (child) => {
  child.effect(() => {
    controller = new MemoryCardController(child, child.configForms.get(NS));
    return () => { controller?.dispose(); };
  }, "memory-hybrid: form");
});

// ② 设置页 tab：ctx.inject 之外再套 whileServed（命名空间可写）
ctx.inject(["configForms"], (child) => {
  child.effect(
    () => child.configForms.whileServed([NS], () =>
      child.slots.inject("settings.plugins.tab", () => child.slots.register({...}, MemoryCard))),
    "memory-hybrid: tab",
  );
});

// ③ 侧栏两处：完全不碰 configForms，无条件注册
ctx.effect(() => {
  const offs = [
    slot("sidebar.panellist", { id: PANEL_ID, ... }, MemoryIcon),
    slot("main", { key: PANEL_ID, ... }, MemoryPanelPage),
  ];
  return () => { for (const off of offs) { try { off?.(); } catch {} } };
}, "memory-hybrid: page");
```

`ctx.get(name)` 的语义已核对 cordis 源码（`lib/index.js:763`）：

```js
/** Read a service from the store without the inject requirement.
 *  @returns the service value, or `undefined` when not (yet) provided. */
get(name, strict = true) {
  return getTraceable(this.ctx, this._getImpl(name, strict)?.value);
}
```

「without the inject requirement」+「`undefined` when not provided」正是软依赖要的两点。`MemoryCardController` 里两处读 `configForms` 的地方也据此改成 `ctx.get("configForms")` 判空。

**判据**：问自己「这个服务缺席时，插件还有没有价值？」有 → 软依赖，用 `ctx.inject` 或 `ctx.get`；没有 → 硬依赖，进顶层 `inject`。侧栏属于「有」。

#### 事故三：侧栏出现了，面板却写「该插件当前未加载」

0.2.2 之后侧栏入口终于出现，但点进去主面板只有一句：

> 长期记忆
> 分级 · 衰减 · 唤醒 · 淘汰
> **该插件当前未加载，暂时无法配置。**
> 也可在 设置 → 插件 → 记忆 中修改同一份配置

这四行里，标题、副标题、脚注都是 `MemoryPanelPage` 自己画的 —— 它们正常渲染，说明**插件在跑、组件树在跑**。只有中间那句来自 `SettingsForm` 的 `labels.unavailable` 分支：

```js
function SettingsForm(props) {
  const { state, labels } = props;
  if (!state.available) return jsx("p", { ... children: labels.unavailable });
```

而 `state.available` 的来源是（`dsh-client-ui-primitives/lib/index.js:7190`）：

```js
shell() {
  const snapshot = this.scope.getSnapshot();
  return { available: snapshot.status === "ready", ... };
}
```

所以问题收敛成一件事：**`scope.getSnapshot().status` 为什么永远不是 `"ready"`**。

##### 根因：宿主按页面来源关掉了整个表单

`dsh-client-ui-settings/lib/client.js:1509`：

```js
const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";
```

`isLoopback` 的判据在 `dsh-client-connection/lib/client.js:1333`：

```js
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && ...;
}
```

**只认 `localhost` / `[::1]` / `127.x.x.x`。** 用公网 IP 或域名打开页面时它是 `false`，于是 `persistence = "memory"`，而 memory 分支下三件事同时发生：

```js
// 1118 行 —— 一经构造就是终态，永远不会变
status: persistence === "host" ? "loading" : "unavailable",
// 1407 行 —— 镜像永不加载
load()   { if (this.persistence === "memory") return Promise.resolve(); }
// 1423 行
ensure() { if (this.persistence === "memory") return Promise.resolve(); }
// 1213 行 —— 写入一律直接失败，连请求都不发
enqueue(operation) { if (this.persistence === "memory" || this.disposed) return Promise.resolve(false); }
```

于是 `status` 恒为 `"unavailable"`、`available` 恒为 `false`、界面恒为「该插件当前未加载」。**与插件无关，也不是「没加载」** —— 宿主的措辞在非 loopback 场景下是误导性的。

同一个限制也解释了为什么设置页 tab 同样不出现：`whileServed` 读的是那个永不加载的镜像，`served` 恒为空集。

##### 先确认 Host 侧是好的，再动手

排查时一度怀疑 Host 端 `src/index.js` 的 `inject` 里硬写着 `storageDomain` 会造成 pending。注意 `cordis.patch.yml` 的注释里正记着这个先例：「patch 里写着 storageDomain，模块已改成软探测，结果插件永远不启动」。两条信息矛盾，必须实测。

在服务器上临时给 `apply` 注入一段诊断后重启，得到：

```
[DIAG] rows= 20
[DIAG] ns= ...,ui-chat,agent-preset-registry,dsh-memory-hybrid
[DIAG] hit= true
[DIAG] secrets= [{"path":["jevApiKey"],"set":false},{"path":["embedApiKey"],"set":false}]
[DIAG] fiber.state= 2
[DIAG] writable= true
```

四条结论：`fiber.state === 2`（已挂载，`apply` 真的执行了）、`describe()` 里有本命名空间、密钥侧信道正常、`writable === true`。**Host 侧完全健康**，`storageDomain` 那条是误判 —— 该服务由 `dsh-storage-domain/lib/index.js:450` 正常 `provide`，不应改动。

这一步的价值：如果没有这份证据，很容易去改一个没坏的地方，然后被「改了还是不行」拖进更深的误判。

##### 修法：自备 scope，只走 `remote.settings`

Host 端的 `dsh-api-settings-controller` 对 `describe` / `mutate` **没有任何 loopback 门禁**（`--trusted-host` 只管 `/api` 的请求准入，见 `dsh-client-connection/lib/index.js:210`）。RPC 是通的，被挡住的只是前端那层保守策略。

而 `SettingsFormModel` 对 scope 的要求其实很窄 —— 只有三个方法：

| 方法 | 用途 |
|---|---|
| `getSnapshot()` | 读 `{status, value, base, user, revision, writable}` |
| `subscribe(fn)` | 快照变化通知 |
| `mutate(ops, expectedRevision)` | 写入 |

所以本插件自带一个 `RemoteScope` 满足这份契约，数据源直接是 `ctx.remote.settings`。控制器按需在两者间选择：

```js
const upgrade = hostScope !== undefined && isScopeServable(hostScope);
controller = new MemoryCardController(ctx, remote, upgrade ? hostScope : undefined);
```

判据 `isScopeServable` 只看一件事 —— 这个 scope 有没有可能变成 ready：

```js
function isScopeServable(scope) {
  const snapshot = scope.getSnapshot();
  if (snapshot.status === "ready") return true;
  // 非 ready 时唯一的死刑判决是 memory 持久化；loading/idle 都还在路上
  return snapshot.mode !== "memory";
}
```

`mode` 是宿主 `ConfigFormController` 自己写进快照的字段（值就是 `persistence`），拿它当判据比猜时序可靠。**注意必须区分「现在不是 ready 且永远不会变」与「现在 loading 但马上会好」** —— 否则正常 loopback 部署也会被误换成自建 scope。

安装分两级，先立即可用再择机升级：

```js
// ① 立即可用：只依赖 remote，loopback 与非 loopback 都能成
ctx.inject(["remote"], (child) => {
  child.effect(() => { install(child, child.remote); ... }, "memory-hybrid: form");
});

// ② 择机升级到宿主 scope（它的镜像与其他设置页共享，外部改动会跟着刷新）
ctx.inject(["configForms", "remote"], (child) => {
  child.effect(() => { install(child, child.remote); ... }, "memory-hybrid: form upgrade");
});
```

`install` 内部只做升级、从不降级：已经在用可用的宿主 scope 就直接返回，避免每次 setup 重发 describe。

设置页 tab 同理分两路：loopback 下保留 `whileServed`（尊重它「别露出空页面」的原意），非 loopback 下改用 `RemoteScope` 自己探一次 —— 判据与 `whileServed` 等价（都是「Host 在服务这个 ns 吗」），只是数据源换成 RPC。

##### 一个连带的时序 bug

`RemoteScope` 的 `load()` 在构造函数里就发起，而订阅往往晚于它落地。若 `subscribe` 只登记监听、不立即回调，那次状态变化就**永远收不到** —— 表现是 tab 探测静默不注册。所以 `subscribe` 里要主动回调一次：

```js
subscribe(listener) {
  this.listeners.add(listener);
  try { listener(); } catch {}     // ← 订阅时立即回调
  return () => this.listeners.delete(listener);
}
```

这与 `useSyncExternalStore` 的语义也一致：订阅方拿到的是「当前状态」，不是「下一次变化」。

##### 这个 bug 的教训

诊断「某块 UI 没出现」时，先把界面上的每一行文字对回代码里的渲染点。这次那四行字精确地把失败点钉在 `SettingsForm` 的 `if (!state.available)` 上 —— 省掉了「侧栏没出现 → 是不是插件没加载 → 是不是 inject 有问题」那一整圈弯路。

另外：**宿主没报错不代表宿主没拒绝你**。`memory` 分支是 `return Promise.resolve(false)`，静默返回失败，连 console 都不打。这类「安静地拒绝」只能靠读源码定位，看日志是看不出来的。

#### 另一个静默坑：`dsh.client.inject` 写错不会有任何提示

`package.json` 的 `dsh.client.inject` 只能列**真实存在、且该包自己声明了 `dsh.client`** 的模块。写错的表现同样是完全静默：

| 写法 | 问题 |
|---|---|
| `@deepseek-ai/dsh-client-ui-locale` | 包**不存在**。正确名是 `dsh-client-locale`，没有 `ui` 段 |
| `@deepseek-ai/dsh-client-ui-slots` | 包存在，但 `dsh` 字段为 `null` —— 服务端库，不是可注入的客户端模块 |
| `@deepseek-ai/dsh-client-ui-primitives` | 同样没有 `dsh.client`，但官方 `ui-schedule` 也这么写，实测可用 |

`client-modules` 的解析逻辑是 `if (dependency !== void 0)` —— 在启动图里找不到就**跳过**，不报错。所以错的 inject 项不会阻断加载，只是白写一行。但 `require("@deepseek-ai/dsh-client-ui-locale")` 这种**真的去 require** 的错误就会直接抛 `missed the module table`，连带整个插件不加载。

`test/manifest.test.mjs` 现在会校验 inject 里每一项都在已知客户端模块白名单内。

### 让它出现在设置页里，有三个必须同时满足的条件

这三个条件任一不满足，**页面就是不出现，而且不会报任何错**。踩过之后才知道有多难查，所以逐条写下来：

| # | 条件 | 不满足时的表现 |
|---|---|---|
| 1 | Config 每个字段都要 `.volatile()` | `describe()` 直接跳过该条目，前端永远 `unavailable` |
| 2 | 密钥字段**不能**有 `default("")` | 侧信道恒报 `set:true`，界面一直显示「已配置」 |
| 3 | `package.json` 声明 `dsh.client` + `exports["./client"]` | 产物不进启动图，浏览器里根本没有这段代码 |

**关于第 1 条**：宿主的 `volatileForm(schema)` 只保留 `meta.volatile` 的字段，一个都没标时返回 `undefined`，`describe()` 便整条跳过。`volatile` 的正面语义正是我们想要的 —— 改配置不重挂插件，由插件自己响应（本插件的 embedder 每次解析都重读 config，天然满足）。

**关于第 2 条**：宿主用 `value !== undefined` 判断「配过没有」。写了 `default("")` 就永远是空串而非 undefined，于是「没配过」永远报成「配过」。实测：

```
有 default("")  → 没填也 set=true          ✗
无 default      → 没填 set=false，填了 set=true   ✓
```

同理，`cordis.patch.yml` 里也**不能**写 `embedApiKey: ''` —— 那会把「未配置」变成「配置了空串」，回到同一个坑。

**关于第 3 条**：`dsh.client.platform` 必须是 `web`，`exports["./client"]` 指向的文件必须存在且含 `__ModuleLoader__.load`。改完这些前端相关的文件**必须重启 dsh** —— client-modules 的 `pkgMeta` 按 sourceKey 缓存，含「非客户端包」的否定判决。

这一条对侧栏同样生效，而且**是侧栏能不能出现的前提**：侧栏图标跟设置页 tab 住在同一个 `client.js` 里，产物不进启动图，两者一起消失。

### 写完之后怎么自己确认

页面是否真的挂上了，可以绕过 UI 直接问宿主：

```bash
# 取首页 HTML，看启动图里有没有本插件
curl -s -b <cookie> "http://127.0.0.1:<port>/" | grep -o '"id":"dsh-memory-hybrid"[^}]*'
# 应看到类似：{"id":"dsh-memory-hybrid","url":"plugins/??dsh-memory-hybrid/client.js&rev=..."}
```

再确认命名空间真的被服务（这一条不通，tab 就不会出现）：

```jsonc
// POST /api/settings/describe，payload: { args: {} }
// 请求信封：{ type: "client-request", rpcId: "...", method: "settings/describe", payload: { args: {} } }
// 返回的 result.value.namespaces 里应该有一行 ns === "dsh-memory-hybrid"，
// 且 secrets 为 [{"path":["jevApiKey"],"set":false},{"path":["embedApiKey"],"set":false}]
```

注意 method 用**斜杠**（`settings/describe`）不是点号，且 `payload` 必须包一层 `args` —— 两处都会报 `gateway/bad-request`。

| 键 | 默认 | 说明 |
|---|---|---|
| `autoRecall` | `true` | 关掉后只能靠 `memory_recall` 工具主动翻 |
| `recallLimit` | `6` | 每次注入上限 |
| `dim` | `256` | 向量维度。改动使索引失效，但**索引可重建，数据不受影响** |
| `contextOrder` | `10500` | 注入段在系统提示里的排序 |
| `jevEndpoint` | `''` | 留空则纯规则判档（P1 行为）。填 `https://api.typesafe.ai/v1/systemone` 启用 Jev |
| `jevApiKey` | 无 | Jev 判别凭据（secret）。**刻意没有默认值**，见第六节「密钥不能有 default」 |
| `jevModel` | `jev-1.14.0` | 判别模型。`jev-latest` 会随官方发版漂移，生产建议钉版本 |
| `embedSource` | `inherit` | 嵌入来源，见下节 |
| `embedBaseURL` | `''` | 自定义嵌入端点（`custom` 时生效） |
| `embedApiKey` | 无 | 自定义嵌入密钥（secret，`custom` 时生效）。同样刻意没有默认值 |
| `embedModel` | `''` | 自定义嵌入模型 id（`custom` 时生效） |
| `sweepOnStart` | `true` | 启动时跑一次结算扫描 |
| `verbose` | `false` | 打开 debug 日志 |
| `storageMode` | `auto` | `auto` / `sqlite` / `json`，见上节 |
| `sqliteFile` | `''` | sqlite 库路径，留空用默认位置 |

### 嵌入模型（语义召回）

默认的 `embed()` 是**词袋哈希**，按字面比对。它理解不了「那家店」和「望京小腰」是一回事 —— 实测这两句的余弦只有 `0.134`，过不了 `0.22` 的建边门槛，而两句完全无关的话反而能到 `0.192`。这不是调阈值能解决的：无关的比相关的分还高。

接语义嵌入就是为了这个。`embedSource` 三选一：

| 值 | 行为 |
|---|---|
| `inherit`（默认） | 自动沿用当前 dsh 客户端正在用的 API 地址 / 密钥 / 模型 |
| `custom` | 用下面三项自己填 |
| `off` | 关掉语义召回，退回词袋哈希 |

**继承是怎么做到的**：宿主 `ctx.llm.listProviders()` 只返回 `{id, name}`，不含 `baseURL`，所以继承走配置文件 —— 从 profile 的 `cordis.patch.yml` 里读 `agent-default-model` 的 `provider`/`model`，再读对应 `llm-*` 条目的 `baseURL`/`apiKeyEnv`，密钥再经 `apiKeyEnv` 解析（进程环境变量 → 凭据服务 → `~/.dsh/.credentials.yaml` 三层兜底）。路径优先用 `ctx.configEditor.documentPath`，其次 `ctx.profileContext.home`。

**⚠ 继承来的通常是生成模型，它多半没有 `/embeddings` 接口。** 实测本机 `api.dsesnet.com/v1` 直接返回 `404 Route Not Found`。这属于预期行为而非 bug —— 生成与嵌入是两种模型。要真正启用语义召回，需要把 `embedSource` 改成 `custom`，填一个嵌入模型，例如：

```
embedBaseURL = https://api.dsesnet.com/v1     （或任何 OpenAI 兼容网关）
embedModel   = bge-m3 / bge-large-zh-v1.5 / text-embedding-3-small / text-embedding-v3
embedApiKey  = <该网关的密钥>
```

改完在对话里让它验证：

```
memory_manage(action="embed_status", probe=true)
```

会打印实际生效的地址/模型/密钥状态，并真打一次端点，失败时给出可操作的说明（404 会明确提示"该地址没有 /embeddings 接口"）。

**降级保证**：嵌入不可用时不会报错、不会阻断写入，只是退回词袋哈希，关联质量下降而已。记忆系统是旁路设施，嵌入端点挂了不该让对话失败。

### Jev 判别（可选，P3 期）

Jev 是 TypeSafe AI 的「System One」判别模型 —— **不是聊天模型**，它不写文字，只对你给的 typed question 回选择题和概率。本插件用它在写入时判「这条记忆属于什么类型、有多重要」。

想启用需要两样东西，缺一个都不会走 Jev（会静默退回内置规则，不报错）：

| 配置项 | 填什么 |
|---|---|
| `jevEndpoint` | `https://api.typesafe.ai/v1/systemone` |
| `jevApiKey` | TypeSafe 控制台创建的 API Key |

**密钥从哪来**（2026-10 核实）：

1. 打开 <https://console.typesafe.ai> 注册。Jev 在 2026-09-15 上线时带等候名单，9/21 已取消，现在是开放注册。
2. 进 Keys 页（<https://console.typesafe.ai/settings/keys>）创建一个 key。
3. 把 key 填进设置页的「Jev 密钥」，或写进 `~/.dsh/.credentials.yaml`。

其他细节：

- **价格**：输入 $0.042 / 百万 token，输出不计费。单次判定约 $0.0001。
- **免费额度**：有报道称注册送 $5（约 1.2 亿 token），但官方未确认，以控制台实际显示为准。
- **模型名**：默认 `jev-1.14.0` 是钉死的版本。官方的 `jev-latest` 别名会随发版漂移（2026-10-24 从 1.13.0 跳到 1.14.0），生产环境建议继续钉版本。
- **也可以走网关**：Vercel AI Gateway（`typesafe-ai/jev`）或 Cloudflare Workers AI（`typesafe/jev`）都能调用同一个模型，模型 id 各家不同，注意对齐。

**⚠ 别急着开。** 设计文档写明要先让前 200 条记忆只走规则判定、人工标注、再跑 PR 曲线校准阈值，才能用 Jev 替换。跳过这步等于凭空相信论文里的 `0.60` / `0.70`，而那两个值只在单一数据集上验证过。

接好之后可以这样确认它真的在工作（而不是悄悄降级）：

```
memory_manage(action="stats")
```

看 `jevDegraded` —— 它是「本轮有候选记忆没走成 Jev」的计数，持续为 0 才说明真的接上了。

---

## 七、工具

只暴露 3 个。工具越多，模型越容易无必要地调用，反而污染上下文。

### `memory_recall`

```jsonc
{ "query": "报告署名怎么写", "limit": 3, "includeDormant": true }
```

三路合并（向量 / 词法 / 图扩展）后重排，返回 `tier` + `score` + `via`。命中会顺带 `touchRecalled`：`long` 加深稳定度，`dormant` 尝试唤醒。

### `memory_remember`

主动写入一条。适合「这句话很重要，现在就存下」而不想等自动抽取的场景。

### `memory_manage`

```jsonc
{ "action": "stats" }                        // 计数与统计
{ "action": "list", "limit": 20 }            // 按稳定度列条目
{ "action": "forget", "id": "..." }          // 强制转 dormant（不删）
{ "action": "promote", "id": "..." }         // 强制转 long
{ "action": "sweep" }                        // 手动结算扫描
{ "action": "embed_status" }                 // 看嵌入配置实际生效的是什么
{ "action": "embed_status", "probe": true }  // 再真打一次端点验证连通
```

`embed_status` 是配置排查的主入口：它打印的是**实际生效**的地址/模型/密钥状态（不是用户填了什么），会标出继承来源（如 `inherit:string/deepseek-v4-1-flash`），`probe: true` 时还会说明失败的具体原因 —— 404 会明确提示「该地址没有 /embeddings 接口」，401/403 会提示密钥问题。

---

## 八、存储布局

两种后端都使用 `per-record` 布局，只是物理形态不同。

**sqlite（默认）** —— 单文件多表：

```
~/.dsh/storages/memory_hybrid.sqlite
├── meta                          unit 名 → 版本戳
├── _global                       global 槽位（emaV/emaA/moodAt/stats/schemaV）
├── _backup                       backupRecord 移出的坏记录
├── u_memory_hybrid__memories     key / ver / body
├── u_memory_hybrid__edges        key / ver / body
└── u_memory_hybrid__journal      key / ver / body
```

**json（`storageMode: json`）** —— 一个 domain 一个目录：

```
~/.dsh/storages/memory_hybrid/
├── memories/<id>.json            # 每条记忆一个文件，含 version 戳
├── edges/<edgeId>.json
├── journal/<jobId>.json
└── global.json
```

选 `per-record` 而非 `single` 的理由：`storage-domain` 对版本不匹配**只拒绝不迁移**。`per-record` 下坏记录被备份跳过、整库仍可用；`single` 下一条坏记录就废掉整个 unit。

### 写入路径

```
turn/end (session/event)
  └─ journal.enqueue()          ← 毫秒级，不阻塞
       └─ Journal worker
            ├─ resolveMood      读 global 的 emaV/emaA，更新后写回
            ├─ extract          抽取候选记忆
            ├─ jev 判别（可选）  失败降级为规则判定
            ├─ upsertCandidate  去重 → 新建 or grow
            └─ buildEdges       建边（带词法二次确认）
```

`agent/turn-stopping` 是 serial 收尾点，官方明确禁止长任务。所以那里**只入队不做活**，真正的抽取/判定/落盘全在 worker 里。

### 后端选择的时序约束

这一节记录的是实测踩出来的装配顺序，改后端相关代码前必读。

`storage-domain` 用 `ctx.inject([...backendNames])` 延迟挂载，而它的 `backendNames`
在**自身 apply 时**就固定了（来自 profile 的 `backend` / `routes`）。
插件注册 sqlite 后端必然晚于它，于是在「profile 全局 `backend=json` + 我要 sqlite」
这个组合下，profile 的 facility 永远不会就绪。

两难：

| 做法 | 后果 |
|---|---|
| `inject` 里不写 `storageDomain` | 读 `ctx.storageDomain` 直接抛 `cannot get property without inject` |
| `inject` 里写 `storageDomain` 并等它 | 服务永不就绪 → 插件静默 pending，进不了 `apply` |

**解法**：两样都要 —— `inject` 里声明（拿到访问许可），但代码**不等它**。

- 常规路径：facility 可用且路由正确 → 直接 `open`
- 自 rout 路径：facility 不可用或用错后端 → 用公开导出的 `DomainFacility`
  自建一个，只依赖 `ctx.storage`

`DomainFacility` 的构造只需 `(ctx, config)`，两个实例可以并存 —— 各自持有
`domains`/`reserved` 表，底层 backend 是同一个，因此数据仍是同一份。
这样插件不需要改写用户的 profile 配置。

另外 `storage` 也必须声明：Cordis 对 ctx 属性访问做 inject 保护，
代码里只要出现 `ctx.storage`（哪怕在 `try` 里），就必须声明，否则运行时抛错。

---

## 九、已知限制

### 1. embedding 必须外接，宿主不提供

`dsh-llm` 的 `ModelModalityMap` 只有 `text` / `image`，**没有 embedding 接口**，`listProviders()` 也只返回 `{id, name}`。所以语义嵌入只能外接一个 `/embeddings` 端点，由 `embedSource` 决定用哪个（见「六、配置项 → 嵌入模型」）。

未配置或配置不可用时，向量层退回「中文双字切分 + 特征哈希」，本质是词袋余弦。实测分布：

| 关系 | 余弦区间 |
|---|---|
| 完全无关 | −0.07 ~ 0.08 |
| 共享一个关键词 | 0.13 ~ 0.18 |
| 共享多个 | 0.30 ~ 0.35 |
| 近乎同句 | > 0.80 |

所以阈值按这个分布定，而不是按语义相似度直觉定：`REL_THRESHOLD=0.22`、`CAUSAL_THRESHOLD=0.34`、`DEDUP_THRESHOLD=0.82`。

**⚠ 接入真嵌入后这三个阈值必须重标**：语义向量的余弦分布整体上移，沿用词袋的阈值会让几乎所有条目都建边。`config.js` 里这三个常量旁边已写了这条警告。

词袋模式下**语义泛化能力有限** —— 同义不同词（「故障排查」vs「问题定位」）抓不到；代词指代（「那家店」指「望京小腰」）也抓不到，因为二者没有任何字面重叠。这类关联只能靠真嵌入，或靠模型在写入时做指代消解。

### 2. 宿主依赖必须走 `createRequire`

profile 的 `node_modules/@deepseek-ai/` 下的符号链接**可能全部断裂**（实测本机 195 个全断，指向不存在的 Desktop 路径）。静态 `import '@deepseek-ai/xxx'` 会在 `apply` 之前就 ERR_MODULE_NOT_FOUND。

`src/resolve.js` 用 `createRequire` 向宿主借依赖，锚点推导顺序：

1. 环境变量 `DSH_MEMORY_HOST_PKG`（显式覆盖）
2. `ctx.baseDir` / `root` / `cwd`
3. `process.argv[1]` 反推 + PATH 查 `dsh`
4. `DSH_HOME` / `~/.dsh` 下的 profile 树
5. `process.cwd()`

排障时可直接验证：

```js
import { hostProbe } from 'dsh-memory-hybrid/src/resolve.js';
console.log(hostProbe('@deepseek-ai/dsh-tools'));
```

### 3. 写入延迟

记忆落盘发生在 turn 结束后，**下一轮才召回得到**。同轮内的对话内容不进记忆。这是刻意的：同轮内容本身就在上下文里，再注入一遍纯属浪费 token。

### 4. 引擎随包分发，体积 660KB

SQLite 引擎（`vendor/sqlite/sql-wasm.wasm`，659,806 字节）随包分发，因此
**不依赖 Node 版本、不依赖用户系统里装了什么**。代价是包体积增加约 660KB。

为什么不用 `better-sqlite3`：那是原生模块，要么按平台分发预编译产物，
要么让用户装 node-gyp 现场编译 —— 两条路都违背「零外部依赖」。

为什么不用 `node:sqlite`：它是 Node 运行时自带的能力，可用性取决于用户装的是
哪个 Node 版本。换台机器、换个运行时、用打包过的单文件二进制，这个假设就可能
不成立。README 的早期版本确实用过它，本轮已替换。

真正的失败模式（不再是 Node 版本问题）：

- 包文件被裁剪（打包工具没带 `vendor/`）→ `auto` warn 一行退回 profile 路由；
  `sqlite` 直接抛错，拒绝启动
- 磁盘不可写 → 同上
- 库文件损坏且无法改名 → 同上

`package.json` 的 `files` 必须包含 `vendor`，否则发布时 wasm 不会被打包。

### 4.1 会丢最后一次落盘之后的写入

引擎常驻内存，`db.export()` 才产出文件字节，所以持久化是「合并落盘」
而非「逐条写即持久」。`kill -9` 会丢掉最后一次落盘之后的写入。

已做三层缓解：`setTimeout(0)` 合并窗口极短；`close()` 先落盘再标记关闭；
`beforeExit` 兜底覆盖 Ctrl+C、宿主 shutdown、单次 CLI 结束。

仍然存在的窗口：进程被强杀、断电。此时丢的是最近几毫秒到一两拍的加固数据，
不是全量记忆 —— 库文件本身始终是完整一致的（原子 rename 保证）。

### 5. 两种后端数据不互通

json 是目录树、sqlite 是单库多表，格式不通用。插件**不提供自动迁移** —— 迁移要读旧写新，中途失败会让两份数据都不完整。手动迁移步骤见第五节「存储后端」。

---

## 十、调参

全部集中在 `src/core/config.js`，改完无需动其他文件。

```js
// 遗忘/降级阈值
R_FORGET = 0.05      // 低于此转 dormant
R_DEMOTE = 0.20      // long 低于此回落 active
LAMBDA_LONG = 4.0    // long 的衰减放大倍数
S_MAX = 365.0        // 稳定度上限（天）

// 晋升/降级
S_PROMOTE = 30.0     // 晋升 long 的稳定度门槛
RECALL_MIN_PROMOTE = 2   // 且至少被召回这么多次
S_DEMOTE = 20.0
S_REVIVE = 0.5       // 唤醒后的稳定度
IMP_FLOOR_REVIVE = 0.40  // 唤醒后的重要性下限

// 间隔效应
G_BASE = 0.5
SPACING_K = 1.5

// 心情
THETA_BASE = 0.55
K_V = 0.50           // 调大 → V 影响力更强
K_A = 0.10           // 调大 → 唤醒对巩固影响更强
EMA_ALPHA = 0.55     // 心情惯性；1.0 = 只看当前，0 = 永不更新
CONF_MIN = 0.55      // 心情判定的最低置信度
MAX_LABELS = 2       // 组合心情最多几类
MOOD_HORIZON_MS = 30 * 60 * 1000   // 心情有效期 30 分钟

// 图
REL_THRESHOLD = 0.22
CAUSAL_THRESHOLD = 0.34
DEDUP_THRESHOLD = 0.82

// 排序权重
WEIGHTS = { sim: 0.55, importance: 0.20, retention: 0.15, recency: 0.10 }
RECENCY_TAU_DAYS = 30
```

### 调参陷阱（踩过的）

| 现象 | 原因 | 正解 |
|---|---|---|
| 心情调制完全无效 | `θ` 的摆动区间整段落在档位间隙里 | `K_V` 要大到让 `θ` 横跨至少一条档位边界 |
| 心情几乎不更新 | `α` 太小；或叠了额外折扣层 | 只保留 EMA，`α` 取 0.5~0.6 |
| 刚记下就重复却暴涨 | 间隔效应公式方向反了 | 用 `exp(k(1-R))-1`，保证 R=1 时增益为 0 |
| 遗忘永不触发 | 字段名不一致（`s` vs `stability`） | 统一读 `node.stability ?? node.s` |
| 唤醒链路失效 | `dormant` 已被 `index.drop()`，`rerank` 查不到就跳过 | `rerank` 要接 `lookup` 参数 |
| 建边永不发生 | 阈值按语义直觉定，实际是词袋哈希 | 按实测分布定阈值 |
| 记忆被乱连 | 共享停用字/伪双字也算相似 | 停用字逐字判据 + `isPseudoGram` |

### 改参数的复核清单

`tools/simulate.py` 是设计期的数值探针（不是测试套件），改完参数跑一遍：

```bash
python -X utf8 tools/simulate.py      # 在仓库根目录执行
```

它输出七节，分别回答：

| 节 | 回答什么问题 |
|---|---|
| 1 | 规律召回下，一条记忆多久晋升 long？ |
| 2 | 各档的「自然寿命」是多少天？ |
| 3 | 跑两年后，三层比例是否合理？ |
| 4 | 写 40 条/天，稳态多少条？ |
| 5 | 各情绪组合的门槛与增益取值 |
| 6 | 连续 3 轮同一情绪后，调制推到多少？ |
| 7 | 九项结构约束是否全部成立 |

按顺序确认五件事：

1. **第 7 节全部通过**。九项约束里最容易破的三条：trivial 存活 < 2 天
   （否则寒暄类累积，写入去噪失效）、long 降级晚于 active 遗忘
   （否则分层逻辑颠倒）、晋升阈值高于降级回拨（否则状态抖动）。
2. **第 2 节四档存活期跨度在 100–150 倍**。过窄则分档无意义，
   过宽则 trivial 与 critical 不像同一系统。
3. **第 3 节 `dormant` 占比 > 60%**，否则遗忘机制没真正起作用。
4. **第 5 节 `θ_write` 落在 [0.52, 0.68]、`f_gain` 落在 [0.90, 1.10]**。
5. **改了 `G_BASE` 或 `S_PROMOTE` 就重看第 1 节**，确认规律召回下
   60–120 天内能晋升 long。

### 仿真的两个局限

**召回是随机伯努利过程，不是真实检索行为。** 第 3、4 节假设每条记忆
每天以固定概率被召回，与真实使用（相关性驱动、成簇访问）不符。
真实场景 `long` 占比会高于仿真值，因为被召回的记忆往往成组出现。

**未建模关联边的唤醒传播。** `dormant → active` 在仿真中按固定
`p_revive` 触发，实际由关联边命中驱动，所以仿真的 dormant 回流率偏高。

两处局限都让结果偏**保守**（低估 long、高估 dormant）。若实测发现
dormant 过多，先怀疑召回通道覆盖不足，而非参数错误。

---

## 十一、验证

```bash
# 启动时应能看到（verbose: true 时）：
#   memory: storage backend = sqlite (<path>)        ← 或 "= json (profile 路由)"
#   memory: domain opened name=memory_hybrid via=sqlite memories=N edges=M journal=K
#   memory: restored N memories, indexed N
#   memory: ready (dim=256, autoRecall=true)

# 落盘检查
ls ~/.dsh/storages/memory_hybrid.sqlite        # sqlite
ls ~/.dsh/storages/memory_hybrid/              # json

# 确认后端真的注册了、库文件里有表（同样在工作区根目录执行）
node --input-type=module -e "
import { loadSqlite } from './plugin/src/storage/sqlite-engine.js';
import { readFileSync } from 'node:fs';
const SQL = await loadSqlite();
const db = new SQL.Database(new Uint8Array(readFileSync(process.argv[1])));
const st = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\");
while (st.step()) console.log(st.getAsObject().name);
st.free(); db.close();
" ~/.dsh/storages/memory_hybrid.sqlite
```

关键回归点：

**核心不变量**

1. `domain.open` 成功，三张表可读
2. 索引能由 KV 重建（`restored N, indexed N`）
3. 间隔效应单调：`R` 越小增益越大，`R=1` 增益恰为 0
4. 心情矩阵：`θ ∈ [0.275, 0.825]`，横跨 0.40 / 0.70 两条档位边界
5. 完整生命周期：`active → dormant →（图通道命中）→ revive → active`，
   且唤醒后重新走向量通道
6. 唤醒后**不会立刻被再次判遗忘**（`reviveNode` 必须把 `lastDecayAt`
   推进到 now，否则形成无限唤醒循环，只在 `stats.revived` 里看得到异常增长）

**sqlite 后端契约**

7. `open` 后 `loadAll` 返回声明的全部表，`global` 初始为 `null`
8. `putRecord` 是 upsert 语义（同 key 覆盖，条数不变）
9. `deleteRecord` 幂等（删不存在的 key 不抛错）
10. `backupRecord` 后该条读作不存在，字节留在 `_backup` 表
11. 重复 `open` 同 unit → `already-open`；`close` 后调用 → `closed`
12. per-record 版本不符 → 该条读作缺失；single 版本不符 → 整单 `version-mismatch`
13. 重启（全新 Context + 同一文件）后数据与 global 都还在
14. 库文件损坏 → 改名为 `<file>.corrupt-<时间戳>` 保留，空库重建，
    启动不阻断

**内嵌引擎（零外部依赖是否成立）**

15. 引擎从包内 `vendor/sqlite/` 加载，`wasmBinary` 直传 —— 不查系统路径、
    不联网、不看 Node 版本
16. 落盘后不残留 `.tmp` 文件；落盘用 `临时文件 → fsync → rename`
17. `db.export()` 之后 PRAGMA 自动补回（否则写入慢 5 倍）
18. `package.json` 四个依赖字段全空，`files` 含 `vendor`

**装配**

19. `storageMode: auto` → `effective=sqlite`，`registeredBackends` 含 sqlite
20. `storageMode: json` → `effective=json`，不注册 sqlite 后端
21. `storageMode: sqlite` 在引擎不可用时 fail loud
22. profile 路由到 json 而插件要 sqlite → 自建 facility，日志有
    `自建 domain facility`，且不改 profile 配置

### 跑测试

测试在**工作区根目录的 `test/`**，不在 `plugin/` 下（也不随 npm 包分发）。
在 `plugin/` 里直接敲 `node test/run-all.mjs` 会报 `MODULE_NOT_FOUND`。

```bash
cd <工作区根>          # 与 plugin/ 同级的那一层
node test/run-all.mjs
```

七个套件共 472 项：

| 套件 | 项数 | 覆盖 |
|---|---|---|
| `core.test.mjs` | 172 | 衰减 / 心情 / 抽取 / 召回 / 管线 |
| `backend-contract.test.mjs` | 48 | 存储后端契约 |
| `sqlite-embedded.test.mjs` | 38 | 内嵌引擎、持久化、损坏自愈 |
| `embed-config.test.mjs` | 83 | 嵌入配置继承、断言、设置页控件匹配 |
| `host-wiring.test.mjs` | 33 | 真实 cordis + storage + domain 装配 |
| `sidebar-panel.test.mjs` | 58 | 侧栏两处插槽注册 + 软依赖降级 + 非 loopback 自立（真实执行 `apply()`） |
| `manifest.test.mjs` | 40 | 两份清单一致、inject 白名单、版本是否跟上源码 |

`host-wiring` 用的是宿主真实的 `Storage` / `DomainFacility`，
不是 mock —— 装配时序这类问题只有真 cordis 才复现得出。

`embed-config` 里有一组是静态分析 `client.js` 断言「布尔必须用 `Switch`、
枚举必须用 `SegmentedControl`」，防止配置页退化成纯文本框。

`sidebar-panel` 是唯一真正**执行** `plugin/client.js` 的套件。前面五个要么
跑服务端、要么正则读源码 —— 那种断言只能证明「代码里写了这行」，
证明不了「注册到宿主之后长得对」。这个套件用 `new Function` 把 client.js
装进沙箱（桩掉 `window.__ModuleLoader__`、React、四个宿主 UI 包），
让 `apply(ctx)` 真的跑一遍，然后检查 `ctx.slots.register` 实际收到的参数：

- `sidebar.panellist` 的 `id` 与 `main` 的 `key` 都是 `"memory-hybrid"`（相等性断言）
- 两者拿到的是**不同**的组件函数
- 设置页 tab 的 `id` 仍是 `"memory-hybrid"`，没被侧栏改造带歪
- 撤销前插槽里有 3 项，调一次 `whileServed` 的 disposer 后归 0

React 桩故意做得极简（`createElement` 只返回 `{type, props, children}`，不渲染），
因为这里验的是**注册面**不是**渲染结果**；真要验渲染得上 jsdom，成本不成正比。

---

## 十二、许可

MIT

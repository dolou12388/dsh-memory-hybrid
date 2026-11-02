# dsh-memory-hybrid

给 DeepSeek Harness（dsh）的混合架构长期记忆插件。
记忆**有轻重、会遗忘、可复活** —— 不是把所有对话塞进向量库。

`plugin/` 是可直接安装的插件包，`plugin/README.md` 既是安装手册也是设计说明。

---

## 它解决什么

主流「长期记忆」方案把对话切块丢进向量库，靠相似度捞回来。问题在于：
**所有记忆权重相同**。三个月前随口一句和技术决策里的关键约束，召回机会一样大；
库里越堆越多，信噪比越来越差，最后反而成了干扰源。

这个插件换了个思路 —— 记忆是**有成本**的：

| 机制 | 做法 |
|---|---|
| **分级** | 抽取阶段就判档：episodic / semantic / procedural / preference，重要性 0–1 |
| **衰减** | 艾宾浩斯遗忘曲线按重要性分档衰减，低重要性的先淡出视野 |
| **唤醒** | 被召回 = 复习，强度回升；久未用到的沉到底层但不删除 |
| **淘汰** | 强度低于阈值的归档，可复活；不是硬删除 |
| **心情** | 全局心情值调制召回阈值 —— 同样的记忆，心情好时更容易想起 |

存储是 **KV 权威层 + 向量派生索引**：向量只是索引，真相在 KV。索引损坏可重建，
不会丢记忆。SQLite 引擎随包分发（wasm），**五个依赖字段全部未声明** ——
装到任何 dsh 上都只有它自己一个包。

---

## 目录结构

```
dsh-memory-hybrid/
├── plugin/                    插件包（可 npm pack 分发）
│   ├── src/                   16 个模块
│   │   └── graph/             图谱数据出口：rpc.js（通道）+ snapshot.js（投影）
│   ├── client.js              浏览器端：设置页 tab + 侧栏面板（1,046 行）
│   ├── vendor/sqlite/         内嵌 SQLite wasm 引擎（零外部依赖的关键）
│   ├── cordis.patch.yml       bundle 补丁，声明插件默认配置
│   ├── package.json           dsh.bundle.patch 指向上面那个 yml
│   └── README.md              安装 / 设计 / 调参 / 排查，都在这
├── test/                      8 个套件（不随 npm 包分发）
└── tools/
    ├── simulate.py            设计期数值探针（不是测试）
    ├── make-snapshot.mjs      生成图谱样本快照（用真衰减公式）
    ├── seed-store.mjs         把样本灌进/清出真实库，供实机看效果
    ├── graph-lab.html         图谱视觉编码探针（单页，无构建）
    └── graph-snapshot.md      快照数据约定（核心 → 可视化 的只读投影）
```

星图**面板**不在本仓库：它是独立的公开库
[dolou12388/dsh-memory-graph](https://github.com/dolou12388/dsh-memory-graph)
（包名 `dsh-memory-graph`），有自己的 README 和测试。本仓库只保留「数据出口」——
`plugin/src/graph/` 把记忆投影成只读快照并通过 RPC 送出去，不关心谁来画。

拆开是为了让渲染代码的每次配色调整都不必触发核心发版；`manifest` 测试里有一条
反向护栏，防止有人图方便把 `graph/` 又复制回来。

---

## 该读哪份

| 你想做的事 | 读这里 |
|---|---|
| **装上并跑起来** | [`plugin/README.md`](plugin/README.md) 第五节「装配」 |
| **改配置** | 侧边栏「记忆」图标，或 设置 → 插件 → 记忆（同一份配置，两个入口） |
| **要看记忆星图** | 另装 [dsh-memory-graph](https://github.com/dolou12388/dsh-memory-graph) |
| 理解衰减/唤醒/心情为什么这样设计 | [`plugin/README.md`](plugin/README.md) 第二~四节 |
| 改参数，看会影响什么 | [`plugin/README.md`](plugin/README.md) 第十节「调参」 |
| 排查故障 | [`plugin/README.md`](plugin/README.md) 第九节「已知限制」+ 第十一节「验证」 |
| 改代码，确认没改坏 | `test/`（8 个套件；面板的测试在 graph 那个仓库） |

---

## 快速开始

```bash
# 1. 装（bundles 会自动登记，不用手改 package.json）

# 从 GitHub 直接装（任意目录执行，不依赖本地仓库）
dsh plugin --profile <你的 profile> add "github:dolou12388/dsh-memory-hybrid"

# 或用本地源码目录（改代码即时生效）
dsh plugin --profile <你的 profile> add "link:<本目录>/plugin"

# 2. 确认配置里出现了条目
dsh --profile <你的 profile> --dump-config | grep memory-hybrid

# 3. 重启 dsh，看日志
#    memory: storage backend = sqlite (<path>, N bytes)
#    memory: domain opened name=memory_hybrid via=sqlite memories=N
#    memory: ready (dim=256, autoRecall=true)
```

两种方式都装同一个包，装完都落在 `node_modules/dsh-memory-hybrid`，
入口统一为包根的 `plugin/src/index.js`。区别只有更新时机：
`github:` 跟到某个 commit，升级要重新 `add`；`link:` 直接读工作区，改完重启即可。

> 仓库根的 `package.json` 是**代理清单**，只把入口与 `dsh.bundle.patch` 指到
> `plugin/` 子目录，源文件一个都没搬。这是 `github:` 能装的前提 —— 没有它，
> pnpm 读不到清单会合成一个空占位包，dsh 报 `declares no dsh.bundle`。

装完后库文件在 `~/.dsh/storages/memory_hybrid.sqlite`。

### 升级：`github:` 装法不会自己跟进新提交

**这是最容易踩的一个坑。** 装了之后，仓库再推新代码，重新执行同一条
`dsh plugin ... add "github:dolou12388/dsh-memory-hybrid"` **拿到的还是旧版本**，
而且输出照样显示 `+ dsh-memory-hybrid x.y.z`，看起来像成功了。

原因在 pnpm 的解析逻辑：`github:owner/repo` 这种规格**不吃 semver**。首次安装时
pnpm 把分支 HEAD 解析成一个具体 commit，钉进 lockfile：

```yaml
version: https://codeload.github.com/dolou12388/dsh-memory-hybrid/tar.gz/8e19f36dba...
```

之后再 `pnpm add` 同一个规格，它只比对包名与版本号是否已满足 —— 版本号没变，
就认为「已经装的就是这个」，跳过下载，lockfile 原封不动。`dsh plugin add`
内部走的就是 `pnpm add`（`dsh-plugin-manager` 里 `runPnpm(["add", spec, ...])`），
所以从 dsh 这边完全看不出异常。

三种正确的升级方式，任选一种：

```bash
# ① 显式钉 commit（最稳，规格里带 #<sha>）
dsh plugin --profile <你的 profile> add \
  "github:dolou12388/dsh-memory-hybrid#8e19f36dba91dbddbc66cd53abe6447cafe05cf9"

# ② 先摘掉再装（清掉 lockfile 里的钉死记录）
dsh plugin --profile <你的 profile> remove dsh-memory-hybrid
dsh plugin --profile <你的 profile> add "github:dolou12388/dsh-memory-hybrid"

# ③ 改用 link（开发期首选，永远是工作区最新代码）
dsh plugin --profile <你的 profile> add "link:<本目录>/plugin"
```

或者直接进 profile 目录跑 `pnpm update dsh-memory-hybrid` —— 实测只有 `update`
会重新解析 git 依赖，`add` 不会。

**所以每次推新代码都要升版本号**（`package.json` 与 `plugin/package.json`
两份一起改）。`test/manifest.test.mjs` 会在 `plugin/` 有改动而版本号未变时
直接报失败，避免忘记。

### 两个前提

1. **需要 pnpm** —— `dsh plugin` 把参数转发给 pnpm。若报
   `'pnpm' 不是内部或外部命令`，说明 dsh 所在的那个 Node 没装 pnpm。
   它不是随 Node 分发的，要单独装：`<node目录>/npm install -g pnpm`。
2. **不带 `--profile` 时**，`dsh web` 与 `dsh --profile web` 等价
   （`bin.js` 会把首个非 `-` 开头的参数补成 profile 名）；
   但 `dsh plugin` 例外，必须显式写 `--profile`。

---

## 跑测试

测试在 `test/`，**不在 `plugin/` 下**，也不随包分发：

```bash
node test/run-all.mjs      # 在本目录执行
```

```
core               172 项    衰减 / 心情 / 抽取 / 召回 / 管线
backend-contract    48 项    存储后端契约
sqlite-embedded     38 项    内嵌引擎 / 持久化 / 损坏自愈
embed-config        83 项    嵌入配置继承 / 断言 / 设置页控件匹配
host-wiring         33 项    真实 cordis + storage + domain 装配
sidebar-panel       34 项    侧栏三处插槽注册（真实执行 apply）
manifest            40 项    两份清单一致 / 版本跟上 / inject 合法
```

`host-wiring` 用的是宿主真实服务而非 mock —— 装配时序问题只有真 cordis 才复现得出。

`sidebar-panel` 是唯一真正执行 `plugin/client.js` 的套件：用 `new Function` 把
浏览器端代码装进沙箱，桩掉 React 与四个宿主 UI 包，让 `apply(ctx)` 真跑一遍，
再检查 `ctx.slots.register` 实际收到的参数。核心那条断言是
「侧栏 `id` === 主面板 `key`」—— 对不上时图标点下去毫无反应，且不报错。

`manifest` 守的是发版纪律：两份 `package.json` 版本必须一致，且 `plugin/`
有改动时版本号必须已经变过。这条规则的由来见上文
「升级：`github:` 装法不会自己跟进新提交」。

---

## 调参

全部参数集中在 `plugin/src/core/config.js`，含义与调参陷阱见
[`plugin/README.md`](plugin/README.md) 第十节。改完先跑数值探针自检：

```bash
python -X utf8 tools/simulate.py
```

`tools/simulate.py` 不参与 CI，它回答的是「这组参数在这套模型里自洽吗」——
四档存活期跨度、稳态层占比、九项结构约束。具体看什么，见
[`plugin/README.md`](plugin/README.md)「改参数的复核清单」。

---

## 记忆图谱

星图面板是**独立的公开库**：[dolou12388/dsh-memory-graph](https://github.com/dolou12388/dsh-memory-graph)。
装上后侧栏多一个「图谱」图标，点开是整库的可交互星图（滚轮缩放、拖背景平移、拖节点改
位置、点星高亮一跳邻居、详情卡列邻居并可继续跳、按档位过滤、适配/重排/刷新）。

本仓库只负责**数据出口**，不负责渲染。两者的分界：

| 归属 | 内容 |
|---|---|
| 本仓库 `plugin/src/graph/` | `rpc.js` 挂通道、`snapshot.js` 把记忆投影成只读快照 |
| graph 那个仓库 | 布局、绘制、交互、视觉编码 |

装法与坑都在那个仓库的 README 里。两条最常踩的照录如下：

1. **profile 里必须有 `@deepseek-ai/dsh-web-app`。** 只有 `dsh-base` 时 `dsh web`
   直接退出码 1，且没有任何能指向病因的报错 —— 面板挂 `sidebar.panellist`，
   没有 web 层就无处可挂，表现成「装好了但看不见」。
2. **启动不要带 `web` 子命令。** profile 自身即应用，`dsh --profile X web` 报
   `too many arguments`；正确是 `dsh --profile X --no-open --port 8791`，
   然后带上终端打印的 `?token=` 访问（裸开根路径 401 是认证在工作）。

数据只从本仓库的 RPC 通道 `/memory-hybrid/graph` 拿，面板不二次读库 —— 因为
`storage-domain` 的 domain 名按 facility 占用，同名二次 `open` 会抛 `already-open`，
直接读 `.sqlite` 更糟（内嵌 wasm 无锁，并发写会烂库）。所以数据只能有一个出口。

通道是自己挂在 `webServer` 上的前缀路由，**不用** `connection.rpc.handle()` ——
后者内部以 connection 服务自身的 ctx 为 owner 调 `owner.webServer.register(...)`，
而那个 ctx 没有 `webServer` 许可，注册错误被内部 try 吞掉，症状是面板恒报 405。
细节与 wire 契约见 [`plugin/src/graph/rpc.js`](plugin/src/graph/rpc.js) 的注释。

**视觉编码的定稿依据来自探针**。在决定要不要做成插件之前，先用这个把半径画什么、
亮度画什么、四类边怎么区分、默认该不该显示 dormant 定下来：

```bash
node tools/make-snapshot.mjs            # 写 tools/snapshot.sample.json（480 节点）
node tools/make-snapshot.mjs --nodes 5000   # 压最坏规模
python -m http.server 8787              # 在 tools/ 下执行，然后开
# http://localhost:8787/graph-lab.html
```

`graph-lab.html` 是单页、无构建、双击即用：同目录有 `force-graph.min.js` 就走本地，
没有才回落 CDN；也可以直接把 json 拖进窗口。

**渲染成星图**：深空底色 + 每簇一团极淡星云，节点是带光晕的星点（叠加混合，越密越亮），
枢纽带十字星芒，孤点画成空心，连线是发丝级的星座线（causal / temporal 选中时才出箭头）。

**布局按主题分簇**：节点按 `tags` 里的 `topic:` 归组，每组一个向日葵排布的锚点，
再加一道向锚点收拢的自定义力；跨主题的边放松到 110，簇内拉紧到 16。
效果是「一眼看出这是几团」，而不是一团均匀的毛球。

**过滤只改可见性，不重排布局**——强度滑杆、档位/类型/关系勾选走的都是
`nodeVisibility` / `linkVisibility`，改了不动力仿真，用户的空间记忆不会被洗掉。

左上角那行自检按**屏幕半径**算：当前缩放下有多少颗星小于 2px（480 节点、适配缩放 0.96
时是 228 颗）。它们点得到（命中按 7 屏幕像素算），但看不清——这是编码选错或缩放太远的
直接证据。窄窗口下侧栏默认收起，点右上角「控制」展开。

数据约定见 [`tools/graph-snapshot.md`](tools/graph-snapshot.md)。探针只消费、不产出，
与 `simulate.py` 同为设计期工具，不进 CI、不随包分发。

### 想在自己的库上先看看效果

库里没记忆时面板会显示空态提示。`tools/seed-store.mjs` 可以把 `make-snapshot.mjs` 的
产物灌进真实存储，只看效果、不涉及逻辑：

```bash
node tools/seed-store.mjs --nodes 420   # 灌 420 节点 / 约 1400 边
node tools/seed-store.mjs --clear       # 用完清掉（务必执行）
node tools/seed-store.mjs --help        # 全部开关
```

⚠ 它写的是 `~/.dsh/storages/memory_hybrid.sqlite`，也就是你**真实的记忆库**，而且第一步
就是 `DELETE`。所以默认不会动手：

- 库里有数据时会**先问一次**，要打完整的 `yes`（回车不算），并列出被覆盖的 3 条记忆原文
  —— 得先看见自己写过什么，才知道这不是沙盒；
- **非交互环境（管道、CI）直接拒绝**，退出码 1，一个字节都不改。要跳过确认只能显式
  `--force`；
- 动手前自动写一份 `memory_hybrid.sqlite.pre-seed.bak`（固定文件名，每次覆盖，不累积），
  回滚就是把它复制回去覆盖原库。`--no-backup` 可关闭；
- 库本来就是空的时候不问 —— 没有可毁的东西。

**清完要重启 dsh** —— 插件在进程内缓存快照，运行期直接改库不会被感知，「刷新」拿回的
还是旧数据。

---

## 零外部依赖是什么意思

`package.json` 里 `dependencies` / `devDependencies` / `peerDependencies` /
`optionalDependencies` / `bundleDependencies` **五个字段全部未声明**。

不只是「没写进依赖列表」，而是 SQLite 引擎本身随包分发：
`vendor/sqlite/sql-wasm.wasm`（659,806 字节）经 `wasmBinary` 直传加载，
不查文件系统、不联网、不看用户装的是哪个 Node 版本。

隔离验证（决定性）：`npm pack` 后在空目录 `npm install <tgz>`，
输出 `added 1 package` —— 只有插件自身。

---

## 许可

MIT。`vendor/sqlite/` 下的 sql.js 产物同为 MIT，许可证随附。

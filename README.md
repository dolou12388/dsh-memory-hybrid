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
dsh-memory/
├── plugin/                    插件包（可 npm pack 分发）
│   ├── src/                   16 个模块，4,314 行
│   ├── client.js              浏览器端：设置页 tab + 侧栏面板（1,024 行）
│   ├── vendor/sqlite/         内嵌 SQLite wasm 引擎（零外部依赖的关键）
│   ├── cordis.patch.yml       bundle 补丁，声明插件默认配置
│   ├── package.json           dsh.bundle.patch 指向上面那个 yml
│   └── README.md              安装 / 设计 / 调参 / 排查，都在这
├── test/                      7 个套件，436 项（不随 npm 包分发）
└── tools/
    └── simulate.py            设计期数值探针（不是测试）
```

---

## 该读哪份

| 你想做的事 | 读这里 |
|---|---|
| **装上并跑起来** | [`plugin/README.md`](plugin/README.md) 第五节「装配」 |
| **改配置** | 侧边栏「记忆」图标，或 设置 → 插件 → 记忆（同一份配置，两个入口） |
| 理解衰减/唤醒/心情为什么这样设计 | [`plugin/README.md`](plugin/README.md) 第二~四节 |
| 改参数，看会影响什么 | [`plugin/README.md`](plugin/README.md) 第十节「调参」 |
| 排查故障 | [`plugin/README.md`](plugin/README.md) 第九节「已知限制」+ 第十一节「验证」 |
| 改代码，确认没改坏 | `test/` |

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
sidebar-panel       27 项    侧栏三处插槽注册（真实执行 apply）
manifest            35 项    两份清单一致 / 版本是否跟上源码改动
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

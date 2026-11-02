# dsh-memory-graph

把 `dsh-memory-hybrid` 的记忆画成一张可交互的星图 —— 侧栏多一个「图谱」面板。

```
         ·        ✦        ·
      ·     ╭──────────╮      ·
    ✦       │  记忆簇   │        ✦
         ·  ╰──────────╯   ·
      ·        ✦       ·      ·
```

## 依赖

**必须先装 `dsh-memory-hybrid` ≥ 0.3.0。** 数据不是本包自己读库拿的，而是调核心
插件的 Connection RPC 通道（`/memory-hybrid` → endpoint `graph`）。核心不在时面板
会明确说「取不到数据」，而不是空着。

为什么不在本包里再读一次库：`storage-domain` 的 domain 名按 facility 占用，同名二次
`open` 会抛 `already-open`；自建 facility 只会拿到一份与核心各说各话的内存副本；
直接读 `.sqlite` 更糟（内嵌 wasm 无锁，并发写会烂库）。所以数据只能有一个出口。

## 安装

```bash
# 与核心同仓库，用 link 装（改代码即时生效）
dsh plugin --profile <你的 profile> add "link:<本仓库>/graph"

# 确认层已登记
dsh --profile <你的 profile> --dump-config | grep memory-graph
```

装完重启 dsh，侧栏会出现「图谱」图标。

### ⚠ 本包是 Web UI 层，profile 里必须有 `@deepseek-ai/dsh-web-app`

只装 `dsh-base` 的 profile 跑 `dsh web` 会直接退出码 1，且不打印任何有的错误 ——
它会先加载 185 个配置条目、把包都列为 loaded，然后在没有 web 宿主的情况下收尾。
本面板挂在 `slot("sidebar.panellist")` 上，没有 web 层就无处可挂，表现成「装好了但看不见」。

```jsonc
// ~/.dsh/profiles/<name>/package.json
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",   // ← 缺这行，图谱面板永远不会出现
      "dsh-memory-graph",
      "dsh-memory-hybrid"
    ]
  }
}
```

### ⚠ 启动命令不要带 `web`

profile 自身即应用，`dsh --profile <name> web` 会报
`too many arguments. Expected 0 arguments but got 1: web.`。正确写法：

```bash
dsh --profile graphdev --no-open --port 8791
# 终端会打印 http://localhost:8791/?token=xxxx —— 那个 token 必须带上，
# 直接开根路径是 401，这是认证在工作，不是故障。
```

## 交互

| 操作 | 效果 |
|---|---|
| 滚轮 | 以光标为中心缩放 |
| 拖背景 | 平移 |
| 拖节点 | 移动单颗星（松手后回到力体系） |
| 点星 | 高亮它的一跳邻居，其余压到 7% |
| 点详情卡里的邻居 | 跳到那颗星（视角平移过去并改选中） |
| 点空白 / Esc | 取消选中 |
| 顶部 chip | 按档位过滤（在册 / 长期 / 沉睡） |
| 适配 / 重排 / 刷新 | 重新取景 / 重跑布局 / 重新拉数据 |

## 编码

| 视觉 | 含义 |
|---|---|
| 大小 | `importance × R`（强度）：多重 × 还记不记得 |
| 明暗 | 档位；dormant 压到 30% 并转冷灰 |
| 颜色 | 类型：情节（紫）/ 语义（青）/ 程序（琥珀）/ 偏好（粉） |
| 十字星芒 | 枢纽（度数前 5%） |
| 空心圈 | 孤点（没有任何连接） |
| 线色 / 线型 | 关系：相关（灰实）/ 因果（蓝实）/ 时序（琥珀虚）/ 冲突（红虚） |
| 线宽 | 建边时的相似度权重 |

## 为什么单独成包

- 渲染代码量比核心全部 UI 加起来还大，且要反复改视觉；放进核心等于让每次配色调整
  都触发核心发版。
- 核心的「零外部依赖、单包安装」是它的卖点，不该被一个可选视图拖累。
- 面板崩了不该连带记忆功能 —— 本项目的既有原则是旁路设施只能降级。

## 实现要点

- **不引第三方图库**：布局与绘制自己写。理由是包要能 `link:` 装、不能有构建步骤，
  而通用图库的浏览器产物要么几百 KB、要么需要打包器。
- **布局是简化的三力模型**：网格加速的簇内相斥 + 边弹簧 + 向主题锚点收拢，
  固定 tick 数跑完即冻结。记忆集在两次写入之间是静止的，不需要 60fps。
- **可测**：`normalize` / `buildLayout` / `settle` 都是纯函数，经 `__internals` 导出，
  由 `test/graph-panel.test.mjs` 在 node 里断言（含「组内距离 < 组间 0.7 倍」这条
  分簇是否成立的判据）。

### 通道不走 `connection.rpc.handle()`（上游缺陷绕行）

原本按文档用 `ctx.connection.rpc.handle({ channel, endpoints })` 注册，结果面板恒定显示
`HTTP 405`。定位结论：该 API 内部以 **connection 服务自身的 ctx** 为 owner 调
`owner.webServer.register(...)`，而那个 ctx 上没有 `webServer` 许可，于是每次注册都抛
`cannot get property "webServer" without inject` —— 被内部 try 吃掉，路由静默没挂上，
请求最后落到静态前端兜底（只收 GET/HEAD，其余一律 405）。

改法：核心插件里 `ctx.inject(["webServer"], (child) => …)`，自己挂一条 `kind: "prefix"`
路由，并手写信封协议（见 `plugin/src/graph/rpc.js`）：

```
POST /memory-hybrid/graph      content-type: application/json
→ { "type": "client-request", "rpcId": "…", "method": "graph", "payload": {} }
← { "type": "server-response", "rpcId": "…", "result": { "ok": true, "value": { … } } }
```

`method` 必须等于 endpoint 段名，否则回 `gateway/bad-request` 信封；非 POST → 405 +
`allow: POST`，非 JSON → 415，坏体 → 400。`test/graph-snapshot.test.mjs` 用假
`webServer.register` + 最小 req/res 桩覆盖了这套分支。

### 两处 `inject` 是硬要求，缺一个面板就整块消失

Cordis 的属性访问是白名单式的，`ctx.<prop>` 未在 `inject` 里声明就抛
`cannot get property "X" without inject`，而 **apply 抛错会让整个 entry 判 failed**，
浏览器半随之不加载。

- 宿主半 `src/index.js`：`export const inject = []`，且**不要写 `ctx.logger`**。
- 浏览器半 `client.js`：`export const inject = ["slots", "locale", "connection"]`。
- `package.json` 的 `dsh.client.inject` 还要列 UI 依赖包（primitives / slots / locale），
  那是模块加载顺序，和服务注入是两回事，两边都得写。

## 已知限制

- 布局在 500 节点上实测收敛 < 1.5 s；数千节点未实测，规模上来后应改用坐标缓存
  （快照约定 §6 已为此留了 `x` / `y` 字段）。
- 目前每次打开面板都重算布局，同一批数据的图形虽然可复现（初值由 id 哈希决定），
  但没做跨会话缓存。
- 没有搜索框。邻居列表跳转已实现（详情卡底部「直接邻居」按权重降序，点击即把视角
  平移过去并改选中）；搜索仍在 `tools/graph-lab.html` 里，尚未搬进来。
- **`rev` 只在取数时推进，不感知外部清库**。插件在进程内缓存快照，如果在 dsh 运行期间
  直接改 `.sqlite`（例如 `node tools/seed-store.mjs --clear`），面板点「刷新」仍会拿回
  旧数据 —— 必须重启 dsh。这不是 bug，是「数据只有一个出口」的代价。
- 档位 chip 是带 `onClick` 的 `<span>`，不是 `<button>`；自动化测试/无障碍工具按
  DOM 语义抓不到它们，只能按坐标点。

# 记忆图谱快照 · 数据约定

**schema id**：`dsh-memory-graph/1`
**生产方**：核心插件 `dsh-memory-hybrid`（唯一写者）
**消费方**：图谱面板、Obsidian 导出、CLI / 外部工具（一律只读）

这份约定存在的唯一理由，是让可视化不必长在核心插件里。
`tools/graph-lab.html` 就是它的第一个消费者 —— 先按它渲染假数据，把视觉编码定下来，
再谈谁来实现。

---

## 1. 为什么不直接读库

`storage-domain` 的 domain 名按 facility 占用，同名二次 `open` 抛 `already-open`；
表是内存 `records` 映射，写入经 host 落盘。因此外部插件「直接读实时库」有两条死路：

| 做法 | 后果 |
|---|---|
| 用 profile 的 facility 再 open 一次 `memory_hybrid` | 抛 `already-open`，拿不到 |
| 自建 facility 打开同一个 domain | 得到一份独立内存副本，与核心插件的视图各说各话 |
| 绕过 domain 直接读 `.sqlite` 文件 | 内嵌 wasm 无锁，两个实例并发写会烂库 |

结论：**可视化必须消费核心给出的只读投影**，不能共享存储。

---

## 2. 顶层结构

```json
{
  "schema": "dsh-memory-graph/1",
  "rev": 128,
  "generatedAt": 1793588149939,
  "source": "memory_hybrid.sqlite",
  "stats": {
    "memories": 480,
    "edges": 1610,
    "byTier": { "active": 88, "long": 159, "dormant": 233 },
    "byKind": { "episodic": 151, "semantic": 188, "procedural": 85, "preference": 56 },
    "byRel":  { "related": 1166, "causal": 284, "temporal": 90, "contradicts": 70 },
    "avgDegree": 6.71,
    "isolated": 35
  },
  "nodes": [],
  "edges": []
}
```

| 字段 | 说明 |
|---|---|
| `rev` | 单调递增。消费方靠它判断要不要重绘，不要用 `generatedAt` 比时间——时钟会跳 |
| `stats` | 供 UI 显示计数与默认过滤。**必须与 `nodes`/`edges` 自洽**，不一致时以数组为准 |
| `source` | 调试用，人类可读即可，不参与逻辑 |

---

## 3. 节点

```json
{
  "id": "m_0000",
  "text": "改参数之前先跑一遍 simulate.py，否则约束对不上",
  "kind": "procedural",
  "tier": "long",
  "importance": 0.4,
  "stability": 61.048,
  "retention": 0.6458,
  "weight": 0.2583,
  "recallCount": 3,
  "createdAt": 1762935126135,
  "lastRecallAt": 1784362326135,
  "lastDecayAt": 1784362326135,
  "forgotAt": 1785000000000,
  "tags": ["topic:前端"],
  "degree": 27
}
```

| 字段 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `id` | string | 必有 | 主键 |
| `text` | string | `""` | 展示用。**核心负责截断到 200 字符**，不要把整段对话塞进来 |
| `kind` | enum | `semantic` | `episodic` / `semantic` / `procedural` / `preference` |
| `tier` | enum | `active` | `active` / `long` / `dormant` |
| `importance` | 0–1 | `0.4` | 内容属性，写入即固定 |
| `stability` | 天 | `3.0` | 稳定度 S |
| `retention` | 0–1 | `1.0` | 当前可召回度 R，由核心按真公式算 |
| `weight` | 0–1 | `importance × retention` | 展示权重，**仅用于视觉排序** |
| `recallCount` | int | `0` | 累计召回次数 |
| `createdAt` / `lastRecallAt` / `lastDecayAt` / `forgotAt` | epoch ms | — | `forgotAt` 仅 dormant 有 |
| `tags` | string[] | `[]` | 自由标签；`topic:` 前缀用于分簇（见硬规则 4） |
| `degree` | int | `0` | 出度+入度。核心算好，别让每个消费方各算一遍 |
| `x` / `y` | number | 无 | **可选**。核心缓存的布局坐标，见 §6 |

### 四条硬规则

1. **`retention` / `weight` 由核心算。** 消费方不许自己用 `stability` 和当前时间重算 ——
   那会把 `LAMBDA_LONG`、锚点选择（`lastDecayAt ?? lastRecallAt ?? createdAt`）这些
   细节复制一份，两处口径迟早漂移。
2. **`tier` 是权威值**，不是从 `retention` 反推的。`long` 的低 R 与 `active` 的低 R
   语义不同（前者只是变慢，后者是濒临遗忘）。
3. **`degree` 按全部边算**，不按过滤后的子图算。子图度数会让「枢纽」随过滤条件变化，
   视觉上很迷惑。
4. **`tags` 里的 `topic:` 前缀就是分簇键。** 可视化按它把节点归组、给每组一个布局锚点；
   核心若不写 `topic:`，整张图会退化成一个均匀的团块 —— 这是「看得见结构」和
   「只看得见点」的差别。没有主题概念的实现可以不写，但要知道代价。

---

## 4. 边

```json
{ "id": "e_00042", "from": "m_0012", "to": "m_0301", "rel": "causal", "weight": 0.3812 }
```

| 字段 | 说明 |
|---|---|
| `rel` | `related` / `causal` / `temporal` / `contradicts`。缺省 `related` |
| `weight` | 0–1，来自建边时的向量相似度 |

`from`/`to` 一律是 `id` 字符串，**不要输出对象引用** —— 序列化和增量传输都会出问题。

---

## 5. 消费方必须容忍的事

- **未知字段**：一律忽略，不要因为多了一个字段就整条丢弃。
- **缺字段**：按 §3 的缺省值补，不要抛错。
- **`stats` 与数组不一致**：以数组为准，`stats` 只是加速显示。
- **`edges` 里有悬空引用**（指向已删除节点）：过滤掉，不要崩。
- **`rev` 回退**：说明换了库或清了库，按全量重绘处理。

---

## 6. 布局坐标缓存在哪

布局（力导向收敛）是纯计算，不该每次打开都重跑。约定：

- 核心**可以**在 `x`/`y` 里带上上次收敛的位置；消费方有就用、没有就跑一遍。
- 缓存失效判据是 `rev` 变化幅度：新增节点数超过 20% 时建议丢弃缓存重跑，
  少量新增则保留其余节点位置、只给新节点随机初值 —— 否则每加一条记忆，
  整张图就重新洗牌一次，用户的空间记忆全废。
- 坐标是**无量纲的图空间**，消费方自行做缩放适配，不要持久化视口参数。

---

## 7. 未来可能的分页参数

`graph_snapshot({ tier, since, limit })`：

| 参数 | 语义 |
|---|---|
| `tier` | 只返回指定档位 |
| `since` | 只返回 `createdAt >= since` 的节点（及其内部边） |
| `limit` | 按 `weight` 取前 N |

分页时 `stats` 仍报**全库**计数，`rev` 仍是全库版本号 —— 否则消费方无法判断
「是数据变了」还是「只是过滤条件变了」。

---

## 8. 与真实库的差距

`tools/snapshot.sample.json` 由 `tools/make-snapshot.mjs` 生成，用的就是
`plugin/src/core` 里的真函数（`LEVELS` / `retention` / `grow` / `settle`），
但仍是模拟数据。已知差异：

| 项 | 样本 | 真实库 |
|---|---|---|
| 年龄分布 | 偏向近期（`pow(rng, 1.8)`） | 与实际写入节奏相关 |
| dormant 占比 | 48%（`--recall 1`） | 低召回老年库可达 97% |
| 边 | 同主题优先 + 偏好依附合成 | 向量相似度 + 词法二次确认 |
| 孤立点 | 8% 固定 | 取决于每批次的邻居密度 |

这些差异不影响「编码读不读得懂」的判断，但**不要拿样本的档位比例去反推生产环境**。

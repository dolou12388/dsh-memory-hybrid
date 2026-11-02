/**
 * dsh-memory-graph —— 浏览器半（侧栏面板）。
 *
 * 数据来自 dsh-memory-hybrid 的 Connection RPC：`/memory-hybrid` → `graph`。
 * 这一半不依赖任何第三方渲染库：布局与绘制自己做，理由有三条 ——
 *
 *   1. 这个包要能 `link:` 装、`github:` 装、也能直接拷进 profile，不能引入构建步骤；
 *      3D/图库的浏览器产物要么几百 KB、要么需要打包器改写。
 *   2. 记忆图谱的编码是专属的（强度→大小、档位→明暗、关系→线型、枢纽→星芒），
 *      通用图库的抽象大多反着来，硬套比自写更别扭。
 *   3. 自写才能把「布局 + 命中 + 编码」做成纯函数，在没有浏览器的环境里测。
 *
 * 模块格式与核心插件一致：window.__ModuleLoader__ 的惰性 CJS 形态。
 */

window.__ModuleLoader__.load({
  id: "dsh-memory-graph",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require("react");
    const h = React.createElement;

    /** 侧栏面板 id；必须与 main 槽的 key 相同，否则点图标没反应且不报错。 */
    const PANEL_ID = "memory-graph";
    /** 与 BFF 通道同名，仅作日志标识。 */
    const NS = "dsh-memory-graph";
    /** 跨包契约：核心插件的 RPC 通道（见 plugin/src/graph/rpc.js）。 */
    const CHANNEL = "/memory-hybrid";
    const CLIENT_VERSION = "0.2.1";

    const KIND = {
      episodic:   { color: "#9B8CFF", label: "情节" },
      semantic:   { color: "#58E3C0", label: "语义" },
      procedural: { color: "#FFB75E", label: "程序" },
      preference: { color: "#FF8FBE", label: "偏好" },
    };
    const REL = {
      related:     { color: "#6E86AE", dash: null,   alpha: 0.20, label: "相关" },
      causal:      { color: "#5FA8FF", dash: null,   alpha: 0.42, label: "因果" },
      temporal:    { color: "#D9A066", dash: [3, 3], alpha: 0.42, label: "时序" },
      contradicts: { color: "#FF6B6B", dash: [5, 3], alpha: 0.85, label: "冲突" },
    };
    const TIER = {
      active:  { color: "#7CF0C8", label: "在册" },
      long:    { color: "#6FB1FF", label: "长期" },
      dormant: { color: "#7C8AA8", label: "沉睡" },
    };

    const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
    const fmtDate = (ms) => {
      if (!ms) return "—";
      const d = new Date(ms);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };

    /* ================================================================== *
     * 1. 数据规整（纯函数，可测）
     * ================================================================== *
     * 约定 §5：缺字段补缺省、悬空边过滤、计数以数组为准。
     * 一条悬空边就足以让渲染在某一帧抛错，整张图白屏 —— 所以先洗一遍再画。
     */
    function normalize(raw) {
      const src = raw && typeof raw === "object" ? raw : {};
      const nodes = (Array.isArray(src.nodes) ? src.nodes : [])
        .filter((n) => n && n.id != null)
        .map((n) => {
          const importance = Number.isFinite(n.importance) ? n.importance : 0.4;
          const retention = Number.isFinite(n.retention) ? n.retention : 1;
          const tags = Array.isArray(n.tags) ? n.tags.filter((t) => typeof t === "string") : [];
          return {
            id: String(n.id),
            text: typeof n.text === "string" ? n.text : "",
            kind: n.kind || "semantic",
            tier: n.tier || "active",
            importance,
            retention,
            weight: Number.isFinite(n.weight) ? n.weight : importance * retention,
            stability: Number.isFinite(n.stability) ? n.stability : 0,
            recallCount: Number.isFinite(n.recallCount) ? n.recallCount : 0,
            createdAt: n.createdAt,
            lastRecallAt: n.lastRecallAt,
            forgotAt: n.forgotAt,
            tags,
            degree: Number.isFinite(n.degree) ? n.degree : 0,
            group: (tags.find((t) => t.startsWith("topic:")) ?? tags[0] ?? "").replace(/^topic:/, "") || null,
          };
        });

      const ids = new Set(nodes.map((n) => n.id));
      const edges = (Array.isArray(src.edges) ? src.edges : [])
        .filter((e) => e && ids.has(String(e.from)) && ids.has(String(e.to)) && String(e.from) !== String(e.to))
        .map((e) => ({
          id: String(e.id ?? `${e.from}->${e.to}`),
          from: String(e.from),
          to: String(e.to),
          rel: REL[e.rel] ? e.rel : "related",
          weight: clamp01(Number.isFinite(e.weight) ? e.weight : 0.2),
        }));

      return {
        rev: Number.isFinite(src.rev) ? src.rev : 0,
        nodes,
        edges,
        stats: src.stats || {},
      };
    }

    /**
     * 取某颗星的直接邻居，按边权降序。
     *
     * 排序不是装饰：枢纽节点能挂几十个邻居，详情卡一次只显示得下前几个，
     * 按插入顺序排等于随机 —— 用户最该先看的那条（因果、冲突）反而可能垫底。
     *
     * 邻接表里两端都写了一份（A→B 与 B→A），所以不必再判断方向。
     * 邻居节点查不到时 `node` 为 undefined，调用方按 id 兜底显示。
     *
     * @param {{adj: Map, byId: Map}} model
     * @param {{id: string}|null} node
     * @returns {Array<{id: string, rel: string, node: object|undefined}>}
     */
    function neighborsOf(model, node) {
      if (!node || !model?.adj) return [];
      return (model.adj.get(node.id) || [])
        .slice()
        .sort((a, b) => (b.weight || 0) - (a.weight || 0))
        .map((a) => ({ id: a.id, rel: a.rel || "related", node: model.byId.get(a.id) }));
    }

    /* ================================================================== *
     * 2. 布局（纯函数，可测）
     * ================================================================== *
     * 目标是「一眼看出这是几团」，不是最优图绘制。三股力足够：
     *   簇内相斥（网格加速） + 边做弹簧 + 向主题锚点收拢。
     * 全部跑在固定的 tick 数里，跑完即冻结 —— 记忆集在两次写入之间是静止的，
     * 不需要持续动画，也就不需要为 60fps 优化。
     */
    const CELL = 46;

    function hashSeed(str) {
      let h = 2166136261;
      for (let i = 0; i < str.length; i += 1) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return h >>> 0;
    }

    function buildLayout(nodes, edges) {
      // ---- 主题锚点：向日葵排布，按簇大小分配半径 ----
      const counts = new Map();
      for (const n of nodes) if (n.group) counts.set(n.group, (counts.get(n.group) || 0) + 1);
      const names = [...counts.keys()];
      const R = 12 * Math.sqrt(Math.max(1, nodes.length)) + 40;
      const anchors = new Map();
      names.forEach((name, i) => {
        const rr = R * Math.sqrt((i + 0.5) / Math.max(1, names.length));
        const th = i * 2.39996;
        anchors.set(name, { x: rr * Math.cos(th), y: rr * Math.sin(th) });
      });

      // ---- 初值：锚点附近抖动。用 id 的哈希做种子，重开面板图形不变。 ----
      for (const n of nodes) {
        const a = n.group ? anchors.get(n.group) : null;
        const seed = hashSeed(n.id);
        const jx = ((seed & 0xffff) / 0xffff - 0.5) * 34;
        const jy = (((seed >>> 16) & 0xffff) / 0xffff - 0.5) * 34;
        n.x = (a ? a.x : 0) + jx;
        n.y = (a ? a.y : 0) + jy;
        n.vx = 0;
        n.vy = 0;
        n.pinned = false;
      }

      // 边提前解析成对象引用，省掉每 tick 的查表
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const links = [];
      for (const e of edges) {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        if (a && b) links.push({ a, b, w: e.weight, e });
      }

      return { anchors, links, alpha: 1 };
    }

    function tickLayout(nodes, layout) {
      const { anchors, links } = layout;
      const alpha = layout.alpha;

      // ---- 相斥：均匀网格，每格只看 3×3 ----
      const grid = new Map();
      for (const p of nodes) {
        const key = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`;
        let bucket = grid.get(key);
        if (!bucket) { bucket = []; grid.set(key, bucket); }
        bucket.push(p);
      }
      const cell2 = CELL * CELL;
      for (const p of nodes) {
        const cx = Math.floor(p.x / CELL);
        const cy = Math.floor(p.y / CELL);
        for (let dx = -1; dx <= 1; dx += 1) {
          for (let dy = -1; dy <= 1; dy += 1) {
            const bucket = grid.get(`${cx + dx},${cy + dy}`);
            if (!bucket) continue;
            for (const q of bucket) {
              if (q === p) continue;
              let ddx = p.x - q.x;
              let ddy = p.y - q.y;
              let d2 = ddx * ddx + ddy * ddy;
              if (d2 < 1e-4) { ddx = (p.id > q.id ? 0.7 : -0.7); ddy = 0.7; d2 = 1; }
              if (d2 > cell2) continue;
              const f = (cell2 / d2) * 0.0035 * alpha;
              p.vx += ddx * f;
              p.vy += ddy * f;
            }
          }
        }
      }

      // ---- 边：弹簧，权重越大越短 ----
      for (const l of links) {
        const dx = l.b.x - l.a.x;
        const dy = l.b.y - l.a.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const rest = 24 + 26 * (1 - l.w);
        const f = (d - rest) * 0.012 * alpha;
        const ux = (dx / d) * f;
        const uy = (dy / d) * f;
        l.a.vx += ux; l.a.vy += uy;
        l.b.vx -= ux; l.b.vy -= uy;
      }

      // ---- 锚点：簇内收拢，未分组的轻微向心 ----
      for (const p of nodes) {
        if (p.pinned) { p.vx = 0; p.vy = 0; continue; }
        const a = p.group ? anchors.get(p.group) : null;
        const k = (a ? 0.045 : 0.012) * alpha;
        p.vx += ((a ? a.x : 0) - p.x) * k;
        p.vy += ((a ? a.y : 0) - p.y) * k;
      }

      // ---- 积分 ----
      for (const p of nodes) {
        if (p.pinned) continue;
        p.vx *= 0.86;
        p.vy *= 0.86;
        p.x += p.vx;
        p.y += p.vy;
      }

      layout.alpha = alpha * 0.965;
    }

    /** 跑到底（或到 tick 上限）。规模越大给的 tick 越少，保证打开面板不卡。 */
    function settle(nodes, layout, maxTicks) {
      const limit = maxTicks ?? Math.min(320, Math.max(80, Math.round(60000 / Math.max(1, nodes.length)) + 60));
      let t = 0;
      while (layout.alpha > 0.02 && t < limit) {
        tickLayout(nodes, layout);
        t += 1;
      }
      return t;
    }

    /** 包住所有节点的包围盒，供取景使用。 */
    function boundsOf(nodes, pad = 40) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of nodes) {
        if (!Number.isFinite(n.x)) continue;
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
      }
      if (!Number.isFinite(minX)) return null;
      return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
    }

    /* ================================================================== *
     * 3. 绘制
     * ================================================================== */

    const SPRITE = 96;
    const spriteCache = new Map();
    function starSprite(color) {
      const hit = spriteCache.get(color);
      if (hit) return hit;
      const c = document.createElement("canvas");
      c.width = c.height = SPRITE;
      const g = c.getContext("2d");
      const m = SPRITE / 2;
      const grad = g.createRadialGradient(m, m, 0, m, m, m);
      grad.addColorStop(0.00, hexA(color, 0.95));
      grad.addColorStop(0.18, hexA(color, 0.55));
      grad.addColorStop(0.42, hexA(color, 0.16));
      grad.addColorStop(1.00, hexA(color, 0));
      g.fillStyle = grad;
      g.fillRect(0, 0, SPRITE, SPRITE);
      spriteCache.set(color, c);
      return c;
    }

    function hexA(hex, a) {
      const n = parseInt(hex.slice(1), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    }

    /** 星核往白偏但留住色相：纯白会把四种类型抹平。 */
    function coreColor(hex) {
      const n = parseInt(hex.slice(1), 16);
      const mix = (v) => Math.round(v + (255 - v) * 0.45);
      return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
    }

    /**
     * 建渲染器。返回的对象是面板唯一的交互面 —— React 那边只管挂载与销毁。
     */
    function createRenderer(host, options) {
      const canvas = document.createElement("canvas");
      canvas.style.display = "block";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.cursor = "default";
      host.appendChild(canvas);
      const ctx = canvas.getContext("2d");

      const view = { k: 1, x: 0, y: 0, w: 1, h: 1, dpr: 1 };
      let model = { nodes: [], edges: [], layout: null, byId: new Map(), adj: new Map() };
      let filters = { tiers: new Set(["active", "long", "dormant"]), minWeight: 0.3 };
      let selected = null;
      let hovered = null;
      let neighbor = new Set();
      let dragging = null;
      let panning = null;
      let moved = false;
      let raf = 0;
      let hubDegree = 8;
      /**
       * 用户是否自己动过视图。
       *
       * 一旦滚轮缩放过、或拖动过背景，首屏自动取景就不再插手 ——
       * 否则换一次数据、或挂一次 ResizeObserver，视图会被拉回默认位置，
       * 手调的观察角度没了。
       */
      let userMovedView = false;

      const notify = options?.onSelect || (() => {});

      function resize() {
        const rect = host.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        view.w = Math.max(1, Math.round(rect.width));
        view.h = Math.max(1, Math.round(rect.height));
        view.dpr = dpr;
        canvas.width = Math.round(view.w * dpr);
        canvas.height = Math.round(view.h * dpr);
        draw();
      }

      function toWorld(sx, sy) {
        return { x: (sx - view.w / 2) / view.k + view.x, y: (sy - view.h / 2) / view.k + view.y };
      }

      function fit() {
        const b = boundsOf(model.nodes.filter(visible));
        if (!b) return;
        // 两个方向各自算一次可用比例，取小的那个 —— 这样整张图一定装得进容器。
        // 只用一条公式会让长边方向溢出、短边方向大片留白（宽屏面板里表现为
        // 图挤在左侧、右边空一大块）。
        const spanX = Math.max(1, b.maxX - b.minX);
        const spanY = Math.max(1, b.maxY - b.minY);
        const k = Math.min(view.w / spanX, view.h / spanY);
        view.k = Math.max(0.05, Math.min(6, k * 0.92));
        view.x = (b.minX + b.maxX) / 2;
        view.y = (b.minY + b.maxY) / 2;
        // 显式「适配」等于接受自动取景，把主动权交回给后续的自动重取景。
        userMovedView = false;
        draw();
      }

      function visible(n) {
        return filters.tiers.has(n.tier);
      }

      function edgeVisible(e) {
        const a = model.byId.get(e.from);
        const b = model.byId.get(e.to);
        if (!a || !b || !visible(a) || !visible(b)) return false;
        if (selected && (e.from === selected.id || e.to === selected.id)) return true;
        return e.weight >= filters.minWeight;
      }

      /** 半径：世界单位。数值小，因为外面还套着光晕，且是叠加混合。 */
      function radiusOf(n) {
        return 1.4 + 5.6 * Math.sqrt(Math.max(0, n.weight || 0));
      }

      function alphaOf(n) {
        return n.tier === "dormant" ? 0.3 : 1;
      }

      function colorOf(n) {
        if (n.tier === "dormant") return TIER.dormant.color;
        return (KIND[n.kind] || {}).color || "#8FA3C4";
      }

      function draw() {
        if (!ctx) return;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        raf = requestAnimationFrame(paint);
      }

      function paint() {
        raf = 0;
        const { dpr, w, h, k } = view;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "#080b12";
        ctx.fillRect(0, 0, w, h);

        // 视差底色：一点极淡的径向光，避免整块死黑
        const bg = ctx.createRadialGradient(w * 0.5, h * 0.45, 0, w * 0.5, h * 0.45, Math.max(w, h) * 0.7);
        bg.addColorStop(0, "rgba(70,100,170,0.10)");
        bg.addColorStop(1, "rgba(6,9,16,0)");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, h);

        ctx.save();
        ctx.translate(w / 2, h / 2);
        ctx.scale(k, k);
        ctx.translate(-view.x, -view.y);

        // ---- 连线 ----
        for (const e of model.edges) {
          if (!edgeVisible(e)) continue;
          const a = model.byId.get(e.from);
          const b = model.byId.get(e.to);
          const rel = REL[e.rel] || REL.related;
          const touched = selected && (e.from === selected.id || e.to === selected.id);
          let alpha = rel.alpha * (0.45 + 1.5 * e.weight);
          if (a.tier === "dormant") alpha *= 0.35;
          if (b.tier === "dormant") alpha *= 0.35;
          if (selected) alpha = touched ? 0.95 : alpha * 0.07;
          ctx.strokeStyle = hexA(rel.color, Math.min(1, alpha));
          ctx.lineWidth = (touched ? 1.6 : 0.7) / k;
          if (rel.dash) ctx.setLineDash(rel.dash.map((d) => d / k));
          else ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
        ctx.setLineDash([]);

        // ---- 星点 ----
        for (const n of model.nodes) {
          if (!visible(n)) continue;
          const focus = selected ? (n === selected ? 2 : neighbor.has(n.id) ? 1 : 0) : -1;
          const dim = focus === 0 && n !== hovered;
          const a = dim ? 0.07 : focus > 0 || n === hovered ? 1 : alphaOf(n);
          const color = n === hovered || focus > 0 ? (KIND[n.kind] || {}).color || colorOf(n) : colorOf(n);
          const r = Math.max(radiusOf(n), 1.1 / k);

          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          ctx.globalAlpha = a * 0.55;
          const reach = r * (n === selected ? 4.6 : 3.2);
          ctx.drawImage(starSprite(color), n.x - reach, n.y - reach, reach * 2, reach * 2);
          ctx.restore();

          ctx.save();
          ctx.globalAlpha = a;
          ctx.beginPath();
          ctx.arc(n.x, n.y, Math.max(1.1 / k, r * 0.45), 0, Math.PI * 2);
          ctx.fillStyle = coreColor(color);
          ctx.fill();
          if ((n.degree || 0) === 0) {
            // 孤点画空心：没有任何连接这件事本身就是信息
            ctx.beginPath();
            ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
            ctx.strokeStyle = coreColor(color);
            ctx.lineWidth = 1 / k;
            ctx.stroke();
          }
          if (n === selected || n === hovered) {
            ctx.beginPath();
            ctx.arc(n.x, n.y, r + 4 / k, 0, Math.PI * 2);
            ctx.strokeStyle = "rgba(214,232,255,0.9)";
            ctx.lineWidth = 1 / k;
            ctx.stroke();
          }
          ctx.restore();
        }
        ctx.restore();

        // ---- 标签（屏幕空间，字号恒定）----
        drawLabels();
      }

      function drawLabels() {
        const { dpr, w, h, k } = view;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const placed = [];
        const tryPlace = (x0, y0, x1, y1) => {
          for (const p of placed) if (x0 < p[2] && x1 > p[0] && y0 < p[3] && y1 > p[1]) return false;
          placed.push([x0, y0, x1, y1]);
          return true;
        };
        const toScreen = (n) => ({ x: (n.x - view.x) * k + w / 2, y: (n.y - view.y) * k + h / 2 });

        ctx.font = '11px system-ui, "Microsoft YaHei", sans-serif';
        ctx.textBaseline = "middle";

        const drawOne = (n, strong) => {
          if (!n || !n.text) return;
          const p = toScreen(n);
          if (p.x < -50 || p.x > w + 50 || p.y < -20 || p.y > h + 20) return;
          const text = n.text.length > 18 ? n.text.slice(0, 17) + "…" : n.text;
          const width = ctx.measureText(text).width;
          const gap = radiusOf(n) * k + 6;
          const x = p.x + gap + width > w - 4 ? p.x - gap - width : p.x + gap;
          if (!tryPlace(x - 2, p.y - 8, x + width + 2, p.y + 8)) return;
          ctx.strokeStyle = "rgba(6,9,14,0.85)";
          ctx.lineWidth = 3;
          ctx.strokeText(text, x, p.y);
          ctx.fillStyle = strong ? "#eaf2ff" : "#b9c8de";
          ctx.fillText(text, x, p.y);
        };

        // 层级：选中 > 悬停 > 枢纽 > 其余
        if (selected) drawOne(selected, true);
        if (hovered && hovered !== selected) drawOne(hovered, true);
        let budget = 8;
        const pool = [...model.nodes]
          .filter((n) => visible(n) && (n.degree || 0) >= hubDegree)
          .sort((a, b) => b.degree - a.degree);
        for (const n of pool) {
          if (budget <= 0) break;
          if (n === selected || n === hovered) continue;
          drawOne(n, false);
          budget -= 1;
        }
      }

      /* ---------------- 交互 ---------------- */

      function hitTest(sx, sy) {
        const p = toWorld(sx, sy);
        const limit = 12 / view.k;
        let best = null;
        let bestD = Infinity;
        for (const n of model.nodes) {
          if (!visible(n) || !Number.isFinite(n.x)) continue;
          const d = Math.hypot(n.x - p.x, n.y - p.y);
          if (d < bestD) { bestD = d; best = n; }
        }
        return bestD <= limit ? best : null;
      }

      function select(n) {
        selected = n || null;
        neighbor = new Set();
        if (n) {
          neighbor.add(n.id);
          for (const a of model.adj.get(n.id) || []) neighbor.add(a.id);
        }
        notify(selected, neighbor, model);
        draw();
      }

      function onPointerDown(e) {
        canvas.setPointerCapture?.(e.pointerId);
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        moved = false;
        const n = hitTest(sx, sy);
        if (n) {
          dragging = n;
          n.pinned = true;
        } else {
          panning = { x: sx, y: sy, vx: view.x, vy: view.y };
        }
      }
      function onPointerMove(e) {
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;

        if (dragging) {
          const p = toWorld(sx, sy);
          dragging.x = p.x;
          dragging.y = p.y;
          moved = true;
          draw();
          return;
        }
        if (panning) {
          view.x = panning.vx - (sx - panning.x) / view.k;
          view.y = panning.vy - (sy - panning.y) / view.k;
          if (Math.hypot(sx - panning.x, sy - panning.y) > 3) {
            moved = true;
            userMovedView = true;
          }
          draw();
          return;
        }
        const n = hitTest(sx, sy);
        if (n !== hovered) {
          hovered = n;
          canvas.style.cursor = n ? "pointer" : "grab";
          draw();
        }
      }

      function onPointerUp(e) {
        const wasDragging = !!dragging;
        const startNode = dragging;
        dragging = null;
        panning = null;
        canvas.releasePointerCapture?.(e.pointerId);
        if (wasDragging) {
          if (startNode) startNode.pinned = false; // 松手后回到力的体系里
          if (!moved) select(startNode);
          return;
        }
        if (!moved) select(null);
      }

      function onWheel(e) {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const before = toWorld(sx, sy);
        const factor = Math.exp(-e.deltaY * 0.0015);
        view.k = Math.max(0.05, Math.min(8, view.k * factor));
        const after = toWorld(sx, sy);
        view.x += before.x - after.x;
        view.y += before.y - after.y;
        userMovedView = true;
        draw();
      }

      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerUp);
      canvas.addEventListener("wheel", onWheel, { passive: false });

      const ro = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
      ro?.observe(host);
      resize();

      return {
        setData(snap) {
          const data = normalize(snap);
          const layout = buildLayout(data.nodes, data.edges);
          settle(data.nodes, layout);
          model = {
            nodes: data.nodes,
            edges: data.edges,
            layout,
            byId: new Map(data.nodes.map((n) => [n.id, n])),
            adj: new Map(data.nodes.map((n) => [n.id, []])),
          };
          for (const e of data.edges) {
            model.adj.get(e.from)?.push({ id: e.to, rel: e.rel, weight: e.weight });
            model.adj.get(e.to)?.push({ id: e.from, rel: e.rel, weight: e.weight });
          }
          const degrees = data.nodes.map((n) => n.degree || 0).sort((a, b) => b - a);
          hubDegree = Math.max(4, degrees[Math.floor(degrees.length * 0.05)] || 0);
          selected = null;
          hovered = null;
          neighbor = new Set();
          notify(null, neighbor, model);
          // 换数据即重置视图主导权：这是「新的一张图」，用户之前的缩放/平移
          // 对不上新布局，留着只会让人以为图坏了。
          userMovedView = false;
          resize();
          fit();
          // 首帧后再取一次景。
          //
          // 面板是刚挂进 DOM 的，`resize()` 此刻量到的容器可能还没拿到最终
          // 尺寸（flex 布局尚未结算、或侧栏动画未结束），于是 `fit()` 用了一个
          // 偏小的 w/h，图就被压到一角、旁边留大片空白。
          // 两个 rAF 之后布局一定已结算，此时再 fit 一次最稳。
          // 只在「首次装载」重取景：用户手动缩放过之后不该被拉回去。
          if (!userMovedView) {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                if (!userMovedView) { resize(); fit(); }
              });
            });
          }
        },
        setTiers(next) { filters.tiers = next; draw(); },
        setMinWeight(v) { filters.minWeight = v; draw(); },
        fit,
        /**
         * 选中某颗星并把视角推过去。
         *
         * 供详情卡里的邻居列表调用 —— 那条路径不经过 canvas 事件，
         * 没有指针坐标可回算，只能按 id 直接找。
         * @param {string} id
         */
        focus(id) {
          const n = model.byId.get(id);
          if (!n) return;
          // 邻居可能在别的簇里、当前视野外，先平移再选中，否则高亮的星在屏幕外，
          // 用户只会看到「点了没反应」。
          view.x = n.x;
          view.y = n.y;
          // 太远的时候缩放一下更有用：整图尺度的跳转基本看不出位置变化。
          if (view.k < 0.7) view.k = 1.1;
          userMovedView = true;
          select(n);
        },
        relayout() {
          const layout = buildLayout(model.nodes, model.edges);
          model.layout = layout;
          settle(model.nodes, layout);
          fit();
        },
        destroy() {
          ro?.disconnect();
          canvas.removeEventListener("pointerdown", onPointerDown);
          canvas.removeEventListener("pointermove", onPointerMove);
          canvas.removeEventListener("pointerup", onPointerUp);
          canvas.removeEventListener("pointercancel", onPointerUp);
          canvas.removeEventListener("wheel", onWheel);
          if (raf) cancelAnimationFrame(raf);
          canvas.remove();
        },
      };
    }

    /* ================================================================== *
     * 4. RPC
     * ================================================================== */

    function connectionOf(ctx) {
      const c = ctx && (ctx.connection || (typeof ctx.get === "function" ? ctx.get("connection") : undefined));
      if (!c || !c.rpc || typeof c.rpc.call !== "function") return null;
      return c.rpc;
    }

    async function fetchSnapshot(ctx) {
      const rpc = connectionOf(ctx);
      if (!rpc) {
        const e = new Error("连接服务不可用（浏览器半没拿到 connection.rpc）");
        e.code = "no-connection";
        throw e;
      }
      const raw = await rpc.call(CHANNEL, "graph", null);
      if (!raw || raw.ok !== true) {
        const info = (raw && raw.error) || { code: "bad-envelope", message: "返回不是 RpcResult 信封" };
        const e = new Error(info.message);
        e.code = info.code;
        throw e;
      }
      return raw.value;
    }

    function explain(err) {
      const code = err && err.code;
      if (code === "no-connection") return err.message;
      if (typeof err?.message === "string" && /HTTP 40[34]/.test(err.message)) {
        return "取不到数据：核心插件 dsh-memory-hybrid 未安装，或版本低于 0.3.0（缺少 /memory-hybrid 通道）";
      }
      if (code === "snapshot-failed") return `核心插件生成快照失败：${err.message}`;
      return err?.message || String(err);
    }

    /* ================================================================== *
     * 5. 面板
     * ================================================================== */

    const styles = {
      wrap: {
        display: "flex", flexDirection: "column",
        // 用 100% 而不是 100vh：面板嵌在主区域的 flex 容器里，vh 会按整个视口算，
        // 底部的提示行就被挤出可视区。
        height: "100%", minHeight: 0, overflow: "hidden", background: "#080b12",
      },
      // ⚠ 别叫 `bar`：下面 gauge 的进度条也叫 bar，同名字面量后者会静默覆盖前者，
      // 顶栏就被压成 4px 高、内容全裁掉，且不报任何错。
      topbar: {
        display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
        borderBottom: "1px solid #1d2530", background: "#0e131b", flex: "0 0 auto", flexWrap: "wrap",
      },
      title: { fontSize: 13, fontWeight: 500, color: "#d7dce4", margin: 0 },
      meta: { fontSize: 12, color: "#8a93a0", fontVariantNumeric: "tabular-nums" },
      spacer: { flex: 1 },
      btn: {
        background: "#161d27", border: "1px solid #262d38", color: "#d7dce4",
        borderRadius: 6, padding: "3px 9px", cursor: "pointer", font: "inherit", fontSize: 12,
      },
      chip: (on, color) => ({
        display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer",
        border: `1px solid ${on ? color : "#262d38"}`, borderRadius: 999,
        padding: "1px 9px", fontSize: 12,
        color: on ? "#d7dce4" : "#6b7482", background: on ? "rgba(255,255,255,0.04)" : "transparent",
      }),
      dot: (color, on) => ({ width: 7, height: 7, borderRadius: "50%", background: on ? color : "#3b4757" }),
      canvasHost: { position: "relative", flex: "1 1 auto", minHeight: 0 },
      card: {
        position: "absolute", left: 12, bottom: 12, width: 300, maxWidth: "calc(100% - 24px)",
        // 枢纽节点能挂几十个邻居，卡片必须能滚；58% 是留出画布下半截的折中，
        // 再高就把刚点亮的星挡掉了。
        maxHeight: "68%", overflowY: "auto", background: "rgba(14,19,27,0.96)",
        border: "1px solid #262d38", borderRadius: 10, padding: "10px 12px", backdropFilter: "blur(6px)",
        zIndex: 2,
      },
      cardText: { fontSize: 13, lineHeight: 1.6, color: "#d7dce4", margin: "0 16px 8px 0" },
      chips: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 },
      row: { display: "grid", gridTemplateColumns: "58px 1fr 42px", gap: 8, alignItems: "center", fontSize: 12, margin: "3px 0" },
      label: { color: "#8a93a0" },
      value: { textAlign: "right", fontVariantNumeric: "tabular-nums", color: "#d7dce4" },
      bar: { height: 4, borderRadius: 2, background: "#1b212a", overflow: "hidden" },      barFill: (w, c) => ({ display: "block", height: "100%", width: `${w}%`, background: c }),
      close: {
        position: "absolute", top: 6, right: 8, background: "none", border: 0,
        color: "#8a93a0", cursor: "pointer", fontSize: 15, lineHeight: 1,
      },
      error: { padding: 24, color: "#d7dce4", fontSize: 13, lineHeight: 1.7 },
      quiet: { color: "#8a93a0", fontSize: 12, marginTop: 6 },
      legend: {
        position: "absolute", right: 12, top: 12, width: 178,
        background: "rgba(14,19,27,0.9)", border: "1px solid #1d2530",
        borderRadius: 10, padding: "9px 11px", backdropFilter: "blur(6px)",
        fontSize: 11.5, color: "#8a93a0", pointerEvents: "none",
        // 画布是后挂的兄弟节点，不给层级会被它盖住（图例在 DOM 里靠前）。
        zIndex: 2,
      },
      legendHead: { fontSize: 11, color: "#5f6a7a", letterSpacing: "0.06em", margin: "0 0 5px" },
      legendRow: { display: "flex", alignItems: "center", gap: 6, lineHeight: "17px" },
      legendGap: { height: 7 },
      nbrWrap: { marginTop: 9, paddingTop: 8, borderTop: "1px solid #1d2530" },
      nbrRow: {
        display: "flex", alignItems: "center", gap: 7, width: "100%",
        background: "none", border: 0, padding: "3px 2px", cursor: "pointer",
        color: "#b9c8de", font: "inherit", fontSize: 12, textAlign: "left",
        borderRadius: 4,
        // 内联样式给不了 :hover，用 opacity 做静态区分即可 —— 高亮态在画布上，
        // 列表里过分强调反而抢视线。
        opacity: 0.9,
      },
      nbrText: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      swatch: (color) => ({
        width: 7, height: 7, borderRadius: "50%", background: color, flex: "0 0 auto",
      }),
      rule: (color, dash) => ({
        width: 14, height: 0, flex: "0 0 auto",
        borderTop: `1px ${dash ? "dashed" : "solid"} ${color}`,
        opacity: dash ? 0.95 : 0.8,
      }),
      // 空库提示。放在画布正中，但要跟图例（右上）和详情卡（左下）错开。
      empty: {
        position: "absolute", left: 0, right: 0, top: "42%",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
        textAlign: "center", padding: "0 24px", pointerEvents: "none", zIndex: 1,
      },
      emptyTitle: { fontSize: 14, color: "#8a93a0" },
      emptyHint: { fontSize: 12, lineHeight: 1.8, color: "#5f6a7a", maxWidth: 420 },
    };

    function gauge(label, value, shown, color) {
      return h("div", { style: styles.row, key: label },
        h("span", { style: styles.label }, label),
        h("span", { style: styles.bar }, h("i", { style: styles.barFill(clamp01(value) * 100, color) })),
        h("span", { style: styles.value }, shown),
      );
    }

    /**
     * 右上角图例。
     *
     * 星图这套编码有四个维度（大小、明暗、颜色、线型），光看图读不出来，
     * 但控件又不能占满顶栏 —— 所以做成画布上的浮层：不用时它只是静态参考，
     * 不拦截指针（`pointerEvents: none`），拖拽/缩放照常穿透到画布。
     */
    function Legend({ stats }) {
      const byKind = stats.byKind || {};
      const byRel = stats.byRel || {};
      const kinds = Object.entries(KIND).filter(([k]) => byKind[k]);
      const rels = Object.entries(REL).filter(([r]) => byRel[r]);
      return h("div", { style: styles.legend },
        h("div", { style: styles.legendHead }, "大小 = 强度 imp×R"),
        h("div", { style: styles.legendHead }, "明暗 = 档位"),
        h("div", { style: styles.legendGap }),
        h("div", { style: styles.legendHead }, "颜色 = 类型"),
        ...kinds.map(([k, v]) => h("div", { key: k, style: styles.legendRow },
          h("i", { style: styles.swatch(v.color) }), `${v.label} ${byKind[k]}`)),
        rels.length > 0 && h("div", { style: styles.legendGap }),
        rels.length > 0 && h("div", { style: styles.legendHead }, "线型 = 关系"),
        ...rels.map(([r, v]) => h("div", { key: r, style: styles.legendRow },
          h("i", { style: styles.rule(v.color, v.dash) }),
          `${v.label} ${byRel[r]}`)),
      );
    }

    function DetailCard({ node, neighbors, onClose, onPick }) {
      if (!node) return null;
      const color = (KIND[node.kind] || {}).color || "#8FA3C4";
      const tierColor = (TIER[node.tier] || {}).color || "#8FA3C4";
      return h("div", { style: styles.card },
        h("button", { style: styles.close, onClick: onClose, title: "关闭" }, "×"),
        h("div", { style: styles.cardText }, node.text || "（无文本）"),
        h("div", { style: styles.chips },
          h("span", { style: { ...styles.chip(true, color), cursor: "default" } },
            h("i", { style: styles.dot(color, true) }), node.kind),
          h("span", { style: { ...styles.chip(true, tierColor), cursor: "default" } },
            h("i", { style: styles.dot(tierColor, true) }), node.tier),
          ...node.tags.slice(0, 3).map((t) => h("span", {
            key: t, style: { ...styles.chip(true, "#3b4757"), cursor: "default", color: "#8a93a0" },
          }, t)),
        ),
        gauge("可召回 R", node.retention, `${Math.round(clamp01(node.retention) * 100)}%`, color),
        gauge("重要度", node.importance, node.importance.toFixed(2), color),
        gauge("强度", node.weight, node.weight.toFixed(2), color),
        h("div", { style: styles.quiet },
          `召回 ${node.recallCount} 次 · 稳定度 ${node.stability.toFixed(1)} 天 · 邻居 ${neighbors.length} · 写入 ${fmtDate(node.createdAt)}`),
        // 邻居列表：点一下就把视角跳到那颗星。
        //
        // 这是「点星看邻居」的闭环 —— 只高亮不给跳转，找一颗相连的暗星得
        // 自己在满天里摸，而图谱最常见的用法恰恰是顺着关联一路走下去。
        neighbors.length > 0 && h("div", { style: styles.nbrWrap },
          h("div", { style: styles.legendHead }, "直接邻居"),
          ...neighbors.map((a) => {
            const rel = REL[a.rel] || REL.related;
            const other = a.node;
            const label = (other && other.text) || a.id;
            return h("button", {
              key: a.id, style: styles.nbrRow, title: label,
              onClick: () => onPick && onPick(a.id),
            },
              h("i", { style: styles.rule(rel.color, rel.dash) }),
              h("span", { style: styles.nbrText },
                label.length > 26 ? label.slice(0, 25) + "…" : label),
            );
          })),
      );
    }

    function GraphPanel({ ctx }) {
      const [state, setState] = React.useState({ status: "loading", snap: null, error: null });
      const [selected, setSelected] = React.useState(null);
      /** 选中节点的直接邻居：`[{ id, rel, node }]`，已按关系强度排过。 */
      const [neighbors, setNeighbors] = React.useState([]);
      const [tiers, setTiers] = React.useState(new Set(["active", "long", "dormant"]));
      const [minWeight, setMinWeight] = React.useState(0.3);
      const hostRef = React.useRef(null);
      const rendererRef = React.useRef(null);
      const [tick, setTick] = React.useState(0);

      const load = React.useCallback(() => {
        setState((s) => ({ ...s, status: "loading", error: null }));
        fetchSnapshot(ctx).then(
          (snap) => setState({ status: "ready", snap, error: null }),
          (err) => setState({ status: "error", snap: null, error: explain(err) }),
        );
      }, [ctx]);

      React.useEffect(() => { load(); }, [load]);

      // 数据到位后建渲染器；数据换一份就整体重建（布局要重算）
      React.useEffect(() => {
        if (!state.snap || !hostRef.current) return undefined;
        const r = createRenderer(hostRef.current, {
          onSelect: (node, nbr, m) => {
            setSelected(node);
            setNeighbors(neighborsOf(m, node));
          },
        });
        rendererRef.current = r;
        r.setData(state.snap);
        r.setTiers(tiers);
        r.setMinWeight(minWeight);
        return () => { r.destroy(); rendererRef.current = null; };
        // tiers/minWeight 另有效果同步，这里只依赖数据
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [state.snap]);

      React.useEffect(() => { rendererRef.current?.setTiers(tiers); }, [tiers]);
      React.useEffect(() => { rendererRef.current?.setMinWeight(minWeight); }, [minWeight]);

      const toggleTier = (t) => {
        const next = new Set(tiers);
        if (next.has(t)) next.delete(t); else next.add(t);
        if (next.size === 0) next.add(t); // 全关掉等于白屏，没意义
        setTiers(next);
      };

      const stats = (state.snap && state.snap.stats) || {};
      const bar = h("div", { style: styles.topbar },
        h("h1", { style: styles.title }, "记忆图谱"),
        h("span", { style: styles.meta },
          state.status === "ready"
            ? `${stats.memories ?? 0} 记忆 · ${stats.edges ?? 0} 边 · rev ${state.snap.rev ?? 0}`
            : state.status === "loading" ? "载入中…" : "不可用"),
        h("span", { style: styles.spacer }),
        ...[["active", "在册"], ["long", "长期"], ["dormant", "沉睡"]].map(([t, label]) =>
          h("span", {
            key: t, style: styles.chip(tiers.has(t), TIER[t].color), onClick: () => toggleTier(t), title: `过滤 ${label}`,
          }, h("i", { style: styles.dot(TIER[t].color, tiers.has(t)) }), label)),
        h("span", { style: { width: 1, height: 16, background: "#262d38" } }),
        h("button", { style: styles.btn, onClick: () => rendererRef.current?.fit() }, "适配"),
        h("button", { style: styles.btn, onClick: () => rendererRef.current?.relayout() }, "重排"),
        h("button", { style: styles.btn, onClick: () => { load(); setTick((v) => v + 1); } }, "刷新"),
      );

      if (state.status === "error") {
        return h("div", { style: styles.wrap }, bar,
          h("div", { style: styles.error },
            h("div", null, state.error),
            h("div", { style: styles.quiet },
              "面板需要核心插件 dsh-memory-hybrid ≥ 0.3.0。装好并重启后再点「刷新」。"),
          ));
      }

      return h("div", { style: styles.wrap, key: tick }, bar,
        h("div", { style: styles.canvasHost, ref: hostRef },
          h(Legend, { stats }),
          // 空库时画布是全黑的，和图例、控件摆在一起看着像加载失败。
          // 必须先于「有没有数据」给一句人话，否则用户唯一能做的就是去翻日志。
          state.status === "ready" && (stats.memories ?? 0) === 0 &&
            h("div", { style: styles.empty },
              h("div", { style: styles.emptyTitle }, "这个记忆库还是空的"),
              h("div", { style: styles.emptyHint },
                "图谱只画已经写入的记忆。先正常聊几轮，让记忆积累起来；",
                "或者用 tools/seed-store.mjs 灌一份样本先看效果（看完记得 --clear）。"),
            ),
          h(DetailCard, {
            node: selected,
            neighbors,
            onPick: (id) => rendererRef.current?.focus(id),
            onClose: () => { setSelected(null); setNeighbors([]); rendererRef.current && rendererRef.current.setMinWeight(minWeight); },
          }),
        ),
        h("div", { style: { ...styles.meta, padding: "4px 12px", borderTop: "1px solid #1d2530" } },
          `CLIENT v${CLIENT_VERSION} · 滚轮缩放 · 拖背景平移 · 拖节点改位置 · 点星看邻居`),
      );
    }

    /* ================================================================== *
     * 6. 注册
     * ================================================================== */

    /**
     * 依赖声明。**少一个都会让整个包在启动图里判为 failed**。
     *
     * Cordis 的属性访问是受 inject 保护的白名单：没在这一行里出现的服务，
     * `ctx.foo` 读一下就会抛 `cannot get property "foo" without inject`，
     * 而 apply 一抛错，宿主就把这个 entry 记成 failed，面板直接不出现。
     *
     *   · `slots`  —— 侧栏图标与主面板两个插槽，硬依赖；
     *   · `locale` —— `sidebar.panellist` 的 `locale` 字段要走它做归属；
     *   · `connection` —— 取 RPC 通道。这里只声明「许可」，实际仍用
     *     `ctx.get("connection")` 惰性取，因为 RPC 晚就绪是常态：
     *     声明 ≠ 保证就绪，拿到 null 时面板显示「未连接」而不是崩。
     */
    const inject = ["slots", "locale", "connection"];

    function apply(ctx) {
      const slot = (name, options, component) =>
        ctx.slots.inject(name, () => ctx.slots.register({ name, ...options }, component));
      const props = () => ({ ctx });

      const icon = (p) => {
        const size = p.size || 18;
        return h("svg", {
          width: size, height: size, viewBox: "0 0 24 24", fill: "none",
          "aria-hidden": "true", focusable: "false",
        }, [
          // 三颗星 + 一条连线：能认出来是「图」，同时在 16–18px 下不糊
          h("circle", { key: "a", cx: 7, cy: 8, r: 2.1, fill: "currentColor" }),
          h("circle", { key: "b", cx: 17, cy: 7, r: 1.5, fill: "currentColor", opacity: 0.75 }),
          h("circle", { key: "c", cx: 12, cy: 16.5, r: 2.6, fill: "currentColor" }),
          h("path", {
            key: "l", d: "M8.6 9.4 L15.6 7.6 M8 9.8 L10.8 14.6 M15.4 8.4 L13.2 14.2",
            stroke: "currentColor", strokeWidth: 1, opacity: 0.5, strokeLinecap: "round",
          }),
        ]);
      };

      ctx.effect(() => {
        const offs = [
          slot("sidebar.panellist", {
            id: PANEL_ID, order: 3, locale: NS,
            label: () => "图谱",
          }, icon),
          slot("main", { key: PANEL_ID, locale: NS, inject: props }, GraphPanel),
        ];
        return () => {
          for (const off of offs) {
            try { off?.(); } catch { /* 单处撤销失败不连累其余 */ }
          }
        };
      }, "memory-graph: panel");
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.PANEL_ID = PANEL_ID;
    exports.CHANNEL = CHANNEL;

    /**
     * 给测试用的内部函数。
     *
     * 布局与规整是纯逻辑，但宿主只认 apply —— 没有这个出口，
     * 它们就只能靠「开浏览器看」来验证，而这个项目的规矩是布局这类东西
     * 必须在 node 里可断言。
     */
    exports.__internals = { normalize, buildLayout, tickLayout, settle, boundsOf, hashSeed, neighborsOf };

    return module.exports;
  },
});

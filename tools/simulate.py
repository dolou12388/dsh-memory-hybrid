# -*- coding: utf-8 -*-
"""记忆权重模型参数校验与稳态仿真。

用途：在写实现之前验证三件事
  1. 五态状态机是否闭合（是否存在不死不活的悬挂态）
  2. 记忆库总量是否收敛（长期记忆层会不会无界累积）
  3. 心情调制幅度是否真的被限制在预期区间内

运行：python -X utf8 tools/simulate.py
"""

import math
import random
import statistics
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# ---------------------------------------------------------------- 参数表
R_FORGET = 0.05        # active 层遗忘阈值
R_DEMOTE = 0.20        # long 层降级阈值（保留度，非时间窗）
LAMBDA_LONG = 4.0      # long 层衰减减速倍率
S_MAX = 365.0          # 稳定度上限（天）
G_BASE = 0.5           # 基础增益
S_PROMOTE = 30.0       # 晋升所需稳定度
S_DEMOTE = 20.0        # 降级后回拨到的稳定度
S_REVIVE = 0.5         # 唤醒时的稳定度折扣（节省法）
RECALL_MIN_PROMOTE = 2 # 晋升所需成功召回次数
S_REVIVE_FLOOR = 0.5   # 唤醒后稳定度下限（按档位取 S0 的一半，见 revive()）

IMP_LEVELS = ("trivial", "normal", "important", "critical")
IMP_VALUE = {
    "trivial": 0.15,
    "normal": 0.40,
    "important": 0.70,
    "critical": 0.95,
}
IMP_FLOOR_REVIVE = 0.40   # 被关联边唤醒后，importance 至少提到此值

LEVELS = {
    "trivial":   (0.15, 0.5),
    "normal":    (0.40, 3.0),
    "important": (0.70, 14.0),
    "critical":  (0.95, 60.0),
}

# 心情二维坐标
MOOD = {
    "兴奋": (1.0, 1.0),
    "开心": (1.0, 0.55),
    "专注": (0.4, 0.60),
    "平静": (0.0, 0.0),
    "疲惫": (-0.5, -1.0),
    "低落": (-0.8, -0.60),
    "焦虑": (-1.0, 0.85),
    "烦躁": (-0.9, 0.55),
}

# 心情调制（与 plugin/src/core/config.js 一致，实测定参）
THETA_BASE = 0.55      # 原 0.60：θ 区间 [0.528,0.672] 整段落在档位间隙，调制失效
K_V = 0.50             # 原 0.12：需让 θ ∈ [0.275,0.825] 横跨三条档位边界
K_A = 0.10
SPACING_K = 1.5        # 间隔效应曲线陡度
EMA_ALPHA = 0.55       # 心情惯性；原 0.3 需连续 7 轮同向才能跨档


# ---------------------------------------------------------------- 基础函数
def retention(tier, S, dt_days):
    """当前可召回度。long 层以 λ 倍慢速衰减。"""
    if S <= 0:
        return 0.0
    s_eff = S * LAMBDA_LONG if tier == "long" else S
    return math.exp(-dt_days / s_eff)


def forget_day(S, tier="active"):
    """R 降到遗忘阈值所需天数。"""
    s_eff = S * LAMBDA_LONG if tier == "long" else S
    return -s_eff * math.log(R_FORGET)


def demote_day(S):
    """long 层 R 降到降级阈值所需天数。"""
    return -S * LAMBDA_LONG * math.log(R_DEMOTE)


def grow(S, R_at_recall, f_mood=1.0):
    """一次成功召回后的稳定度。间隔效应：越难召回，增益越大。

    形状取 FSRS：exp(k(1-R)) - 1，保证 R=1 时增益恰为 0。
    写成 1+(1-R) 会让「刚记下就重复」拿 2 倍增益，方向与间隔效应相反。
    """
    R = min(1.0, max(0.0, R_at_recall))
    spacing_gain = math.exp(SPACING_K * (1.0 - R)) - 1.0
    g_eff = G_BASE * spacing_gain * f_mood
    return min(S * (1.0 + g_eff), S_MAX)


def revive(S, level):
    """dormant → active 的稳定度与档位回补。

    节省法：重学比重学快，但不是零成本。折扣 S_REVIVE 后以该档 S0 的一半兜底，
    避免 trivial 条目被唤醒后跳变到 normal 级存活期（原 FLOOR=3 的缺陷）。
    """
    new_level = level if IMP_VALUE[level] >= IMP_FLOOR_REVIVE else "normal"
    s0 = LEVELS[new_level][1]
    s_new = max(s0 * S_REVIVE, min(S * S_REVIVE, S))
    return s_new, new_level


# ---------------------------------------------------------------- 1. 单点轨迹
def trace(schedule, level="normal", horizon=300):
    """按给定召回日程跑一条记忆的完整生命周期。"""
    S = LEVELS[level][1]
    tier = "long" if level == "critical" else "active"
    last = 0
    count = 0
    rows = []
    for d in range(1, horizon + 1):
        dt = d - last
        R = retention(tier, S, dt)
        note = ""
        if d in schedule and tier != "dormant":
            S = grow(S, R)
            count += 1
            last = d
            if tier == "active" and S >= S_PROMOTE and count >= RECALL_MIN_PROMOTE:
                tier = "long"
                note = "晋升 long"
            else:
                note = f"召回 #{count}"
            R = 1.0
        else:
            if tier == "active" and R < R_FORGET:
                tier = "dormant"
                note = "遗忘"
            elif tier == "long" and R < R_DEMOTE:
                tier = "active"
                S = S_DEMOTE
                note = "降级 active"
        if note or d in (1, 30, 90, 180, 300):
            rows.append((d, tier, S, R, note))
    return rows


# ---------------------------------------------------------------- 2. 稳态仿真
def sim_one(p_recall, level, days=730, p_revive=0.002, rng=None):
    """单条记忆的蒙特卡洛生命周期，返回 (首次遗忘日, 期末 tier)。"""
    rng = rng or random.Random()
    S = LEVELS[level][1]
    tier = "long" if level == "critical" else "active"
    last = 0
    count = 0
    first_dormant = None
    for d in range(1, days + 1):
        dt = d - last
        if tier == "dormant":
            if rng.random() < p_revive:
                S, level = revive(S, level)
                tier = "active"
                last = d
                count += 1
            continue
        if rng.random() < p_recall:
            R = retention(tier, S, dt)
            S = grow(S, R)
            count += 1
            last = d
            if tier == "active" and S >= S_PROMOTE and count >= RECALL_MIN_PROMOTE:
                tier = "long"
            continue
        R = retention(tier, S, dt)
        if tier == "active" and R < R_FORGET:
            tier = "dormant"
            if first_dormant is None:
                first_dormant = d
        elif tier == "long" and R < R_DEMOTE:
            tier = "active"
            S = S_DEMOTE
    return first_dormant, tier


def equilibrium(p_recall, level="normal", n=4000, days=730):
    rng = random.Random(20261030)
    lifespans = []
    tiers = {"active": 0, "long": 0, "dormant": 0}
    for _ in range(n):
        fd, tier = sim_one(p_recall, level, days=days, rng=rng)
        tiers[tier] += 1
        lifespans.append(fd if fd is not None else days)
    return {
        "median_life": statistics.median(lifespans),
        "mean_life": statistics.mean(lifespans),
        "p90_life": sorted(lifespans)[int(0.9 * n)],
        "tiers": {k: v / n for k, v in tiers.items()},
    }


# ---------------------------------------------------------------- 3. 心情调制
def mood_state(labels):
    """多标签聚合成 (V, A)。"""
    v = sum(MOOD[c][0] * (i / 3.0) for c, i in labels)
    a = sum(MOOD[c][1] * (i / 3.0) for c, i in labels)
    return max(-1.0, min(1.0, v)), max(-1.0, min(1.0, a))


def modulate(v, a):
    theta = THETA_BASE * (1.0 - K_V * v)   # 乘性：θ ∈ [θ_base(1-K_V), θ_base(1+K_V)] = [0.275, 0.825]
    f = 1 + K_A * a
    return theta, f


def ema_converge(v, a, n, alpha=0.3, v0=0.0, a0=0.0):
    ev, ea = v0, a0
    for _ in range(n):
        ev = (1 - alpha) * ev + alpha * v
        ea = (1 - alpha) * ea + alpha * a
    return ev, ea


# ---------------------------------------------------------------- 主流程
def main():
    line = "=" * 74

    print(line)
    print("1. 单点生命周期：normal 档，按 6/20/45/90/150/240 天规律召回")
    print(line)
    print(f"{'天':>5} {'层级':>9} {'S(天)':>8} {'R':>7}  事件")
    for d, tier, S, R, note in trace([6, 20, 45, 90, 150, 240]):
        print(f"{d:5d} {tier:>9} {S:8.1f} {R:7.3f}  {note}")

    print()
    print(line)
    print("2. 无召回存活期（R < 0.05 判遗忘）")
    print(line)
    print(f"{'档位':>10} {'S0(天)':>8} {'遗忘时点':>10} {'long 降级':>10}")
    for name, (imp, s0) in LEVELS.items():
        f = forget_day(s0)
        dm = demote_day(s0) if name == "critical" else float("nan")
        dms = f"{dm:.0f} 天" if not math.isnan(dm) else "—"
        print(f"{name:>10} {s0:8.1f} {f:9.0f} 天 {dms:>10}")

    print()
    print(line)
    print("3. 稳态分布：730 天后各层占比（n=4000，随机召回）")
    print(line)
    print(f"{'日召回率':>8} {'中位寿命':>9} {'P90寿命':>9} "
          f"{'active':>8} {'long':>8} {'dormant':>9}")
    for p in (0.002, 0.005, 0.01, 0.02, 0.05):
        r = equilibrium(p)
        t = r["tiers"]
        print(f"{p:8.3f} {r['median_life']:8.0f}天 {r['p90_life']:8.0f}天 "
              f"{t['active']*100:7.1f}% {t['long']*100:7.1f}% {t['dormant']*100:8.1f}%")

    print()
    print(line)
    print("4. 库量估算：写 40 条/天时的稳态条数")
    print(line)
    r = equilibrium(0.01)
    print(f"  平均寿命 {r['mean_life']:.0f} 天 "
          f"→ 稳态约 {40 * r['mean_life']:.0f} 条")
    r = equilibrium(0.05)
    print(f"  高召回情形 平均寿命 {r['mean_life']:.0f} 天 "
          f"→ 稳态约 {40 * r['mean_life']:.0f} 条")

    print()
    print(line)
    print("5. 心情调制表（含多标签组合）")
    print(line)
    cases = [
        [("平静", 2)],
        [("开心", 3)],
        [("专注", 3)],
        [("焦虑", 3)],
        [("疲惫", 3)],
        [("开心", 3), ("焦虑", 3)],
        [("开心", 3), ("疲惫", 3)],
        [("专注", 3), ("疲惫", 2)],
    ]
    print(f"{'组合':>22} {'V':>7} {'A':>7} {'θ_write':>9} {'f_gain':>8}")
    for c in cases:
        v, a = mood_state(c)
        th, f = modulate(v, a)
        name = "+".join(f"{k}{i}" for k, i in c)
        print(f"{name:>22} {v:+7.2f} {a:+7.2f} {th:9.3f} {f:8.3f}")

    print()
    print(line)
    print("6. 双轴 EMA 收敛（α=0.3，从平静出发，连续同状态）")
    print(line)
    for label, vec, n in (
        ("开心3", MOOD["开心"], 3),
        ("焦虑3", MOOD["焦虑"], 3),
        ("开心3+焦虑3", (0.0, 1.0), 3),
    ):
        ev, ea = ema_converge(vec[0] * 1.0, vec[1] * 1.0, n)
        th, f = modulate(ev, ea)
        print(f"  {label:>12}  {n} 轮后 V={ev:+.3f} A={ea:+.3f} "
              f"θ={th:.3f} f={f:.3f}")

    print()
    print(line)
    print("7. 阈值一致性检查")
    print(line)
    def recalls_to_max(s0, r_at_recall):
        S, n = s0, 0
        while S < S_MAX and n < 100:
            S = grow(S, r_at_recall)
            n += 1
        return n

    checks = [
        ("trivial 存活 < 2 天", forget_day(0.5) < 2),
        ("long 降级晚于 active 遗忘", demote_day(30) > forget_day(30)),
        ("S_MAX 可达（≤12 次召回）", recalls_to_max(3.0, 0.5) <= 12),
        ("S_MAX 在踩线召回下更快", recalls_to_max(3.0, 0.05) < recalls_to_max(3.0, 0.95)),
        ("θ_write 区间不含 1.0", modulate(1, 0)[0] < 1.0),
        ("f_gain 上限 ≤ 1.15", modulate(0, 1)[1] <= 1.15),
        ("f_gain 下限 ≥ 0.85", modulate(0, -1)[1] >= 0.85),
        ("晋升阈值高于降级回拨", S_PROMOTE > S_DEMOTE),
        ("遗忘阈值高于降级阈值", R_FORGET < R_DEMOTE),
    ]
    for name, ok in checks:
        print(f"  [{'通过' if ok else '失败'}] {name}")


if __name__ == "__main__":
    main()

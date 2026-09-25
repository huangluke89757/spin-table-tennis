"""把欢呼声的新旧频谱对比画成图，供人工复核（客观指标之外的可视证据）。

产出 _shots/cheer_spectrum_compare.png：三联图
  ① 球馆底噪频谱（旧版 400Hz 低通 → 低频"轰"；新版高通后变空气感）
  ② 人声层频谱（旧版 480~980Hz 窄带噪声丘；新版基频 + 共振峰梳状结构）
  ③ 完整欢呼频谱（整体亮度与频段分布）
"""
import os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager

# 中文字体：matplotlib 默认 DejaVu Sans 没有汉字，标题会变成一排方块
for _f in ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc",
           "C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/simsun.ttc"]:
    if os.path.exists(_f):
        try:
            font_manager.fontManager.addfont(_f)
            _name = font_manager.FontProperties(fname=_f).get_name()
            plt.rcParams["font.family"] = _name
            plt.rcParams["axes.unicode_minus"] = False
            break
        except Exception:
            continue

# 本脚本位于 _tools/：项目根在上一层（HERE 始终指向项目根）
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(HERE, "_shots")


def load(name):
    a = np.load(os.path.join(SHOTS, "spec_%s.npy" % name))
    return a[0], a[1]


def smooth(P, k=24):
    """对数频轴画图前做滑动平均，否则高频毛刺看不清趋势"""
    if len(P) < k:
        return P
    ker = np.ones(k) / k
    return np.convolve(P, ker, mode="same")


fig, axes = plt.subplots(1, 3, figsize=(18, 5.2))
fig.patch.set_facecolor("#0d1117")

OLD = "#ff7b72"   # 旧版（红）
NEW = "#7ee0a8"   # 新版（绿）

# ---------- ① 球馆底噪 ----------
ax = axes[0]
for key, col, lab in [("roomOld", OLD, "旧版 400Hz 低通（持续「轰轰」）"),
                      ("roomNew", NEW, "新版 高通220 + 低通2600（空气感）")]:
    f, P = load(key)
    ax.semilogy(f, smooth(P) + 1e-18, color=col, lw=1.6, label=lab)
ax.axvspan(0, 200, color="#ff7b72", alpha=0.10)
ax.text(60, ax.get_ylim()[1] * 0.25, "「轰」的频段\n<200Hz", color="#ff7b72",
        fontsize=9, ha="center", va="top")
ax.set_title("① 球馆底噪（持续 loop 播放）", color="#e6edf3", fontsize=12)
ax.set_xlim(0, 3000)

# ---------- ② 人声层 ----------
ax = axes[1]
for key, col, lab in [("voiceOld", OLD, "旧版 13 条带通噪声（无音高 → 不像人）"),
                      ("voiceNew", NEW, "新版 24 条共振峰嗓子（声带基频 + 共振峰）")]:
    f, P = load(key)
    ax.semilogy(f, smooth(P) + 1e-18, color=col, lw=1.6, label=lab)
ax.axvspan(80, 400, color="#7ee0a8", alpha=0.10)
ax.text(200, ax.get_ylim()[1] * 0.30, "人声基频区\n80~400Hz", color="#7ee0a8",
        fontsize=9, ha="center", va="top")
for x, t in [(800, "F1"), (1500, "F2"), (2800, "F3")]:
    ax.axvline(x, color="#ffb454", ls=":", lw=1.1, alpha=0.75)
    ax.text(x, ax.get_ylim()[1] * 0.85, t, color="#ffb454", fontsize=9, ha="center")
ax.set_title("② 人声层（欢呼里「人」的部分，隔离量）", color="#e6edf3", fontsize=12)
ax.set_xlim(0, 4000)

# ---------- ③ 完整欢呼 ----------
ax = axes[2]
for key, col, lab in [("cheerOld", OLD, "旧版完整欢呼（质心 940Hz，高频 1.4%）"),
                      ("cheerNew", NEW, "新版完整欢呼（质心 1746Hz，高频 13.2%）")]:
    f, P = load(key)
    ax.semilogy(f, smooth(P) + 1e-18, color=col, lw=1.6, label=lab)
ax.axvspan(3500, 12000, color="#7ee0a8", alpha=0.10)
ax.text(6000, ax.get_ylim()[1] * 0.30, "空气感\n>3.5kHz", color="#7ee0a8",
        fontsize=9, ha="center", va="top")
ax.set_title("③ 完整欢呼（掌声 + 人声）", color="#e6edf3", fontsize=12)
ax.set_xlim(0, 12000)

for ax in axes:
    ax.set_facecolor("#161b22")
    ax.set_xlabel("频率 (Hz)", color="#8b949e", fontsize=10)
    ax.tick_params(colors="#8b949e", labelsize=9)
    for s in ax.spines.values():
        s.set_color("#30363d")
    ax.grid(True, which="both", color="#21262d", lw=0.6)
    ax.legend(facecolor="#161b22", edgecolor="#30363d", labelcolor="#c9d1d9",
              fontsize=8.5, loc="upper right")

axes[0].set_ylabel("功率谱密度（对数）", color="#8b949e", fontsize=10)
fig.suptitle("《旋转乒乓》观众欢呼声 · 新旧算法频谱对照（真实代码离线渲染 48kHz）",
             color="#e6edf3", fontsize=13.5, y=0.99)
fig.tight_layout(rect=[0, 0, 1, 0.94])
out = os.path.join(SHOTS, "cheer_spectrum_compare.png")
fig.savefig(out, dpi=140, facecolor=fig.get_facecolor())
print("已输出 " + out)

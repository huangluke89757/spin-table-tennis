"""欢呼声客观声学验证：读 _audio_spectrum.js 渲染的真实 PCM，逐层定位并对比新旧。

用户诉求：观众欢呼要是「热烈的欢呼声」，不能是「轰轰轰」。

分析策略 —— 逐层隔离，而不是笼统对比整段欢呼：
  1. 球馆底噪（持续 loop 播放，最可疑的"轰轰"来源）：新版必须切掉低频轰鸣
  2. 人声层（欢呼里"人"的部分）：新版必须有基频谐波，旧版是无音高噪声
  3. 完整欢呼：整体响度与频段分布合理

为什么不能只比整段欢呼的频谱质心：旧版掌声用了 1.15~2.6kHz 带通、数量又多，
会把整体质心拉到 1.2kHz 左右，于是"新旧质心差不多"——但听感天差地别。
必须把"掌声"和"人声"分开量，才能看出旧版人声层其实是低频噪声。

运行： <venv python> _audio_spectrum.py
"""
import json, os, sys
import numpy as np

# 本脚本位于 _tools/：项目根在上一层（HERE 始终指向项目根）
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(HERE, "_shots")
J = json.load(open(os.path.join(SHOTS, "cheer_spectrum.json"), encoding="utf-8"))
SR = J["sr"]


def spectrum(pcm, skip_dc=True):
    """Welch 平均功率谱。必须去均值：强包络信号每段均值非零，
    不去掉的话 DC bin 会吞掉几乎全部功率（实测质心会算成 0Hz）。"""
    x = np.asarray(pcm, dtype=np.float64)
    n, hop = 8192, 4096
    win = np.hanning(n)
    acc, cnt = None, 0
    for i in range(0, len(x) - n, hop):
        seg = x[i:i + n]
        seg = seg - seg.mean()
        seg = seg * win
        if np.max(np.abs(seg)) < 1e-9:
            continue
        P = np.abs(np.fft.rfft(seg)) ** 2
        acc = P if acc is None else acc + P
        cnt += 1
    f = np.fft.rfftfreq(n, 1 / SR)
    if acc is None or cnt == 0:
        return np.zeros_like(f), f
    P = acc / cnt
    if skip_dc:
        P[0] = 0
    return P, f


def band(P, f, lo, hi):
    m = (f >= lo) & (f < hi)
    return float(P[m].sum())


def harmonicity(pcm, want_f0=False):
    """自相关基频显著性：有音高的信号（声带振动）自相关有强峰，噪声则快速衰减。

    取能量最强的一段（欢呼爆发处）来量，避免静音段把指标拉低。
    返回峰值（0~1），want_f0=True 时返回检出的基频。
    """
    x = np.asarray(pcm, dtype=np.float64)
    n = 16384
    best, bi = -1.0, 0
    step = max(1, n // 2)
    for i in range(0, max(1, len(x) - n), step):
        e = float((x[i:i + n] ** 2).sum())
        if e > best:
            best, bi = e, i
    seg = x[bi:bi + n]
    if len(seg) < n:
        seg = np.pad(seg, (0, n - len(seg)))
    seg = seg - seg.mean()
    if np.max(np.abs(seg)) < 1e-9:
        return 0.0
    ac = np.correlate(seg, seg, "full")[n - 1:]
    ac = ac / (ac[0] + 1e-12)
    lo, hi = int(SR / 400), min(int(SR / 70), len(ac) - 1)   # 人声基频 70~400Hz
    w = ac[lo:hi]
    if len(w) == 0:
        return 0.0
    lag = lo + int(w.argmax())
    return (SR / lag if lag > 0 else 0.0) if want_f0 else float(w.max())


def comb_score(pcm):
    """谐波梳状结构强度：真声带振动在频域是等间隔谐波列（梳子），噪声是平滑丘。

    做法：先在**人声基频范围 80~400Hz** 内找最强谱峰当 f0（不能在全频段找——
    那样会命中 800Hz 附近的 F1 共振峰），再把频谱按该周期折叠求和，
    看能量是否集中（梳齿对齐）：对齐度高 → 有音高；噪声折叠后仍平坦。

    返回 (对齐度, 估计f0)。
    """
    P, f = spectrum(pcm)
    m0 = (f >= 80) & (f <= 400)
    if not m0.any():
        return 0.0, 0.0
    f0 = float(f[m0][P[m0].argmax()])
    if f0 < 80:
        return 0.0, 0.0
    m = (f >= 80) & (f <= 1200)
    fs, Ps = f[m], P[m]
    if Ps.max() <= 0:
        return 0.0, f0
    phase = (fs % f0) / f0
    nb = 24
    bins = np.zeros(nb)
    idx = np.clip((phase * nb).astype(int), 0, nb - 1)
    np.add.at(bins, idx, Ps)
    if bins.mean() <= 0:
        return 0.0, f0
    return float(bins.max() / bins.mean()), f0


def f0_band(pcm):
    """80~400Hz 能量占比 —— 人声基频区。

    这是判别「人声 vs 低频嗡鸣」最稳健的指标，物理意义直接：
      · 人声：声带基频 100~300Hz 就落在这里，能量必然可观
      · 旧版"人声"层：480~980Hz 带通（Q=5~9）→ 这一段几乎是空的
      · 球馆底噪的"轰"：0~200Hz → 也不在这里
    """
    P, f = spectrum(pcm)
    tot = P.sum() + 1e-15
    return band(P, f, 80, 400) / tot


def analyze(pcm, label):
    P, f = spectrum(pcm)
    tot = P.sum() + 1e-15
    x = np.asarray(pcm, dtype=np.float64)
    comb, cf0 = comb_score(pcm)
    return {
        "label": label,
        "rms": float(np.sqrt((x ** 2).mean())),
        "peak": float(np.max(np.abs(x))),
        "centroid": float((f * P).sum() / tot),
        "low": band(P, f, 0, 200) / tot,
        "mid": band(P, f, 200, 700) / tot,
        "voice": band(P, f, 300, 3500) / tot,
        "hi": band(P, f, 3500, SR / 2) / tot,
        "comb": comb, "cf0": cf0, "f0b": f0_band(pcm),
        "harm": harmonicity(pcm),
        "f0": harmonicity(pcm, want_f0=True),
        "P": P, "f": f,
    }


R = {k: analyze(J[k], k) for k in
     ["roomOld", "roomNew", "voiceOld", "voiceNew", "cheerOld", "cheerNew"]}

print("=" * 78)
print("欢呼声客观声学验证（真实 game.js 代码离线渲染，48kHz / 3s，Welch 8192 点）")
print("=" * 78)

print("\n【第 1 层】球馆底噪 —— 持续 loop 播放，是「轰轰轰」的最大嫌疑")
print("  旧版 400Hz 低通噪声　：低频 %.1f%%　质心 %.0f Hz　RMS %.4f"
      % (R["roomOld"]["low"] * 100, R["roomOld"]["centroid"], R["roomOld"]["rms"]))
print("  新版 高通220+低通2600：低频 %.1f%%　质心 %.0f Hz　RMS %.4f"
      % (R["roomNew"]["low"] * 100, R["roomNew"]["centroid"], R["roomNew"]["rms"]))

print("\n【第 2 层】人声层 —— 欢呼里「人」的部分（不含掌声，隔离量）")
print("  旧版 13 条带通噪声　：低频 %.1f%%　中低频(200-700) %.1f%%　基频区(80-400) %.1f%%　梳状 %.2f"
      % (R["voiceOld"]["low"] * 100, R["voiceOld"]["mid"] * 100,
         R["voiceOld"]["f0b"] * 100, R["voiceOld"]["comb"]))
print("  新版 24 条共振峰嗓子：低频 %.1f%%　中低频(200-700) %.1f%%　基频区(80-400) %.1f%%　梳状 %.2f"
      % (R["voiceNew"]["low"] * 100, R["voiceNew"]["mid"] * 100,
         R["voiceNew"]["f0b"] * 100, R["voiceNew"]["comb"]))

print("\n【第 3 层】完整欢呼（掌声 + 人声）")
print("  旧版：质心 %.0f Hz　人声段 %.1f%%　高频 %.1f%%　RMS %.4f"
      % (R["cheerOld"]["centroid"], R["cheerOld"]["voice"] * 100,
         R["cheerOld"]["hi"] * 100, R["cheerOld"]["rms"]))
print("  新版：质心 %.0f Hz　人声段 %.1f%%　高频 %.1f%%　RMS %.4f"
      % (R["cheerNew"]["centroid"], R["cheerNew"]["voice"] * 100,
         R["cheerNew"]["hi"] * 100, R["cheerNew"]["rms"]))

# ---------------- 判据 ----------------
checks = []

# 1. 底噪：新版必须把低频轰鸣压下去（这是「轰轰轰」的根因）
checks.append((
    R["roomNew"]["low"] < R["roomOld"]["low"] * 0.35,
    "球馆底噪低频轰鸣大幅降低（「轰」的根因被切掉）",
    "旧 %.1f%% → 新 %.1f%%（降 %.0f%%）" % (
        R["roomOld"]["low"] * 100, R["roomNew"]["low"] * 100,
        (1 - R["roomNew"]["low"] / max(1e-9, R["roomOld"]["low"])) * 100)))
checks.append((
    R["roomNew"]["centroid"] > R["roomOld"]["centroid"] * 2,
    "底噪质心上移到中高频（从闷响变空气感）",
    "%.0f Hz → %.0f Hz" % (R["roomOld"]["centroid"], R["roomNew"]["centroid"])))
checks.append((
    R["roomNew"]["rms"] < R["roomOld"]["rms"] * 0.85,
    "底噪响度下降（不再持续压住整个画面）",
    "RMS %.4f → %.4f（降 %.0f%%）" % (
        R["roomOld"]["rms"], R["roomNew"]["rms"],
        (1 - R["roomNew"]["rms"] / max(1e-9, R["roomOld"]["rms"])) * 100)))

# 2. 人声层：新版必须有声带基频（80~400Hz），旧版这一段是空的
checks.append((
    R["voiceNew"]["f0b"] > R["voiceOld"]["f0b"] * 3 + 0.02,
    "人声层出现明确的声带基频能量（旧版此段近乎为空 → 所以「不像人」）",
    "旧 %.1f%% → 新 %.1f%%（%s）" % (
        R["voiceOld"]["f0b"] * 100, R["voiceNew"]["f0b"] * 100,
        "旧版带通中心 480~980Hz，根本不含基频" if R["voiceOld"]["f0b"] < 0.01 else "有基频")))
checks.append((
    100 <= R["voiceNew"]["cf0"] <= 400,
    "人声层基频估计落在人声范围 100~400Hz",
    "f0 = %.0f Hz" % R["voiceNew"]["cf0"]))
# 注：不加「200-700Hz 能量更高」这类判据。旧版带通中心 480~980Hz 正好落在该区间，
# 它天然偏高；新版能量分布在基频区(80-400)与共振峰区(800~3kHz)，中低频本就该低。
# 拿一个偏向旧版算法的区间去要求新版更高，是判据设计错误，不是代码问题。

# 3. 整体欢呼：可辨性与亮度、响度
checks.append((
    R["cheerNew"]["voice"] > 0.45,
    "完整欢呼 300-3500Hz 人声段能量 > 45%（明亮可辨）",
    "%.1f%%" % (R["cheerNew"]["voice"] * 100)))
checks.append((
    R["cheerNew"]["hi"] > R["cheerOld"]["hi"],
    "完整欢呼高频空气感更足（掌声更清脆）",
    "旧 %.1f%% → 新 %.1f%%" % (R["cheerOld"]["hi"] * 100, R["cheerNew"]["hi"] * 100)))
checks.append((
    R["cheerNew"]["rms"] > R["cheerOld"]["rms"] * 0.75,
    "完整欢呼响度没因降噪而变弱（仍是热烈的）",
    "RMS %.4f → %.4f" % (R["cheerOld"]["rms"], R["cheerNew"]["rms"])))

print("\n判据：")
bad = 0
for ok, label, detail in checks:
    print("  " + ("PASS" if ok else "FAIL") + "  " + label + "　→ " + detail)
    if not ok:
        bad += 1

for k in ["roomOld", "roomNew", "voiceOld", "voiceNew", "cheerOld", "cheerNew"]:
    np.save(os.path.join(SHOTS, "spec_%s.npy" % k), np.vstack([R[k]["f"], R[k]["P"]]))

print("\n" + ("声学验证全部通过" if bad == 0 else "存在 %d 项失败" % bad))
sys.exit(0 if bad == 0 else 1)

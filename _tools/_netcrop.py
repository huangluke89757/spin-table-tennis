"""裁剪海报高光三连拍区域并放大，用于人工复核球网在海报里的可读性。
运行： python _netcrop.py
"""
from PIL import Image
import os

# 本脚本位于 _tools/：项目根在上一层（HERE 始终指向项目根）
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = os.path.join(HERE, "_shots", "09_poster_full.png")
im = Image.open(src)
W, H = im.size
print("海报尺寸:", W, "x", H)

# 高光三连拍：poster.js 里 sy=436 sh=196 sw=272 gap=10 sx=48（逻辑 900x1360），导出 2×
S = 2
sy, sh, sw, gap, sx = 436 * S, 196 * S, 272 * S, 10 * S, 48 * S
row = im.crop((sx, sy, sx + 3 * sw + 2 * gap, sy + sh))
row.save(os.path.join(HERE, "_shots", "_net_row.png"))
print("三连拍整行:", row.size)

for i in range(3):
    x = sx + i * (sw + gap)
    c = im.crop((x, sy, x + sw, sy + sh))
    c = c.resize((c.width * 3, c.height * 3), Image.LANCZOS)
    p = os.path.join(HERE, "_shots", "_net_%d.png" % (i + 1))
    c.save(p)
    print("放大", i + 1, c.size, p)

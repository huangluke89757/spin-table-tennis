# 二维码独立交叉验证：用 qrcode 库重新编码，与 poster.js 内联的矩阵逐位比对。
# 为什么需要它：_poster_shot.js 的「逐模块回读」是拿 poster.js 的矩阵去比对画布，
# 两边同源 —— 常量本身若写错，会一起错、测试照样全绿。
# 这里换一个独立信源（python qrcode 库）重新生成，逐位比对才算真的验过。
# 运行： python _qr_verify.py
import re, os, sys, base64
import qrcode
from qrcode.constants import ERROR_CORRECT_M

# 本脚本位于 _tools/：项目根在上一层（HERE 始终指向项目根）
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 1) 从 game.js 取网址
src = open(os.path.join(HERE, "game.js"), encoding="utf-8").read()
m = re.search(r'GAME_URL\s*=\s*"([^"]+)"', src)
if not m:
    print("FAIL 在 game.js 里找不到 GAME_URL"); sys.exit(1)
url = m.group(1)

# 2) 从 poster.js 取内联矩阵
js = open(os.path.join(HERE, "poster.js"), encoding="utf-8").read()
mn = re.search(r"var QR_N = (\d+);", js)
mb = re.search(r'var QR_B64 = "([^"]*)";', js)
if not mn or not mb:
    print("FAIL 在 poster.js 里找不到 QR_N / QR_B64"); sys.exit(1)
n_js = int(mn.group(1))
raw = base64.b64decode(mb.group(1))
bits = "".join(format(b, "08b") for b in raw)
js_matrix = [[1 if bits[r * n_js + c] == "1" else 0 for c in range(n_js)] for r in range(n_js)]

# 3) 独立重新编码
q = qrcode.QRCode(version=None, error_correction=ERROR_CORRECT_M, box_size=1, border=0)
q.add_data(url); q.make(fit=True)
ref = q.get_matrix()
n_ref = len(ref)

print("网址        :", url)
print("poster.js   : %d x %d" % (n_js, n_js))
print("独立重编码  : %d x %d" % (n_ref, n_ref))

ok = True
if n_js != n_ref:
    print("FAIL 尺寸不一致"); ok = False
else:
    diff = sum(1 for r in range(n_ref) for c in range(n_ref) if bool(ref[r][c]) != bool(js_matrix[r][c]))
    total = n_ref * n_ref
    print("逐位比对    : %d/%d 一致（差异 %d 位）" % (total - diff, total, diff))
    if diff:
        print("FAIL 矩阵与独立编码不一致"); ok = False

# 4) 定位图案自检（1:1:3:1:1）
def ring(m, oy, ox, rr):
    x, y = ox + 3, oy + 3
    return all([m[y][x - 3 + rr], m[y][x + 3 - rr], m[y - 3 + rr][x], m[y + 3 - rr][x]])
if ok:
    f = all(ring(js_matrix, oy, ox, k) for (oy, ox) in [(0, 0), (0, n_js - 7), (n_js - 7, 0)]
            for k in (0, 2, 4, 6))
    print("定位图案    : %s" % ("3/3 完整" if f else "异常"))
    if not f: ok = False

print()
print("结果        :", "PASS 二维码与独立编码完全一致，可扫" if ok else "FAIL")
sys.exit(0 if ok else 1)

# 生成海报用二维码：矩阵直接内联进 poster.js，运行时零网络、零文件依赖。
# 网址从 game.js 的 GAME_URL 读取，改地址只需重跑本脚本。
# 运行： python _qr.py
#
# 为什么不用图片文件（历史的两个坑，别再退回去）：
#   1) <img src="vendor/qr.png"> 在 file:// 下算跨域，画进海报 canvas 会污染画布，
#      玩家点「保存图片」时 toBlob 直接抛 SecurityError；
#   2) 图片是异步加载的，文件一旦漏传或加载慢于海报弹出，海报就静默降级成占位空框
#      —— 线上曾因为漏传 vendor/qr.js 出现整块白框。
# 内联成矩阵后，海报画得出来，二维码就一定在。
import re, os, sys, base64
import qrcode
from qrcode.constants import ERROR_CORRECT_M

# 本脚本位于 _tools/：项目根在上一层（HERE 始终指向项目根）
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(HERE, "game.js"), encoding="utf-8").read()
m = re.search(r'GAME_URL\s*=\s*"([^"]+)"', src)
if not m:
    print("在 game.js 里找不到 GAME_URL")
    sys.exit(1)
url = m.group(1)

# border=0：静默区由海报绘制时补（drawQR 的 quiet 参数），矩阵本身不带白边
qr = qrcode.QRCode(version=None, error_correction=ERROR_CORRECT_M,
                   box_size=1, border=0)
qr.add_data(url)
qr.make(fit=True)
mods = qr.get_matrix()
n = len(mods)

# 29×29 = 841 位 → 补零到整字节 → 106 字节 → base64 仅 144 字符，
# 塞进源码里毫无负担，还能一眼看出它没被改动过。
bits = "".join("1" if c else "0" for row in mods for c in row)
bits += "0" * ((8 - len(bits) % 8) % 8)
packed = bytes(int(bits[i:i + 8], 2) for i in range(0, len(bits), 8))
b64 = base64.b64encode(packed).decode("ascii")

ps = os.path.join(HERE, "poster.js")
js = open(ps, encoding="utf-8").read()

new_n = "var QR_N = %d;" % n
new_b = 'var QR_B64 = "%s";' % b64
js2, c1 = re.subn(r"var QR_N = \d+;", new_n, js)
js2, c2 = re.subn(r'var QR_B64 = "[^"]*";', new_b, js2)
if c1 != 1 or c2 != 1:
    print("在 poster.js 里定位二维码常量失败（QR_N %d 处 / QR_B64 %d 处）" % (c1, c2))
    sys.exit(1)

with open(ps, "w", encoding="utf-8") as fh:
    fh.write(js2)

# 顺手清掉历史遗留的图片版，避免以后又被误用
for old in ("vendor/qr.js", "vendor/qr.png"):
    p = os.path.join(HERE, old)
    if os.path.exists(p):
        os.remove(p)
        print("已清理旧文件:", old)

print("网址   :", url)
print("模块数 : %d x %d" % (n, n))
print("载荷   : %d bytes → base64 %d 字符" % (len(packed), len(b64)))
print("写入   :", ps)

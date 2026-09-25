# 给 index.html 的脚本引用打上内容版本戳（?v=<hash8>）。
# 运行： python _stamp.py   （部署前跑一次）
#
# 为什么需要：CDN 各边缘节点回源时间不一致。实测同一个 poster.js，
# 一个节点已拿到新版、另一个还是旧版 —— 于是出现「新 index.html + 旧 game.js」
# 的错配，表现为海报二维码又变回空白框，而且刷新几次时好时坏，极难排查。
# 内容变了 URL 就变，URL 变了就强制回源，部署才是原子的。
import re, os, sys, hashlib

# 本脚本位于 _tools/：项目根在上一层（HERE 始终指向项目根）
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = ["poster.js", "game.js", "vendor/three.min.js"]
idx = os.path.join(HERE, "index.html")

# 版本号取三个脚本内容的联合哈希：任一脚本变了，所有 URL 一起变，
# 避免出现「新 game.js + 旧 poster.js」这种半新半旧组合。
h = hashlib.sha1()
for rel in FILES:
    p = os.path.join(HERE, rel)
    if not os.path.exists(p):
        print("缺少文件:", rel); sys.exit(1)
    h.update(open(p, "rb").read())
ver = h.hexdigest()[:8]

html = open(idx, encoding="utf-8").read()
orig = html
for rel in FILES:
    # 先剥掉已有版本戳，再统一加上，保证重复运行结果一致
    pat = re.compile(r'(<script src="' + re.escape(rel) + r')(?:\?v=[0-9a-f]+)?("></script>)')
    if not pat.search(html):
        print("在 index.html 里找不到脚本引用:", rel); sys.exit(1)
    html = pat.sub(lambda m: m.group(1) + "?v=" + ver + m.group(2), html)

if html == orig:
    print("版本戳已是 v%s，无变化" % ver)
else:
    open(idx, "w", encoding="utf-8").write(html)
    print("已写入版本戳 v%s → index.html" % ver)

for rel in FILES:
    print("   %-22s %s" % (rel, hashlib.sha1(open(os.path.join(HERE, rel), "rb").read()).hexdigest()[:8]))

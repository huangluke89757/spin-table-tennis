# 把「改动前 / 改动后」两张截图拼成带标注的对照图（走查证据用）。
# 运行： python _tools/_end_center_diff.py
#
# 为什么标注要写进图里：截图会脱离对话被单独转发（卢克先生习惯直接看图）。
# 图上不写清「左边那 500px 空白是什么」，看图的人只会觉得"乱"，
# 却不知道该确认哪一处 —— 标注要点出**可核对的具体数字**。
import os, sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(HERE, "_shots")

# 中文标注必须用带 CJK 字形的字体，默认 PIL 字体画出来是方块
FONT_CANDIDATES = [
    "C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/simsun.ttc",
]


def load_font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


PAD = 26
GAP = 14
BAR = 46          # 每条标注条的高度
BG = (245, 245, 247)
FG = (26, 26, 32)
ACC = (176, 96, 12)     # 与游戏 accent（琥珀）同族，避免标注跳出色系

CASES = [
    ("1030x469", "challenge", "挑战模式"),
    ("1030x469", "practice", "练习模式"),
    ("1280x720", "challenge", "挑战模式 · 桌面"),
]

NOTE_BEFORE = "改动前：表格 1fr 列被撑到 527px —— 时间列(右)离拍准档(中)隔 500px 空白；左栏贴屏最左，按钮被顶到屏最底"
NOTE_AFTER = "改动后：两栏整体居中，留白对称 168/168px；1fr 收到 155px，时间列紧贴拍准档；时间戳不再折行，行高 38→26px"


def compose(case, mode, label):
    a = os.path.join(SHOTS, "62_cmp_before_%s_%s.png" % (case, mode))
    b = os.path.join(SHOTS, "62_cmp_after_%s_%s.png" % (case, mode))
    if not (os.path.exists(a) and os.path.exists(b)):
        print("缺文件，跳过:", case, mode); return None
    ia, ib = Image.open(a).convert("RGB"), Image.open(b).convert("RGB")
    W = max(ia.width, ib.width) + PAD * 2
    H = PAD * 2 + BAR * 2 + ia.height + ib.height + GAP
    cv = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(cv)
    f_title = load_font(19)
    f_note = load_font(15)

    y = PAD
    for img, tag, note in ((ia, "改动前", NOTE_BEFORE), (ib, "改动后", NOTE_AFTER)):
        d.text((PAD, y), tag, font=f_title, fill=ACC)
        tw = d.textlength(tag, font=f_title)
        d.text((PAD + tw + 14, y + 3), label + "　" + note, font=f_note, fill=FG)
        y += BAR
        cv.paste(img, (PAD, y))
        d.rectangle([PAD - 1, y - 1, PAD + img.width, y + img.height], outline=(200, 200, 205))
        y += img.height + GAP

    out = os.path.join(SHOTS, "63_diff_%s_%s.png" % (case, mode))
    cv.save(out)
    print("已生成", out)
    return out


if __name__ == "__main__":
    outs = [compose(c, m, l) for c, m, l in CASES]
    sys.exit(0 if all(outs) else 1)

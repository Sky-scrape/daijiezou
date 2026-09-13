# 从系统字体提取「节」的真实轮廓,转成 SVG path。
# 手搭矩形能过"笔画分离度"指标,但字形是否端正指标证明不了 —— 用真字形消除这个风险。
# 输出居中并缩放到指定方框内的 path d 字符串。
import os
import sys

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

FONT = 'C:/Windows/Fonts/simhei.ttf'
CHAR = sys.argv[1] if len(sys.argv) > 1 else '节'
BOX = float(sys.argv[2]) if len(sys.argv) > 2 else 300.0   # 目标方框边长
CX = float(sys.argv[3]) if len(sys.argv) > 3 else 256.0     # 目标中心 x
CY = float(sys.argv[4]) if len(sys.argv) > 4 else 256.0     # 目标中心 y

font = TTFont(FONT)
upm = font['head'].unitsPerEm
cmap = font.getBestCmap()
gname = cmap.get(ord(CHAR))
if gname is None:
    raise SystemExit(f'字体中无此字形: {CHAR}')

gs = font.getGlyphSet()
pen = SVGPathPen(gs)
gs[gname].draw(pen)
d = pen.getCommands()

# 量出真实墨迹边界(字形坐标系,y 向上)
from fontTools.pens.boundsPen import BoundsPen
bp = BoundsPen(gs)
gs[gname].draw(bp)
xMin, yMin, xMax, yMax = bp.bounds
w, h = xMax - xMin, yMax - yMin
scale = BOX / max(w, h)

# SVG y 轴向下 → 需翻转;并把墨迹中心对到 (CX, CY)
tx = CX - (xMin + w / 2) * scale
ty = CY + (yMin + h / 2) * scale

print(f'<!-- {CHAR} from SimHei, upm={upm}, bounds=({xMin},{yMin},{xMax},{yMax}) -->')
print(f'<g transform="translate({tx:.2f} {ty:.2f}) scale({scale:.5f} {-scale:.5f})">')
print(f'  <path d="{d}"/>')
print('</g>')

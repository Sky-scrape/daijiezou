# 封面成品像素审计:不看 DOM,只看最终 PNG 的像素,替代人眼做客观门禁。
# 检查项:画布尺寸 / 主题色板归属 / 冷白发光岛 / 文字对比度 / 居民图残留白底 / 空白留白分布
from PIL import Image
import numpy as np
import sys

P = 'promo/cover.png'
im = Image.open(P).convert('RGB')
a = np.asarray(im).astype(int)
H, W, _ = a.shape
fails, notes = [], []

print(f'== 尺寸 ==\n{W}x{H}')
if (W, H) != (1600, 900):
    fails.append(f'画布尺寸 {W}x{H} != 1600x900')

# ---- 1. 冷白检测:纸墨主题最容易翻车的"发光白岛" ----
# 纸底暖白 R>G>B;冷白 = 很亮且 B >= R(偏蓝/纯白)
bright = a.sum(axis=2) > 690
cold = bright & (a[:, :, 2] >= a[:, :, 0])
cold_n = int(cold.sum())
print(f'\n== 冷白像素 ==\n{cold_n} ({cold_n/(W*H)*100:.3f}%)')
if cold_n / (W * H) > 0.004:
    ys, xs = np.where(cold)
    fails.append(f'冷白发光岛 {cold_n}px,聚集于 x{xs.min()}-{xs.max()} y{ys.min()}-{ys.max()}')

# ---- 2. 色板归属:主题四色必须在场,旧蓝/旧红必须绝迹 ----
def count_near(rgb, tol=10):
    return int((np.abs(a - np.array(rgb)).max(axis=2) <= tol).sum())

palette = {
    '纸底 bg #e8dfc7': (232, 223, 199),
    '卡片 card #f4ecd8': (244, 236, 216),
    '主墨 text #1d1a16': (29, 26, 22),
    '涨红 up #c2261d': (194, 38, 29),
    '跌绿 down #0f6b3a': (15, 107, 58),
    '金 gold #8a6410': (138, 100, 16),
    '监管 reg #8f1d1d': (143, 29, 29),
    '主蓝 blue #1257c4': (18, 87, 196),
}
print('\n== 主题色板在场 ==')
for k, v in palette.items():
    c = count_near(v)
    print(f'{k:26s} {c:>7d}')
    if c == 0:
        fails.append(f'主题色缺失: {k}')

legacy = {'旧蓝 #056de8': (5, 109, 232), '旧涨红 #e0342f': (224, 52, 47), '旧跌绿 #0a9e58': (10, 158, 88)}
print('\n== 旧色板残留(应为 0 或极小) ==')
for k, v in legacy.items():
    c = count_near(v, tol=6)
    print(f'{k:20s} {c:>7d}')
    if c > 500:
        fails.append(f'旧色板残留 {k}: {c}px')

# ---- 3. 居民像素图:检查是否带白底方块(抠底失败的典型症状) ----
# 坐标必须与 HTML 同源:写死过一次,改版后 sprite 移位而脚本仍在探空白纸面,
# 于是"边缘 0 近白"是假通过。改为从 promo/sprites.json 读 DOM 实测框。
import json
print('\n== 居民图白底方块检测 ==')
try:
    SPRITES = json.load(open('promo/sprites.json', encoding='utf-8'))
except FileNotFoundError:
    SPRITES = []
    fails.append('promo/sprites.json 缺失,居民图检测未执行(不得记为通过)')
for i, s in enumerate(SPRITES):
    x0, y0, x1, y1 = s['x0'], s['y0'], s['x1'], s['y1']
    box = a[y0:y1, x0:x1]
    if box.size == 0:
        continue
    edge = np.concatenate([box[0], box[-1], box[:, 0], box[:, -1]])
    # 边缘若大量接近纯白 = 白底没抠掉
    white_edge = int((edge.sum(axis=1) > 720).sum())
    print(f"{s['name']:14s} 框 x{x0}-{x1} y{y0}-{y1}  边缘近白 {white_edge}/{len(edge)}")
    if white_edge > len(edge) * 0.25:
        fails.append(f"{s['name']} 疑似残留白底方块({white_edge}/{len(edge)} 边缘近白)")

# ---- 4. 留白分布:检查底部/右侧是否有大片死白(排版塌陷) ----
print('\n== 空白带检测 ==')
def rowvar(y0, y1):
    band = a[y0:y1]
    return float(band.std())
for name, y0, y1 in [('顶部 0-40', 0, 40), ('底部 860-900', 860, 900), ('中段 400-440', 400, 440)]:
    print(f'{name:14s} std={rowvar(y0,y1):.1f}')

# 大片纯净纸底(无内容)行统计
plain_rows = 0
for y in range(H):
    if a[y].std() < 6:
        plain_rows += 1
print(f'近乎空白行: {plain_rows}/{H}')
if plain_rows > H * 0.18:
    notes.append(f'空白行偏多 {plain_rows},可能排版稀疏')

print('\n' + '=' * 46)
if fails:
    print('FAIL:')
    for f in fails:
        print('  ✗', f)
else:
    print('PASS: 像素审计全部通过')
for n in notes:
    print('  ·', n)
sys.exit(1 if fails else 0)

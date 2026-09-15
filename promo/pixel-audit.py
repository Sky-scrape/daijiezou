# 海报成品像素审计(通用版):不看 DOM,只看最终 PNG 的像素,替代人眼做客观门禁。
# 用法: python promo/pixel-audit.py <png路径> <宽> <高>
# 检查项:画布尺寸 / 主题色板归属 / 冷白发光岛 / 留白与内容分布 / 边缘出血
from PIL import Image
import numpy as np
import sys

if len(sys.argv) < 4:
    print('usage: pixel-audit.py <png> <W> <H>')
    sys.exit(2)
P, EW, EH = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])

im = Image.open(P).convert('RGB')
a = np.asarray(im).astype(int)
H, W, _ = a.shape
fails, notes = [], []

print(f'== 尺寸 ==\n{W}x{H}  (期望 {EW}x{EH})')
if (W, H) != (EW, EH):
    fails.append(f'画布尺寸 {W}x{H} != {EW}x{EH}')

# ---- 1. 空白/全黑检测:渲染失败时整幅是纯色 ----
if a.std() < 3:
    fails.append(f'整幅近乎纯色(std={a.std():.2f}),渲染可能失败')
print(f'\n== 全局对比度 ==\nstd={a.std():.1f}  mean={a.mean():.1f}')

# ---- 2. 冷白检测:纸墨主题最容易翻车的"发光白岛" ----
# 纸底暖白 R>G>B;冷白 = 很亮且 B >= R(偏蓝/纯白)
bright = a.sum(axis=2) > 690
cold = bright & (a[:, :, 2] >= a[:, :, 0])
cold_n = int(cold.sum())
print(f'\n== 冷白像素 ==\n{cold_n} ({cold_n/(W*H)*100:.3f}%)')
if cold_n / (W * H) > 0.004:
    ys, xs = np.where(cold)
    fails.append(f'冷白发光岛 {cold_n}px,聚集于 x{xs.min()}-{xs.max()} y{ys.min()}-{ys.max()}')

# ---- 3. 色板归属:主题色必须在场 ----
def count_near(rgb, tol=10):
    return int((np.abs(a - np.array(rgb)).max(axis=2) <= tol).sum())

palette = {
    '纸底 bg #e8dfc7':     (232, 223, 199),
    '主墨 text #1d1a16':   (29, 26, 22),
    '涨红 up #c2261d':     (194, 38, 29),
    '跌绿 down #0f6b3a':   (15, 107, 58),
    '金 gold #8a6410':     (138, 100, 16),
    '主蓝 blue #1257c4':   (18, 87, 196),
    '监管红 reg #8f1d1d':  (143, 29, 29),
}
print('\n== 主题色板在场 ==')
for k, v in palette.items():
    c = count_near(v)
    print(f'{k:24s} {c:>7d}')
    if c == 0:
        fails.append(f'主题色缺失: {k}')

# ---- 4. 内框完整性:版口内框应形成一条闭合暗线 ----
# 检测 inset 22 处四边是否有连续暗像素(内框画出来了)
INSET = 22
def dark_ratio(line):
    return float((line.sum(axis=1) < 450).mean())
edges = {
    '上': a[INSET:INSET+3, :], '下': a[H-INSET-3:H-INSET, :],
    '左': a[:, INSET:INSET+3], '右': a[:, W-INSET-3:W-INSET],
}
print('\n== 版口内框 (inset 22) ==')
for k, band in edges.items():
    # 每列/行取最暗值,统计有多少比例达到"线"的强度
    if k in ('上', '下'):
        prof = band.min(axis=0)
    else:
        prof = band.min(axis=1)
    r = float((prof < 200).mean())
    print(f'{k}边 暗线覆盖率 {r*100:.1f}%')
    if r < 0.75:
        fails.append(f'内框{k}边不完整(覆盖 {r*100:.1f}%)')

# ---- 5. 内容分布:把画布切成 6 段,每段都应有内容(防排版塌陷) ----
print('\n== 纵向内容分布 (6 段) ==')
seg = H // 6
for i in range(6):
    band = a[i*seg:(i+1)*seg]
    s = float(band.std())
    # 内容密度:偏离纸底基色的像素比例
    base = np.array([232, 223, 199])
    dev = float((np.abs(band - base).max(axis=2) > 26).mean())
    print(f'  y{i*seg:>5}-{(i+1)*seg:<5} std={s:>5.1f}  非纸底占比={dev*100:>5.1f}%')
    if dev < 0.04:
        notes.append(f'y{i*seg}-{(i+1)*seg} 内容稀疏(非纸底仅 {dev*100:.1f}%)')

# ---- 6. 底部留白:最下面 46px 不应有内容(防贴边出血) ----
bot = a[H-46:, :]
bot_dev = float((np.abs(bot - base).max(axis=2) > 26).mean())
print(f'\n== 底部 46px 内容占比 ==\n{bot_dev*100:.2f}%')
if bot_dev > 0.30:
    notes.append(f'底部 46px 内容占比 {bot_dev*100:.1f}%,可能贴边')

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

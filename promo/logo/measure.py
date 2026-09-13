# 读 _r.b64(浏览器光栅化产物),客观测量各候选的小尺寸可辨识度与主题合规度。
# logo 的真考场是 32px / 18px:此处用"墨量占比"和"结构熵"量化,替代肉眼。
import base64
import io
import json
import os
import sys

import numpy as np
from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))
raw = open(os.path.join(here, '_r.b64'), encoding='utf-8').read().strip()
# eval 回传是被引号包裹的 JSON 字符串
data = json.loads(json.loads(raw))

PAPER = np.array([244, 236, 216])


def decode(b64):
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert('RGB')


def metrics(im):
    a = np.asarray(im).astype(int)
    # 墨量 = 与纸色差异明显的像素占比(前景覆盖率)
    diff = np.abs(a - PAPER).sum(axis=2)
    ink = (diff > 60)
    inkpct = ink.mean() * 100
    # 结构熵:灰度直方图熵,越高说明层次越多(小尺寸下过高=糊)
    g = a.mean(axis=2).astype(np.uint8)
    h = np.bincount(g.ravel(), minlength=256).astype(float)
    p = h[h > 0] / h.sum()
    ent = float(-(p * np.log2(p)).sum())
    # 边缘密度:相邻像素差,衡量细节量
    ex = np.abs(np.diff(g.astype(int), axis=1)).mean()
    ey = np.abs(np.diff(g.astype(int), axis=0)).mean()
    return inkpct, ent, (ex + ey) / 2


print(f"{'候选':22s} {'尺寸':>5s} {'墨量%':>7s} {'熵':>6s} {'边缘密度':>8s}")
print('-' * 56)
rows = {}
for f in data:
    rows[f] = {}
    for s in ['512', '32', '18']:
        im = decode(data[f][s])
        ink, ent, edge = metrics(im)
        rows[f][s] = (ink, ent, edge)
        print(f'{f:22s} {s:>5s} {ink:7.2f} {ent:6.2f} {edge:8.2f}')
        im.save(os.path.join(here, f"{f.replace('.svg','')}-{s}.png"))
    print()

print('=' * 56)
print('小尺寸判读(32px 为浏览器标签实际尺寸):')
for f, r in rows.items():
    ink32 = r['32'][0]
    drop = abs(r['32'][0] - r['512'][0])
    verdict = []
    if ink32 < 12:
        verdict.append('墨量过低=小图发虚')
    if ink32 > 62:
        verdict.append('墨量过高=糊成色块')
    if drop > 14:
        verdict.append(f'缩放后墨量漂移大({drop:.1f}pp)=细节丢失')
    print(f"  {f:22s} 32px墨量 {ink32:5.2f}%  漂移 {drop:5.2f}pp  "
          f"{'; '.join(verdict) if verdict else 'OK'}")

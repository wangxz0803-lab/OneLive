# -*- coding: utf-8 -*-
"""把 showcase/avatars/ 里的形象图换进 studio.html 的三路频道（以及手机/主播画面）。

用法：
  1) 把图片放进 showcase/avatars/，命名为 1.jpg / 2.jpg / 3.jpg（png 也行）
     —— 建议正面半身、背景越干净越好；纯绿背景会自动抠图。
  2) 运行：
     <m0-venv-python> showcase/set-avatars.py
  3) 刷新 showcase/studio.html 即可。

不带参数时按 1/2/3 顺序填三个频道；只放 1 张就三路都用它。
"""
import base64
import io
import os
import re
import sys

import cv2
import numpy as np

# Windows 控制台默认 GBK，打印 "Español" 的 ñ 会抛 UnicodeEncodeError 并中断替换
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(HERE, "studio.html")
AVDIR = os.path.join(HERE, "avatars")

# 频道 → 页面里 <img alt="..."> 的值（换图靠 alt 定位，改版式也不会错位）
SLOTS = [
    "English 频道数字人",
    "日本語 频道数字人",
    "Español 频道数字人",
]
EXTRA = ["原始主播画面", "手机端主播画面"]  # 用第 1 张


def load_any(stem):
    for ext in (".png", ".jpg", ".jpeg", ".webp", ".bmp"):
        p = os.path.join(AVDIR, stem + ext)
        if os.path.exists(p):
            img = cv2.imread(p, cv2.IMREAD_UNCHANGED)
            if img is not None:
                return img, os.path.basename(p)
    return None, None


def to_cutout(img, target=480):
    """有 alpha 就用；纯绿背景自动抠；否则原样保留。返回 png data URI。"""
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)

    if img.shape[2] == 4:                      # 已带透明通道
        rgba = img
    else:
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        green = cv2.inRange(hsv, np.array([35, 60, 40]), np.array([90, 255, 255]))
        if green.mean() > 25:                  # 绿幕占比够高才抠
            green = cv2.morphologyEx(green, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
            green = cv2.morphologyEx(green, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
            alpha = cv2.GaussianBlur(255 - green, (5, 5), 0)
            b, g, r = cv2.split(img.astype(np.int16))
            spill = np.clip(g - np.maximum(b, r), 0, 255)
            g = np.clip(g - spill * 0.85, 0, 255)
            img = cv2.merge([b.astype(np.uint8), g.astype(np.uint8), r.astype(np.uint8)])
            rgba = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
            rgba[:, :, 3] = alpha
        else:
            rgba = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)

    a = rgba[:, :, 3]
    ys, xs = np.where(a > 25)
    if len(ys):                                # 裁掉全透明边
        rgba = rgba[max(0, ys.min() - 4):ys.max() + 4, max(0, xs.min() - 4):xs.max() + 4]

    h, w = rgba.shape[:2]
    s = target / max(h, w)
    if s < 1:
        rgba = cv2.resize(rgba, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".png", rgba, [cv2.IMWRITE_PNG_COMPRESSION, 9])
    if not ok:
        raise RuntimeError("PNG 编码失败")
    return "data:image/png;base64," + base64.b64encode(buf).decode()


def replace_slot(html, alt, uri):
    """把 alt 匹配的 <img> 的 src 换掉。"""
    pat = re.compile(r'(<img\s[^>]*?src=")[^"]*("[^>]*?alt="' + re.escape(alt) + r'")')
    new, n = pat.subn(lambda m: m.group(1) + uri + m.group(2), html)
    if n == 0:  # src 在 alt 之后的写法
        pat2 = re.compile(r'(<img\s[^>]*?alt="' + re.escape(alt) + r'"[^>]*?src=")[^"]*(")')
        new, n = pat2.subn(lambda m: m.group(1) + uri + m.group(2), html)
    return new, n


def main():
    if not os.path.isdir(AVDIR):
        os.makedirs(AVDIR, exist_ok=True)
    if not os.path.exists(PAGE):
        sys.exit("找不到 studio.html：%s" % PAGE)

    imgs = []
    for i in (1, 2, 3):
        img, name = load_any(str(i))
        imgs.append((img, name))

    if all(im is None for im, _ in imgs):
        sys.exit("没找到图片。请把 1.jpg / 2.jpg / 3.jpg 放进：%s" % AVDIR)

    first = next(im for im, _ in imgs if im is not None)
    html = io.open(PAGE, encoding="utf-8").read()
    total = 0

    for idx, alt in enumerate(SLOTS):
        img, name = imgs[idx]
        if img is None:
            img, name = first, "（沿用第 1 张）"
        uri = to_cutout(img)
        html, n = replace_slot(html, alt, uri)
        total += n
        print("频道 %d  %-22s <- %s   替换 %d 处" % (idx + 1, alt, name, n))

    uri1 = to_cutout(first)
    for alt in EXTRA:
        html, n = replace_slot(html, alt, uri1)
        total += n
        print("       %-22s <- 第 1 张          替换 %d 处" % (alt, n))

    io.open(PAGE, "w", encoding="utf-8").write(html)
    print("\n完成：共替换 %d 处，页面 %.0f KB" % (total, os.path.getsize(PAGE) / 1024))
    print("刷新浏览器即可看到新形象：%s" % PAGE)


if __name__ == "__main__":
    main()

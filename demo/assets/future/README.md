# Future Experience 素材说明

这些素材用于 `demo/index.html` 的 Future Experience 概念层。

| 文件 | 用途 | 来源 |
| --- | --- | --- |
| `front.webp` | 正面主播机位 | 以 `japan-ja.jpg` 为身份、服装、商品和场景参考生成 |
| `side.webp` | 35° 侧面互动机位 | 同上 |
| `overhead.webp` | 俯拍商品机位 | 同上 |
| `spatial.webp` | 空间重建关键视觉 | 同上 |

当前文件是 AI 关键帧，不是真实多机位拍摄，也不是实时三维重建。界面必须保留 `CONCEPT / EMULATED` 标识。

终版建议使用 `docs/FUTURE_EXPERIENCE_V2.md` 中的三路同步视频方案，并合成为一个 `multi-angle-atlas.mp4`，由前端单路解码后裁出三个机位。

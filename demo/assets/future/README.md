# Future Experience 素材说明

这些素材用于 `demo/index.html` 的 Future Experience 概念层。

| 文件 | 用途 | 来源 |
| --- | --- | --- |
| `spatial-multiview-output.mp4` | 上海外滩约7.53秒连续环绕输出示意 | 用户提供的竖屏即梦素材裁去开头0.5秒后，本地规范化为1280 × 720、30fps静音H.264；每3帧设置关键帧，供环绕视角低延迟定位，竖屏主体完整保留，左右使用同源模糊延展 |
| `orbit-left.jpg` | 左前概念机位输入 | 从裁切后的环绕素材0.2秒抽帧 |
| `orbit-front.jpg` | 正面概念机位输入与视频封面 | 从裁切后的环绕素材3.75秒抽帧 |
| `orbit-right.jpg` | 右前概念机位输入 | 从裁切后的环绕素材7.2秒抽帧 |
| `spatial-audio.m4a` | 观众端独立素材音频 | 从环绕视频复制AAC音轨；不是空间音频 |
| `presenter-natural-lite.glb` | 未来体验当前使用的轻量3D人物 | 从自然站姿模型生成1024纹理与量化网格，约6.1MB，用于缩短首次加载 |
| `shanghai-bund-360-v2.png` | 当前3D人物空间使用的2:1外滩全景 | 基于原全景用内置图像编辑能力重制，强化石板地面、连续栏杆与建筑细节；仍属于概念全景，不是真实空间重建 |
| `future-3d.bundle.js`（位于 `demo/`） | 浏览器端 Three.js 与 GLB 加载器 | 已打包进仓库，运行时不依赖 CDN |

提交包只包含页面实际引用的上述素材；FBX、候选 GLB、预览图和旧全景等实验文件不进入 GitHub 演示提交。当前 GLB 人物可由浏览器从水平与俯仰方向观察；外滩全景没有真实空间深度，环绕视频与抽帧也不是真实多机位拍摄或实时三维重建。三台相机仍是采集拓扑示意。界面必须区分 `PRE-GENERATED 3D / LOCAL LIVE RENDER` 与 `CONCEPT / EMULATED PIPELINE`。

当前实现与能力边界见 `docs/FUTURE_EXPERIENCE_V3.md`。

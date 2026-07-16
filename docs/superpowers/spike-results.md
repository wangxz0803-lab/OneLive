# M0 Spike 结果（真实测量，禁止编造）

日期：
执行环境：Intel Arc 核显 / 32GB / Windows 11 / Python 3.12

## 1. LivePortrait 推理基准
| 配置 | EP | 分辨率 | 单路 fps | 三路每路 fps | 备注 |
| --- | --- | --- | --- | --- | --- |
| （待填） | | | | | |

### 模型清单（Task 2 实测，2026-07-16）

来源：`git clone --depth 1 warmshao/FasterLivePortrait` → `engine/FasterLivePortrait/`；
`hf download warmshao/FasterLivePortrait` → `engine/models/liveportrait/`（共 2.9GB，含 .cache）。

ONNX 文件（相对 `engine/models/liveportrait/`，du -h 实测）：

| 文件 | 大小 |
| --- | --- |
| liveportrait_onnx/appearance_feature_extractor.onnx | 3.3M |
| liveportrait_onnx/motion_extractor.onnx | 108M |
| liveportrait_onnx/warping_spade.onnx | 402M |
| liveportrait_onnx/warping_spade-fix.onnx | 402M |
| liveportrait_onnx/stitching.onnx | 180K |
| liveportrait_onnx/stitching_eye.onnx | 568K |
| liveportrait_onnx/stitching_lip.onnx | 148K |
| liveportrait_onnx/landmark.onnx | 110M |
| liveportrait_onnx/retinaface_det_static.onnx | 17M |
| liveportrait_onnx/face_2dpose_106_static.onnx | 4.9M |
| liveportrait_animal_onnx/*（7 个 onnx + xpose.pth，动物模型，本 spike 不用） | ~915M |
| liveportrait_animal_onnx_v1.1/*（6 个 onnx） | ~517M |

`configs/onnx_infer.yaml` 需要的 9 个人像模型全部在 `liveportrait_onnx/` 下齐备。
另含 `grid_sample_3d_plugin.dll/.so`（TensorRT 插件，DirectML 不用）和一个 cp310 的
onnxruntime-gpu wheel（忽略，勿装）。

### 管线 API 地图（Task 3-5 用）

- 管线类：`FasterLivePortraitPipeline`，import 路径
  `src/pipelines/faster_live_portrait_pipeline.py`（`from src.pipelines.faster_live_portrait_pipeline import FasterLivePortraitPipeline`）。
- 配置：`configs/onnx_infer.yaml`。结构：`models.<name>.{name, predict_type: "ort", model_path}`，
  模型路径默认指向 `./checkpoints/liveportrait_onnx/*.onnx`（相对 repo 根），Task 3 需改为
  `../models/liveportrait/liveportrait_onnx/`。另有 `crop_params` 与 `infer_params`（含
  flag_stitching / flag_pasteback / flag_relative_motion 等开关）。
  `onnx_mp_infer.yaml` 变体用 MediaPipe 代替 insightface 做人脸检测（`predict_type: "mp"`）。
- **ORT session 创建点（Task 3 改 EP 的位置）**：`src/models/predictor.py:183-190`，
  `OnnxRuntimePredictor.__init__` 硬编码
  `providers = ['CUDAExecutionProvider', 'CoreMLExecutionProvider', 'CPUExecutionProvider']`，
  L190 `onnxruntime.InferenceSession(model_path, providers=providers, sess_options=opts)`。
  改成 `['DmlExecutionProvider', 'CPUExecutionProvider']` 即可。
- **额外 CUDA 硬编码（Task 3 必须一并处理，CPU torch 下会直接抛异常）**：
  - `src/models/base_model.py:14-15`：`torch.cuda.current_device()` / `torch.cuda.current_stream()`，
    所有 ort 模型基类无条件执行。
  - `src/models/face_analysis_model.py:93`：同样 `torch.cuda.current_device()`。
  - 管线自身 `faster_live_portrait_pipeline.py:111` 会优雅回退 cpu（`torch.cuda.is_available()` 判断），无需改。
- run.py 入口参数：`--src_image`（默认 assets/examples/source/s12.jpg）、`--dri_video`、
  `--cfg`（默认 configs/onnx_infer.yaml）、`--realtime`、`--animal`、`--paste_back`。
  dri_video 传 `.pkl` 走 run_with_pkl（离线动作模板回放）。
- 关键方法：`pipe.prepare_source(source_path, realtime=bool)` 一次性预处理 source
  （填充 `pipe.src_imgs` / `pipe.src_infos` 列表）；逐帧
  `pipe.run(driving_frame_bgr, img_src, src_info, first_frame=bool)` →
  `(dri_crop, out_crop, out_org, dri_motion_info)`；或
  `pipe.run_with_pkl(dri_motion_info, img_src, src_info, first_frame=bool)` → `(out_crop, out_org)`。
- **多 source 支持（Task 4 三路基准）**：`run()` 的 img_src/src_info 是显式参数，单个 pipeline
  实例可对多个已 prepare 的 source 逐帧驱动；但 `prepare_source` 每次调用会清空重建
  `self.src_imgs/src_infos`，多 source 需在调用后自行保存副本（或每路各建一个 pipeline 实例——
  ort session 有按 model_path 的单例缓存 `OnnxRuntimePredictorSingleton`，多实例不会重复加载模型）。
  注意 pipeline 持有逐帧平滑状态（OneEuroFilter、R_d_0 等），三路独立驱动时建议每路一个实例。
- 依赖实况：pipeline 模块**硬 import torch**（预处理/pasteback 用 torch 张量运算），已装
  CPU 版 torch 2.13.0+cpu（未装 CUDA）；另装 torchgeometry、scikit-image、ffmpeg-python、
  onnx、insightface 1.0.1（--no-deps + requests/easydict/prettytable，避免其依赖拖入
  onnxruntime CPU 版覆盖 directml）、mediapipe 0.10.35。装完实测
  `ort.get_available_providers()` = `['DmlExecutionProvider', 'CPUExecutionProvider']`，未被覆盖。
  pipeline import 与 `run.py --help` 均验证通过（未跑推理，Task 3 做）。

## 2. TTS→嘴型驱动
- 生成语言/音色：
- 口型与音频包络主观同步性（好/可接受/差）：
- 与头部动作迁移叠加是否冲突：
- 结论：

## 3. 浏览器预览通路
- 传输方式：WS + JPEG
- 端到端显示 fps（单路 512px）：
- 显著延迟（主观，ms 级估计）：

## 4. 决策门结论
- 单路 fps 是否 ≥15：
- 决策（本地三路 / 本地一路+边缘两路 / 三路常驻边缘）：
- 依据：

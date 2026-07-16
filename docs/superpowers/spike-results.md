# M0 Spike 结果（真实测量，禁止编造）

日期：
执行环境：Intel Arc 核显 / 32GB / Windows 11 / Python 3.12

## 1. LivePortrait 推理基准
| 配置 | EP | 分辨率 | 单路 fps | 三路每路 fps | 备注 |
| --- | --- | --- | --- | --- | --- |
| 离线 demo（s10.jpg + d14.mp4 全 536 帧，pasteback 开） | 混合：DML(metacmd off) + OpenVINO-GPU fp16 + torch CPU GridSample | 512 crop（org 1092x1280） | **1.25**（run.py 全程中值 799.4 ms/帧；8 帧短 smoke 稳态 580ms ≈ 1.7） | 未测（Task 4） | Task 3 实测 2026-07-16，详见下方备注 |
| 同上但 warping_spade 整模型纯 CPU（rung 1） | DML + CPU 整体回退 | 512 crop | 0.13（~8s/帧） | - | warping_spade 占 >95% 耗时 |

### Task 3 备注：后端选型过程与坑（全部实测）

**最终 EP 组合（按模型）：**

| 模型 | 后端 |
| --- | --- |
| motion_extractor / landmark / retinaface_det / face_2dpose / app_feat_extractor / stitching×3 | ORT DirectML（`{"device_id":0, "disable_metacommands":True}` + CPU fallback） |
| warping_spade partA（dense-motion 前段，含 7D Tile） | ORT DirectML（同上），~28ms |
| warping_spade 两个 5D GridSample | torch CPU `F.grid_sample`，~18ms + ~114ms |
| warping_spade partB（dense-motion 后段，5D conv hourglass） | OpenVINO GPU（默认 fp16），~161ms |
| warping_spade partC（SPADE 解码器） | OpenVINO GPU（默认 fp16），~229ms |

warping_spade 用 `engine/tools/split_warping_spade.py` 预切分成 3 个 ONNX（写入模型目录，
`warping_spade_dml_part{a,b,c}.onnx` + `warping_spade_dml_split.json`），由 patch 里新增的
`SplitWarpingSpadePredictor`（predictor.py）按 manifest 顺序执行；`ONELIVE_WARPING_SPLIT=0`
可关掉回到整模型 ORT 路径。环境：onnxruntime-directml 1.24.4 + openvino 2026.2.1 **并存**
（openvino 是独立包不与 ort 冲突；装完复测 providers 仍为 `['DmlExecutionProvider',
'CPUExecutionProvider']`，mediapipe/insightface import 正常）。未安装 onnxruntime-openvino
（无需换包）。

**坑 1（最重要）：Intel Arc iGPU 驱动的 DML metacommands 数值损坏。**
默认参数下 DirectML 所有模型输出全错且**不确定**（同输入 stitching.onnx 两次运行 max diff
0.15~0.17；与 CPU 差 0.84）。症状：retinaface 在 DML 上 max_score=0.0347（CPU 0.7613）→
`prepare_source` 报 "No face detected in the this image."。加
`disable_metacommands: True` 后全部 8 个模型与 CPU 位级/1e-4 内一致且确定。**Task 4/6 任何
DML session 都必须带此参数。**

**坑 2：warping_spade.onnx（5D GridSample×2）DML session 创建直接失败**，报错被 GBK 编码
二次污染（Python 侧只见 `EP Error 'utf-8' codec can't decode byte 0xb6 in position 290`），
用 `UnicodeDecodeError.object.decode('gbk')` 还原出真实错误：
`Exception during initialization: ...\dml\DmlExecutionProvider\src\MLOperatorAuthorImpl.cpp(2818)\onnxruntime_pybind11_state.pyd!... Exception(2) tid(...) 80004005`
（HRESULT 0x80004005，`disable_metacommands` 也救不了）。ort 自动整体回退纯 CPU：4~8s/帧。
CPU profiling：Conv+FusedConv 占 87%，GridSample 仅 3.7%（~128ms/run）——这是切图方案的依据。

**坑 3：`warping_spade-fix.onnx` 不能用于 ort**：内含自定义域 op `GridSample3D`（TensorRT
插件专用），ort 加载报 `INVALID_GRAPH ... ("/dense_motion_network/GridSample", GridSample3D, "", -1)`。

**坑 4：OpenVINO 原生前端拒读整个 warping_spade.onnx**：
`GridSample-16 ... Check 'data_shape.rank().compatible(4)' failed ... The supported shape of the input data tensor is 4D.`
切分后 partB/partC 可编译；partA 在 OV GPU 编译失败（7D Tile：
`[GPU] No layout format available for tile:/dense_motion_network/Tile_4 ... format: bfuwzyx`），
所以 partA 留在 DML。另：OV GPU 编译过程会在 cwd 写一个非致命的 `kernel.errors.txt`
（IGC 诊断 "Input V38 intersects with V37"），输出已验证正确，可忽略。

**精度验证：** 切分路径（fp16 OV GPU）与整模型 ORT CPU 对同一随机输入 max_abs_diff=0.12 /
mean=0.007（out 幅值 ~1.0，源于 fp16）；渲染帧与全精度参考帧肉眼无差别。
`ONELIVE_OV_PRECISION=f32` 可强制 fp32，但 partB 161→211ms、partC 229→499ms，不值。
DML 部分与 CPU 一致到 1e-4 以内。

**单模型 DML 稳态延迟（随机输入，10 次中值）：** motion_extractor 26ms、landmark 22ms、
retinaface 26ms、face_2dpose 3ms、stitching ~0ms、app_feat_extractor 103ms（仅 source
预处理时跑一次）。即 warping 之外每帧共 ~80ms，warping_spade ~500-610ms 占大头。

**离线 demo 输出证据（Step 2）：** `engine/FasterLivePortrait/results/2026-07-16-212842/`
（gitignored，本机留存）：`s10.jpg-d14.mp4-crop.mp4`（1024x512 双拼，536 帧 @30fps，17.9s，
6.78MB）、`s10.jpg-d14.mp4-org.mp4`（1092x1280 pasteback，536 帧，13.8MB）、
`*-audio.mp4` 两个（ffmpeg 混音后）、`d14.mp4.pkl`（驱动动作模板，486KB，Task 4/5 可用
`run_with_pkl` 复放，省掉逐帧人脸检测）。run.py 汇总行原文：
`inference median time: 799.4246482849121 ms/frame, mean time: 799.2852036632709 ms/frame`。
渲染帧肉眼验证：源像（戴珍珠耳环的少女）跟随驱动视频表情/头姿，pasteback 无缝。
注意 run.py 结尾 `video_has_audio` 依赖 PATH 上的 ffprobe（不存在时原代码直接崩、丢 pkl 和
汇总行——patch 已把 FileNotFoundError 捕获为"无音频"，跑 demo 时把 ffmpeg bin 目录加进 PATH
即可正常混音）。

**警示（Task 4 基准与决策门）：** 单路 1.25~1.7fps << 15fps 决策门线。剩余优化空间有限
（partC fp16 已用；NPU 未试；换 OV EP 整包收益存疑，因为 GridSample/7D Tile 仍需回 CPU）。
按 spike 计划这指向"本地一路也吃紧 → 边缘 GPU"方向，但正式结论由 Task 4/7 出。

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
- **颜色顺序（Task 3 实测确认）**：`run()` / `run_with_pkl()` 返回的 out_crop / out_org 是
  **RGB**。用 cv2 VideoWriter / imwrite / JPEG 编码前必须 `cv2.cvtColor(x, cv2.COLOR_RGB2BGR)`
  （证据：run.py:107-114 写视频前统一做了 RGB2BGR）。Task 6 的 WS+JPEG 通路同样要转。
- **嘴型重定向入口（Task 5 用）**：驱动帧的 lip ratio 在 pipeline L537
  `calc_lip_close_ratio` 计算；消费在 `_run` L454-457（`calc_combined_lip_ratio` →
  `retarget_lip`），由 `infer_params.flag_lip_retargeting` 开关控制。注意该值是**landmark
  闭合比**（close-ratio），不是 0..1 的开口度——Task 5 的音频包络曲线需要先标定/映射再喂入。
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

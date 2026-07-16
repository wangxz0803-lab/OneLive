# M0 Spike 结果（真实测量，禁止编造）

日期：2026-07-16
执行环境：Intel Arc 核显 / 32GB / Windows 11 / Python 3.12（engine/.venv）；
onnxruntime-directml 1.24.4、openvino 2026.2.1、torch 2.13.0+cpu、
opencv-python 5.0.0.93、numpy 2.5.1、ffmpeg 8.1.2（winget，PATH 外绝对路径调用）

## 1. LivePortrait 推理基准
| 配置 | EP | 分辨率 | 单路 fps | 三路每路 fps | 备注 |
| --- | --- | --- | --- | --- | --- |
| 离线 demo（s10.jpg + d14.mp4 全 536 帧，pasteback 开） | 混合：DML(metacmd off) + OpenVINO-GPU fp16 + torch CPU GridSample | 512 crop（org 1092x1280） | **1.25**（run.py 全程中值 799.4 ms/帧；8 帧短 smoke 稳态 580ms ≈ 1.7） | 见 Task 4 行 | Task 3 实测 2026-07-16，详见下方备注 |
| 同上但 warping_spade 整模型纯 CPU（rung 1） | DML + CPU 整体回退 | 512 crop | 0.13（~8s/帧） | - | warping_spade 占 >95% 耗时 |
| 1路 round-robin（s0.jpg + d14.mp4，realtime，pasteback 关） | 混合: DML(metacmd off)+OV-GPU fp16+torch CPU GridSample(split) | 512 crop | **1.52** | 见三路行 | 300 帧计入统计（预热 30 帧丢弃），每驱动帧 avg 659/p50 660/p95 771 ms |
| 3路 round-robin（s0.jpg+s1.jpg+s10.jpg + d14.mp4，realtime，pasteback 关） | 混合: DML(metacmd off)+OV-GPU fp16+torch CPU GridSample(split) | 512 crop | 见单路行 | **0.46** | 150 帧计入统计（预热 30 帧丢弃），每驱动帧 avg 2160/p50 2163/p95 2401 ms |

### Task 4 备注：基准方法与原始数据（`engine/bench/bench_liveportrait.py`，实测 2026-07-16）

**方法：** 每路（source）一个独立 `FasterLivePortraitPipeline` 实例（平滑状态隔离；
ONNX session 按 model_path 单例缓存，权重不重复加载），`prepare_source(realtime=True)`
后立即快照 `(src_imgs[0], src_infos[0])`。驱动视频 d14.mp4（536 帧 @30fps）逐帧读取，
每个驱动帧按 round-robin 顺序渲染全部路，`flag_pasteback=False`（只出 512 crop）。
前 30 个驱动帧为预热、不计入统计。每路有效 fps = 1000 / 每驱动帧平均总耗时
（每个驱动帧所有路各渲染一次）。**不用多线程**：切分后的 warping_spade predictor 是按
model_path 共享的单例且 `predict()` 内部持锁（OV InferRequest 非线程安全），并发流会在
占 >85% 耗时的 warping_spade 上串行化，线程只增调度开销不增吞吐——所以三路就按顺序
round-robin 测，结果即多路真实吞吐上界。

**一次性成本（prepare）：** 首个 pipeline 构造（含全部 ONNX session 创建/EP 编译）
~4.4-4.5s；后续实例 ~4ms（session 单例命中）。`prepare_source` 首路 760-902ms，
后续路 224-264ms（app_feat_extractor 已预热）。

**单路原始输出（--sources 1 --frames 300 --warmup 30）：**
`路数=1 计入统计驱动帧=300 无脸帧=0 总墙钟=218.7s；每驱动帧 avg=659.0 ms p50=659.7 ms
p95=770.6 ms；每路有效 fps=1.52`。（与 Task 3 离线 demo 799ms/帧一致量级；本基准
pasteback 关、无视频编码，故略快。）

**三路原始输出（--sources 3 --frames 150 --warmup 30）：** 300 帧预计 >10min，按计划
降为 150 帧（>100 帧下限）。`路数=3 计入统计驱动帧=150 无脸帧=0 总墙钟=390.0s；
每驱动帧(3路) avg=2160.5 ms p50=2163.1 ms p95=2400.8 ms；每路有效 fps=0.46。
分路 avg：s0.jpg 686.3ms / s1.jpg 735.4ms / s10.jpg 738.8ms`。三路总耗时 ≈ 3×单路
（2160 ≈ 3×686~739），确认 GPU 已饱和、多路无并行红利，且相比单路基准每路还慢了
4-12%（缓存/调度竞争）。

**决策门读数：** 单路 1.52 fps << 15 fps 门线（差一个数量级）；三路每路 0.46 fps。
本地 Arc 核显连一路都远不达标，指向"边缘 GPU"方向；正式结论 Task 7 出。

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
`SplitWarpingSpadePredictor`（predictor.py）按 manifest 顺序执行（GridSample 的
mode/padding_mode/align_corners 属性也序列化在 manifest 里，predictor 按 manifest 执行而非
硬编码）；`ONELIVE_WARPING_SPLIT=0` 可关掉回到整模型 ORT 路径；`ONELIVE_ORT_CPU_ONLY`
（逗号分隔的模型文件名子串）可把任意 ORT 模型强制到纯 CPU（调试用）。
**Task 4 注意：split predictor 是按 model_path 共享的单例，`predict()` 内部持锁——多路并发
会在 warping_spade 上串行化（OV InferRequest 非线程安全，锁是必须的），基准设计需按此预期。**环境：onnxruntime-directml 1.24.4 + openvino 2026.2.1 **并存**
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

## 2. TTS→嘴型驱动（Task 5 实测 2026-07-16）

- 生成语言/音色：英语 / edge-tts `en-US-JennyNeural`（需联网，本机可用）。
  文本 ~6.65s → 16kHz 单声道 wav（ffmpeg 转码）→ 25fps 下 166 帧曲线。
- 曲线算法：`engine/lipsync/audio_to_lip_curve`（RMS 包络按帧粒度 → 峰值归一化 0..1 →
  不对称 EMA 平滑，attack 0.55 / release 0.25，张嘴快闭嘴慢）。TDD：2 个 pytest 用例
  先 FAIL（ModuleNotFoundError）后 PASS（`engine/tests/test_audio_lip.py`，2 passed）。
- **注入机制**：不用 monkey-patch——用 d14 动作模板 pkl 回放（`run_with_pkl`），逐帧把
  `dri_motion_info[2]`（驱动 lip close-ratio，1x1）替换为音频曲线映射值；另给 clone 加了
  一个 opt-in 开关 `infer_params.flag_lip_retarget_keep_motion`（默认关、不影响原行为）：
  开启时 (a) 抑制驱动视频自身的嘴部 exp（idx 6/12/14/17/19/20 回退到 source exp），
  (b) retarget 分支不再 `x_s + lip_delta`（原逻辑会丢掉整段头部动作），改为在动画后
  keypoints 上叠加 `x_d_i_new + lip_delta`。改动 15 行，已并入
  `engine/patches/faster-live-portrait-dml.patch`。
- **标定**（必要！lip ratio 是 landmark 闭合比不是 0..1 开口度）：d14 全 536 帧的
  `calc_lip_close_ratio` 分布 min 0.00013 / 中位 0.0022 / p95 0.1815 / max 0.2163
  （值越大嘴越开）。映射：曲线 0 → p05=0.00071（闭），1 → p95=0.18153（开）。
- 渲染证据：`engine/out/lip_drive_test.mp4`（注入+TTS 音轨，166 帧 @25fps，512 crop）、
  `lip_drive_control.mp4`（对照组：lip retargeting 关、嘴跟随 d14 原动作，同 166 帧序列
  逐帧可比）、`lip_curve.npz`；渲染 633/635 ms/帧（与 Task 4 基准一致，lip retarget
  开销可忽略：stitching_lip 模型 ~0ms 量级）。脚本 `engine/lipsync/experiment_lip_drive.py`。
- **帧级对比（提帧目视，engine/out/cmp/）**：
  - 响音帧 f9 / f95（曲线 0.71/0.73）：注入组嘴唇明显张开、露齿；对照组同帧嘴闭合
    → 张嘴确由音频注入产生，非驱动视频残留。
  - 静音帧 f75（曲线 0.008）：注入组嘴完全闭合；对照组同帧嘴微张（d14 原动作）
    → 静音压嘴生效，驱动视频嘴型已被成功抑制。
  - f4（曲线 0）双方都闭合；f34（曲线 0.74）注入组微张、露齿缝。
- 口型与音频包络主观同步性：**可接受偏好**——开合状态与曲线逐帧吻合（按构造帧对齐，
  上述 5 个采样点全部符合预期）；幅度偏保守（曲线峰值 0.74 × p95 标定 → 张开为
  "说话微张"而非大开口，可通过把上限映射到 max 0.216 或外推放大）。
- 与头部动作迁移叠加是否冲突：**不冲突**。f150 头部姿态相对 f4 明显转动/低头（跟随
  d14），且注入组与对照组同帧头姿完全一致；嘴部区域无撕裂/伪影，唇形自然。
  注意：原版 LivePortrait 的 lip retarget 在 relative motion 下会直接丢弃头部动作
  （`x_d_i_new = x_s + lip_delta`），必须用上述 keep_motion 改动才能叠加。
- 结论：**可行**。TTS 包络 → 标定映射 → lip ratio 注入即可在保留头部动作迁移的同时用
  音频接管嘴型，渲染成本不变。M1 改造量小：曲线模块已成品；管线侧只需 15 行 patch
  （已完成）+ 实时路径把 `run()` 内部算出的驱动 lip ratio 替换为音频值（同一入口，
  加一个可选参数即可）；遗留调优项 = 开口幅度映射上限、音素级口型（当前仅开合度，
  无唇形差异——直播够用，特写镜头偏机械）。
- **M1 附注（评审补充）：**
  - `audio_to_lip_curve` 的 peak 归一化是"整段离线"设计——需要完整音频求 max，
    不能流式；M1 实时版需改为固定 dBFS 参考或因果 AGC（TTS 响度可控，固定参考可行）。
    上文"曲线模块已成品"仅指离线回放场景。
  - 实时路径的标定来源：没有驱动视频可标定 p05/p95 时，闭合端可用源图自身
    `calc_lip_close_ratio`，张开端用固定常量或按形象离线标定一次。
  - keep_motion 分支的 lip_delta 是在旋转后 keypoints 上叠加（与上游 absolute 分支
    同性质），大幅度转头 + 音频驱动嘴型属未测区域，M1 需早测；若出伪影，将 delta
    随 R_new 旋转。

## 3. 浏览器预览通路（Task 6 实测 2026-07-17）
- 传输方式：WS + JPEG（`engine/preview/server.py`，FastAPI；`GET /` 出
  `index.html`（canvas + createImageBitmap 客户端），`WS /ws` 推 JPEG q80 二进制；
  推理在 `run_in_executor` 线程里跑，事件循环保持响应）。
  验证探针：`engine/preview/ws_probe.py --url ws://127.0.0.1:8891/ws --count N
  [--save-dir ... --prefix ...]`（无浏览器环境程序化验证，可复跑）。
- **通路健全性（synthetic 模式，512x512 合成帧，25fps 目标节拍）**：客户端到达
  fps = **25.11**（100 帧）/ 24.78（重连后二次 30 帧），服务端逐 25 帧发送 fps
  24.65~25.99；JPEG 平均 ~7.9KB/帧。断连/重连（浏览器刷新等价场景）已验证：
  两次顺序连接均正常，WebSocketDisconnect 干净处理。
- **端到端显示 fps（pipeline 模式，单路 512px，s10.jpg + d14.mp4 循环）**：
  客户端到达 fps = **1.90**（15 帧，首末到达间隔 7.37s）；服务端逐 5 帧发送 fps
  1.64 / 1.89 / 1.89。比 Task 4 基准 1.52 略快（仅 15 帧、取 d14 前段驱动帧，
  且 fps 从首帧到达起算，不含 first_frame 帧成本；量级一致）。JPEG 平均
  **~38.3KB/帧**（真实人像内容比合成帧大 ~5 倍）。帧证据：
  `engine/out/preview_pipeline_f0.png` / `_f14.png`，均为正常渲染的人像
  （戴珍珠耳环的少女，颜色正确即 RGB→BGR 转换无误），f0 与 f14 头姿/构图
  有可见差异（跟随 d14 前段动作）。
- 显著延迟（主观，ms 级估计）：同机回环下 WS 传输 + JPEG 编解码开销
  ≈ 每帧编码 <5ms + 8~38KB 回环传输（亚毫秒级），相对推理成本（~530-660ms/帧）
  可忽略——synthetic 模式稳定 25fps 证明传输通路不是瓶颈，
  **pipeline 预览 fps == 推理 fps**。感知延迟由"渲染一帧要 ~0.5-0.7s"主导
  （画面为 ~1.9fps 幻灯片式），非传输引入。
- **M1 附注（评审补充）：** 预览服务当前为单客户端设计——`infer_lock` 只在数据竞争
  层面防止并发交叉调用；多客户端仍会互相污染 pipeline 平滑状态（OneEuroFilter 等）
  且分摊吞吐。M1 需反转为"每频道常驻 producer + 订阅者扇出"结构。

## 4. 决策门结论（2026-07-17，基于 §1-§3 实测）
- 单路 fps 是否 ≥15：**否**。单路 1.52 fps（§1，300 帧计入统计，每驱动帧 avg 659 /
  p95 771 ms），距 15 fps 门线差一个数量级。
- 决策（本地三路 / 本地一路+边缘两路 / 三路常驻边缘）：**三路常驻边缘 GPU；本地 Arc
  保留单路低速链路，用于 Demo 的 Local⇄Edge 真实对比**（即 spec §4.3 的 <15fps 分支）。
- 依据：
  - **帧率读数（§1）**：单路 1.52 fps；三路每路 0.46 fps（150 帧，每驱动帧 avg
    2160 ms ≈ 3×单路分路 686~739 ms），GPU 已饱和、无并行红利，且三路下每路比
    单路基准还慢 4-12%。本地 Arc 连一路都远不达标，"本地三路"与"本地一路+边缘两路"
    两个分支均被排除；边缘两路方案也无意义——本地那"一路"同样不可用作正式频道。
  - **渲染方案本身已验证，换的只是算力位置**：TTS→嘴型可行（§2：15 行 opt-in patch
    注入、p05=0.00071 / p95=0.18153 标定映射，同步性可接受偏好、与头部动作迁移不
    冲突）；浏览器预览通路可行（§3：synthetic 25.11 fps 证明传输非瓶颈，pipeline
    1.90 fps == 推理速度）。瓶颈完全在推理算力，不在管线/嘴型/传输方案——迁到边缘
    GPU 属 spec"方案 C 降级、架构不变"路径。
- **M1 含义：**
  - 边缘节点需 NVIDIA GPU（4090 级）：直接走 FasterLivePortrait 上游 CUDA/TensorRT
    路径（`warping_spade-fix.onnx` + grid_sample_3d TensorRT 插件本就为此准备，见
    §1 坑 3 与模型清单），**无需**本地这套 split/DML 工程。目标：单卡三路每路
    ≥15 fps（上游 TensorRT 报告的单路帧率远高于此，三路并发需 M1 实测确认）。
  - 本地路径复用本 spike 的 split/DML 成果，作为 Demo 中"Local 慢"的真实对比链路
    （~1.5 fps 幻灯片效果本身就是 Edge 价值的展示素材）。
  - 嘴型/预览模块（§2/§3）与算力位置无关，边缘部署直接沿用；各自的 M1 遗留项见
    对应小节的"M1 附注"。

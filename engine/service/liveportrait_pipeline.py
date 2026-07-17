"""把 M0 的 FasterLivePortrait patched clone 适配成 ChannelWorker 的 pipeline 接口。

依赖 M0 资产目录（环境变量 ONELIVE_M0_ENGINE 指向 .worktrees/v2-m0-spike/engine）。
遵守 M0 API 地图：chdir 到 clone 目录、prepare_source 后立即快照、
run() 输出 RGB、首次成功推理前每次传 first_frame=True（无脸首帧不能吞掉初始化）。

无脸返回形态（实测源码确认）：run() 对无脸驱动帧返回 (None, None, None, None)
4 元组而不是整体 None——下方两个判断都保留（ret is None 为防御，out_crop is None
是实际命中的分支），映射为 return None → worker 计 skipped。
注意：无脸→None 仅适用于首次检测到人脸之前的帧；已跟踪后中途丢脸不会返回
None（上游行为），Task 6 摄像头测试需注意。
"""

import os
import sys
from pathlib import Path

import cv2

_M0 = Path(os.environ.get(
    "ONELIVE_M0_ENGINE",
    r"C:\Users\76475\Documents\OneLive\.worktrees\v2-m0-spike\engine",
))
_CLONE = _M0 / "FasterLivePortrait"


def map_lip_ratio(lip: float, closed: float, open_: float) -> float:
    """把调度器的归一化口型值线性映射到 clone 的 close-ratio 单位。

    前置条件：lip ∈ [0,1]——由上游 SpeechClip 构造时 clip 保证，
    本函数不再重复钳制（越界输入会线性外推出 [closed, open_]）。"""
    return closed + lip * (open_ - closed)


class LivePortraitPipeline:
    def __init__(self, source_image: str | None = None, cfg_name: str = "onnx_infer.yaml",
                 enable_lip: bool = True, lip_closed: float = 0.001,
                 # lip_open 上限依据 M2b spike 实测（spike-results）：d14 驱动视频
                 # 观测到的 close-ratio 最大 0.216，0.18 对应中等张嘴幅度；
                 # 调高该上限会加大嘴部开合幅度（更夸张的口型）。
                 lip_open: float = 0.18):
        assert _CLONE.is_dir(), f"M0 engine assets not found: {_CLONE}"
        os.chdir(_CLONE)  # clone 内配置用相对路径（../models/...）引用模型
        sys.path.insert(0, str(_CLONE))
        from omegaconf import OmegaConf
        from src.pipelines.faster_live_portrait_pipeline import FasterLivePortraitPipeline
        cfg = OmegaConf.load(str(_CLONE / "configs" / cfg_name))
        # 跳过全分辨率 pasteback（clone 489 行门控）：本适配器只用 out_crop，
        # pasteback 结果本来就被丢弃。注意不能用 run(realtime=True) 达成——
        # clone 的 run() 把 realtime 从 kwargs 取出后又原样 **kwargs 转发给
        # _run()，会触发 "multiple values for argument 'realtime'"（上游 bug，
        # 实测复现）。M0 bench 同样用本 cfg 开关（bench_liveportrait.py:63）。
        cfg.infer_params.flag_pasteback = False
        self._enable_lip = enable_lip
        self._lip_closed = lip_closed
        self._lip_open = lip_open
        if enable_lip:
            # 嘴型覆写（Task 1 补丁）所需的两个开关必须在管线构造前置好
            # ——cfg 每帧从同一 OmegaConf 读取，但"构造前设置"是已验证的模式。
            cfg.infer_params.flag_lip_retargeting = True
            cfg.infer_params.flag_lip_retarget_keep_motion = True
        self._pipe = FasterLivePortraitPipeline(cfg=cfg)
        src = source_image or str(_CLONE / "assets/examples/source/s10.jpg")
        ok = self._pipe.prepare_source(src, realtime=True)
        assert ok, f"prepare_source failed (no face?): {src}"
        # prepare_source 后立即快照——后续 prepare 调用会覆盖这两个列表
        self._img_src = self._pipe.src_imgs[0]
        self._src_info = self._pipe.src_infos[0]
        self._initialized = False  # 首次成功推理前保持 first_frame=True

    def set_source(self, image_path: str) -> None:
        """热切换底图（casting）。失败（文件缺失/无脸）raise，此时旧底图快照
        （self._img_src/_src_info 持有的引用）不受影响，infer 继续用旧底图。

        线程契约：必须在 worker 推理线程上执行（经 ChannelWorker.post_command
        调度，调用方负责）——prepare_source 会清掉底层 pipe 的 src_imgs/src_infos
        再重建，与并发 infer 不串行会读到半旧半新状态。
        prepare_source 后立即快照（M0 API 地图铁律）；成功后重置 _initialized，
        下一驱动帧以 first_frame=True 对新底图重锚定驱动基准。"""
        ok = self._pipe.prepare_source(image_path, realtime=True)
        if not ok:
            raise ValueError(f"prepare_source failed (no face?): {image_path}")
        self._img_src = self._pipe.src_imgs[0]
        self._src_info = self._pipe.src_infos[0]
        self._initialized = False

    def infer(self, frame_bgr, seq: int, lip_ratio: float | None = None):
        """lip_ratio: 归一化口型值 0..1（None = 不覆写）。有值且 enable_lip 时
        映射为 close-ratio 后经 lip_ratio_override 传给 clone；None 或禁用时
        完全不带该 kwarg——调用参数与 legacy 逐字节相同。

        注意：调用等价 ≠ 渲染等价。enable_lip=True 时构造期 flag
        （flag_lip_retarget_keep_motion）已改变每帧渲染语义：嘴部经
        retarget 通路跟随驱动视频，但只保留开合度（close-ratio），
        丢失微笑/音素等细节口型。完全与 M1a 基线等价需 enable_lip=False
        （run_local --no-lip）。详见 m2b-results.md 已知语义变化。"""
        kwargs = {}
        if lip_ratio is not None and self._enable_lip:
            kwargs["lip_ratio_override"] = map_lip_ratio(
                lip_ratio, self._lip_closed, self._lip_open)
        ret = self._pipe.run(frame_bgr, self._img_src, self._src_info,
                             first_frame=not self._initialized, **kwargs)
        if ret is None:
            return None
        _, out_crop, _, _ = ret
        if out_crop is None:  # 无脸帧：实际命中的分支（run 返回 4 个 None）
            return None
        self._initialized = True
        return cv2.cvtColor(out_crop, cv2.COLOR_RGB2BGR)

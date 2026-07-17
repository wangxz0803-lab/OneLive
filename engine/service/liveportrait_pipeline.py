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


class LivePortraitPipeline:
    def __init__(self, source_image: str | None = None, cfg_name: str = "onnx_infer.yaml"):
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
        self._pipe = FasterLivePortraitPipeline(cfg=cfg)
        src = source_image or str(_CLONE / "assets/examples/source/s10.jpg")
        ok = self._pipe.prepare_source(src, realtime=True)
        assert ok, f"prepare_source failed (no face?): {src}"
        # prepare_source 后立即快照——后续 prepare 调用会覆盖这两个列表
        self._img_src = self._pipe.src_imgs[0]
        self._src_info = self._pipe.src_infos[0]
        self._initialized = False  # 首次成功推理前保持 first_frame=True

    def infer(self, frame_bgr, seq: int):
        ret = self._pipe.run(frame_bgr, self._img_src, self._src_info,
                             first_frame=not self._initialized)
        if ret is None:
            return None
        _, out_crop, _, _ = ret
        if out_crop is None:  # 无脸帧：实际命中的分支（run 返回 4 个 None）
            return None
        self._initialized = True
        return cv2.cvtColor(out_crop, cv2.COLOR_RGB2BGR)

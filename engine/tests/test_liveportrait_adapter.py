"""LivePortraitPipeline 适配器口型映射单测（无 GPU / 不加载真实模型）。

构造真实 LivePortraitPipeline 需要 M0 模型资产 + ONNX runtime（太重，
且会 chdir/加载模型）——单测采用两层策略：
1) 比例映射抽成纯函数 ``map_lip_ratio`` 直接测数值；
2) kwarg 传递路径用 ``LivePortraitPipeline.__new__`` 造裸实例、手工填
   实例属性、_pipe 换成记录 kwargs 的假对象——只验证 infer 的分支逻辑
   （None/disabled → 完全不带 kwarg；有值 → 映射后以 lip_ratio_override
   传入），不触碰任何模型代码。真实模型全链路由 Task 5 E2E 覆盖。
"""

import numpy as np
import pytest

from service.liveportrait_pipeline import LivePortraitPipeline, map_lip_ratio


# ------------------------------------------------------------- pure mapping


def test_map_lip_ratio_endpoints_and_midpoint():
    assert map_lip_ratio(0.0, 0.001, 0.18) == pytest.approx(0.001)
    assert map_lip_ratio(1.0, 0.001, 0.18) == pytest.approx(0.18)
    # 0.001 + 0.5 * (0.18 - 0.001) = 0.0905
    assert map_lip_ratio(0.5, 0.001, 0.18) == pytest.approx(0.0905)


# --------------------------------------------------------- kwarg plumbing


class _RecordingPipe:
    """假 FasterLivePortraitPipeline：记录 run() 收到的 kwargs，返回合法 4 元组。"""

    def __init__(self):
        self.kwargs_seen: list[dict] = []

    def run(self, *args, **kwargs):
        self.kwargs_seen.append(kwargs)
        out_crop = np.zeros((4, 4, 3), dtype=np.uint8)
        return (None, out_crop, None, None)


def _bare_adapter(enable_lip: bool = True) -> LivePortraitPipeline:
    """绕过 __init__（会加载真实模型）造裸实例，手工填 infer 所需属性。"""
    obj = LivePortraitPipeline.__new__(LivePortraitPipeline)
    obj._pipe = _RecordingPipe()
    obj._img_src = object()
    obj._src_info = object()
    obj._initialized = False
    obj._enable_lip = enable_lip
    obj._lip_closed = 0.001
    obj._lip_open = 0.18
    return obj


_FRAME = np.zeros((4, 4, 3), dtype=np.uint8)


def test_infer_passes_mapped_override():
    a = _bare_adapter()
    out = a.infer(_FRAME, seq=0, lip_ratio=0.5)
    assert out is not None
    kw = a._pipe.kwargs_seen[-1]
    assert kw["lip_ratio_override"] == pytest.approx(0.0905)


def test_infer_none_lip_omits_kwarg():
    """lip_ratio=None（含缺省）→ run() 完全不带 lip_ratio_override
    ——legacy 路径逐字节等价。"""
    a = _bare_adapter()
    a.infer(_FRAME, seq=0)                    # 缺省
    a.infer(_FRAME, seq=1, lip_ratio=None)    # 显式 None
    assert len(a._pipe.kwargs_seen) == 2
    for kw in a._pipe.kwargs_seen:
        assert "lip_ratio_override" not in kw


def test_infer_disabled_omits_kwarg_even_with_lip():
    a = _bare_adapter(enable_lip=False)
    a.infer(_FRAME, seq=0, lip_ratio=0.9)
    assert "lip_ratio_override" not in a._pipe.kwargs_seen[-1]

"""确保 engine/ 在 sys.path 上，便于 `from lipsync...` 导入。"""

import sys
from pathlib import Path

ENGINE_ROOT = str(Path(__file__).resolve().parents[1])
if ENGINE_ROOT not in sys.path:
    sys.path.insert(0, ENGINE_ROOT)


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "ffmpeg_e2e: 真 ffmpeg 拉流冒烟（~10s，默认套件保留；-m 'not ffmpeg_e2e' 可跳）")

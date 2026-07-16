"""确保 engine/ 在 sys.path 上，便于 `from lipsync...` 导入。"""

import sys
from pathlib import Path

ENGINE_ROOT = str(Path(__file__).resolve().parents[1])
if ENGINE_ROOT not in sys.path:
    sys.path.insert(0, ENGINE_ROOT)

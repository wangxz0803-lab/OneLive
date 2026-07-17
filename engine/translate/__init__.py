"""翻译链路：可插拔翻译 Provider（诚实的 unavailable 状态，绝不伪造译文）。"""

from translate.providers import (
    OpenAICompatProvider,
    TranslateProvider,
    TranslateResult,
    from_env,
)

__all__ = [
    "OpenAICompatProvider",
    "TranslateProvider",
    "TranslateResult",
    "from_env",
]

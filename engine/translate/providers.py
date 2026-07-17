"""可插拔翻译 Provider。

硬性规范：未配置 API key 时必须诚实返回 unavailable，
绝不返回伪造/预置的"翻译"文本。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

import httpx

# 语言代码 → 提示词里用的语言名。translate() 的 target_lang 支持代码或直接给名字。
LANG_NAMES = {
    "en": "English",
    "ja": "Japanese",
    "es": "Spanish (Latin America)",
}

_SYSTEM_PROMPT_TEMPLATE = (
    "You are a professional live-commerce interpreter. "
    "Translate the user's message into {target_lang} for a live shopping "
    "audience. Be concise and natural for spoken delivery. Keep all numbers, "
    "prices, and product names exactly as given. "
    "Output only the translation, nothing else."
)


@dataclass
class TranslateResult:
    """单次翻译的结果。status: "ok" | "unavailable" | "error"。"""

    ok: bool
    text: str | None
    status: str
    detail: str | None = None


@runtime_checkable
class TranslateProvider(Protocol):
    """翻译 Provider 协议。实现必须永不抛异常，用 TranslateResult 表达失败。"""

    available: bool

    async def translate(self, text: str, target_lang: str) -> TranslateResult:
        """把 text 翻译为 target_lang。"""
        ...


class OpenAICompatProvider:
    """OpenAI 兼容 /chat/completions 翻译 Provider。

    api_key 为空 → available=False，translate 直接返回 unavailable，
    不发起任何 HTTP 请求。
    """

    def __init__(
        self,
        base_url: str,
        api_key: str | None,
        model: str,
        timeout_s: float = 8,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = api_key or ""
        self.model = model
        self.timeout_s = timeout_s
        self._transport = transport
        self.available = bool(self.api_key) and bool(self.base_url)

    @property
    def _endpoint(self) -> str:
        # 兼容 base_url 已带 /chat/completions 的写法
        if self.base_url.endswith("/chat/completions"):
            return self.base_url
        return f"{self.base_url}/chat/completions"

    async def translate(self, text: str, target_lang: str) -> TranslateResult:
        """把 text 翻译为 target_lang（接受语言代码如 "ja"，或直接给语言名）。"""
        if not self.available:
            return TranslateResult(
                ok=False,
                text=None,
                status="unavailable",
                detail=(
                    "not configured (set AI_API_KEY and AI_API_URL); "
                    "refusing to fake translations"
                ),
            )

        lang_name = LANG_NAMES.get(target_lang, target_lang)
        payload = {
            "model": self.model,
            "messages": [
                {
                    "role": "system",
                    "content": _SYSTEM_PROMPT_TEMPLATE.format(target_lang=lang_name),
                },
                {"role": "user", "content": text},
            ],
            "temperature": 0.3,
        }
        headers = {"Authorization": f"Bearer {self.api_key}"}

        try:
            async with httpx.AsyncClient(
                timeout=self.timeout_s, transport=self._transport
            ) as client:
                response = await client.post(
                    self._endpoint, json=payload, headers=headers
                )
        except httpx.TimeoutException as exc:
            return TranslateResult(
                ok=False, text=None, status="error", detail=f"timeout: {exc}"
            )
        except (httpx.HTTPError, httpx.InvalidURL, ValueError) as exc:
            # InvalidURL/ValueError：请求构建阶段（如 base_url 手误）就会抛，
            # 且 InvalidURL 不是 HTTPError 子类 —— 同样收敛为 error，绝不上抛。
            return TranslateResult(
                ok=False,
                text=None,
                status="error",
                detail=f"{type(exc).__name__}: {exc}",
            )

        if response.status_code < 200 or response.status_code >= 300:
            body = response.text[:200]
            return TranslateResult(
                ok=False,
                text=None,
                status="error",
                detail=f"HTTP {response.status_code}: {body}",
            )

        try:
            data = response.json()
            content = data["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            return TranslateResult(
                ok=False,
                text=None,
                status="error",
                detail=f"malformed response: {type(exc).__name__}: {exc}",
            )

        if not isinstance(content, str) or not content.strip():
            return TranslateResult(
                ok=False,
                text=None,
                status="error",
                detail="malformed response: empty or non-string content",
            )

        return TranslateResult(ok=True, text=content.strip(), status="ok")


def from_env() -> OpenAICompatProvider:
    """从环境变量构建 Provider：AI_API_URL / AI_API_KEY / AI_MODEL。"""
    return OpenAICompatProvider(
        base_url=os.environ.get("AI_API_URL", ""),
        api_key=os.environ.get("AI_API_KEY", ""),
        model=os.environ.get("AI_MODEL", ""),
    )

"""翻译 Provider 协议测试（httpx.MockTransport，无真实网络）。"""

import json

import httpx
import pytest

from translate.providers import OpenAICompatProvider, TranslateResult, from_env


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _chat_response(content: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={"choices": [{"message": {"role": "assistant", "content": content}}]},
    )


class CountingHandler:
    """记录调用次数的 mock handler。"""

    def __init__(self, responder):
        self.calls = 0
        self.requests: list[httpx.Request] = []
        self._responder = responder

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        self.requests.append(request)
        result = self._responder(request)
        if isinstance(result, Exception):
            raise result
        return result


@pytest.mark.anyio
async def test_success_parses_content():
    handler = CountingHandler(lambda req: _chat_response("Hello world"))
    provider = OpenAICompatProvider(
        base_url="https://api.example.com/v1",
        api_key="sk-test",
        model="gpt-x",
        transport=httpx.MockTransport(handler),
    )
    assert provider.available is True

    result = await provider.translate("你好世界", target_lang="English")

    assert isinstance(result, TranslateResult)
    assert result.ok is True
    assert result.status == "ok"
    assert result.text == "Hello world"
    assert handler.calls == 1

    request = handler.requests[0]
    assert str(request.url) == "https://api.example.com/v1/chat/completions"
    assert request.headers["authorization"] == "Bearer sk-test"
    payload = json.loads(request.content)
    assert payload["model"] == "gpt-x"
    assert payload["messages"][-1] == {"role": "user", "content": "你好世界"}
    assert "English" in payload["messages"][0]["content"]


@pytest.mark.anyio
async def test_base_url_already_has_chat_completions():
    handler = CountingHandler(lambda req: _chat_response("ok"))
    provider = OpenAICompatProvider(
        base_url="https://api.example.com/v1/chat/completions",
        api_key="sk-test",
        model="gpt-x",
        transport=httpx.MockTransport(handler),
    )
    result = await provider.translate("hi", target_lang="Chinese")
    assert result.status == "ok"
    assert (
        str(handler.requests[0].url)
        == "https://api.example.com/v1/chat/completions"
    )


@pytest.mark.anyio
async def test_http_500_returns_error_with_status_code():
    handler = CountingHandler(lambda req: httpx.Response(500, text="boom"))
    provider = OpenAICompatProvider(
        base_url="https://api.example.com/v1",
        api_key="sk-test",
        model="gpt-x",
        transport=httpx.MockTransport(handler),
    )
    result = await provider.translate("hi", target_lang="English")
    assert result.ok is False
    assert result.status == "error"
    assert result.text is None
    assert "500" in (result.detail or "")


@pytest.mark.anyio
async def test_timeout_returns_error():
    handler = CountingHandler(lambda req: httpx.TimeoutException("timed out"))
    provider = OpenAICompatProvider(
        base_url="https://api.example.com/v1",
        api_key="sk-test",
        model="gpt-x",
        transport=httpx.MockTransport(handler),
    )
    result = await provider.translate("hi", target_lang="English")
    assert result.ok is False
    assert result.status == "error"
    assert result.text is None


@pytest.mark.anyio
async def test_malformed_json_returns_error():
    handler = CountingHandler(lambda req: httpx.Response(200, text="not json"))
    provider = OpenAICompatProvider(
        base_url="https://api.example.com/v1",
        api_key="sk-test",
        model="gpt-x",
        transport=httpx.MockTransport(handler),
    )
    result = await provider.translate("hi", target_lang="English")
    assert result.ok is False
    assert result.status == "error"


@pytest.mark.anyio
async def test_no_key_unavailable_and_no_http_call():
    handler = CountingHandler(lambda req: _chat_response("should not happen"))
    provider = OpenAICompatProvider(
        base_url="https://api.example.com/v1",
        api_key="",
        model="gpt-x",
        transport=httpx.MockTransport(handler),
    )
    assert provider.available is False

    result = await provider.translate("hi", target_lang="English")
    assert result.ok is False
    assert result.status == "unavailable"
    assert result.text is None
    assert handler.calls == 0


def test_from_env_builds_configured_provider(monkeypatch):
    monkeypatch.setenv("AI_API_URL", "https://api.example.com/v1")
    monkeypatch.setenv("AI_API_KEY", "sk-env")
    monkeypatch.setenv("AI_MODEL", "env-model")

    provider = from_env()
    assert isinstance(provider, OpenAICompatProvider)
    assert provider.available is True
    assert provider.model == "env-model"


def test_from_env_without_key_is_unavailable(monkeypatch):
    monkeypatch.setenv("AI_API_URL", "https://api.example.com/v1")
    monkeypatch.delenv("AI_API_KEY", raising=False)
    monkeypatch.setenv("AI_MODEL", "env-model")

    provider = from_env()
    assert provider.available is False

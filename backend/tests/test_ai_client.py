import json

import httpx
import pytest

from app.ai.client import LlmError, Provider, ThinkFilter, stream_chat


def _feed_all(chunks: list[str]) -> str:
    f = ThinkFilter()
    return "".join(f.feed(c) for c in chunks) + f.flush()


@pytest.mark.parametrize(
    "chunks, expected",
    [
        (["hello"], "hello"),
        (["<think>plan</think>answer"], "answer"),
        (["<thi", "nk>plan</th", "ink>ans", "wer"], "answer"),
        (["a <", "b"], "a <b"),  # a lone "<" that isn't a tag survives
        (["x<think>never closed"], "x"),
        (["pre<think>a</think>mid<think>b</think>post"], "premidpost"),
    ],
)
def test_think_filter(chunks, expected):
    assert _feed_all(chunks) == expected


def _sse_body(deltas: list[str]) -> bytes:
    lines = [
        "data: " + json.dumps({"choices": [{"delta": {"content": d}}]}) for d in deltas
    ]
    return ("\n\n".join([*lines, "data: [DONE]"]) + "\n\n").encode()


async def test_stream_chat_yields_content_and_sends_request():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, content=_sse_body(["Hel", "lo", "<think>x</think>!"]))

    provider = Provider("http://llm/v1", "m", transport=httpx.MockTransport(handler))
    out = [t async for t in stream_chat(provider, [{"role": "user", "content": "hi"}], max_tokens=5)]
    assert "".join(out) == "Hello!"
    assert seen["url"] == "http://llm/v1/chat/completions"
    assert seen["body"]["stream"] is True and seen["body"]["max_tokens"] == 5


async def test_stream_chat_http_error():
    provider = Provider(
        "http://llm/v1", "m", transport=httpx.MockTransport(lambda r: httpx.Response(500, text="boom"))
    )
    with pytest.raises(LlmError, match="HTTP 500: boom"):
        [t async for t in stream_chat(provider, [])]


async def test_stream_chat_unreachable():
    def handler(request):
        raise httpx.ConnectError("refused")

    provider = Provider("http://llm/v1", "m", transport=httpx.MockTransport(handler))
    with pytest.raises(LlmError, match="could not reach"):
        [t async for t in stream_chat(provider, [])]


async def test_stream_chat_with_schema_sets_response_format():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, content=_sse_body(['{"a"', ': 1}']))

    provider = Provider("http://llm/v1", "m", transport=httpx.MockTransport(handler))
    out = [t async for t in stream_chat(provider, [], schema={"type": "object"})]
    assert "".join(out) == '{"a": 1}'
    fmt = seen["body"]["response_format"]
    assert fmt["type"] == "json_schema" and fmt["json_schema"]["schema"] == {"type": "object"}

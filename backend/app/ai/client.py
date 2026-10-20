"""Minimal OpenAI-compatible chat client (llama-server, Ollama, LM Studio, …).

Deliberately tiny: one streamed chat call (optionally JSON-schema constrained)
over httpx, no SDK. Any `<think>…</think>` reasoning a model emits inline is
stripped so it never reaches the UI or a parser.
"""

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

import httpx

from app.logging_setup import get_logger

log = get_logger(__name__)

CONNECT_TIMEOUT_S = 10.0
READ_TIMEOUT_S = 300.0  # a slow laptop can pause a long time before the first token
DEFAULT_TEMPERATURE = 0.2
THINK_OPEN = "<think>"
THINK_CLOSE = "</think>"


class LlmError(Exception):
    """The model server is unreachable or returned an error."""


@dataclass(frozen=True)
class Provider:
    base_url: str  # ends in /v1
    model: str
    transport: httpx.AsyncBaseTransport | None = field(default=None, compare=False)


def _client(provider: Provider) -> httpx.AsyncClient:
    timeout = httpx.Timeout(CONNECT_TIMEOUT_S, read=READ_TIMEOUT_S)
    return httpx.AsyncClient(transport=provider.transport, timeout=timeout)


def _body(provider: Provider, messages: list[dict], **extra) -> dict:
    return {
        "model": provider.model,
        "messages": messages,
        "temperature": DEFAULT_TEMPERATURE,
        **extra,
    }


async def _raise_for_status(response: httpx.Response) -> None:
    if response.status_code < 400:
        return
    detail = (await response.aread()).decode(errors="replace")[:500]
    raise LlmError(f"model server returned HTTP {response.status_code}: {detail}")


class ThinkFilter:
    """Drops <think>…</think> spans from a token stream, even split across chunks."""

    def __init__(self) -> None:
        self._buffer = ""
        self._thinking = False

    def feed(self, text: str) -> str:
        self._buffer += text
        out: list[str] = []
        while self._buffer:
            tag = THINK_CLOSE if self._thinking else THINK_OPEN
            index = self._buffer.find(tag)
            if index >= 0:
                if not self._thinking:
                    out.append(self._buffer[:index])
                self._buffer = self._buffer[index + len(tag):]
                self._thinking = not self._thinking
                continue
            # keep a possible partial tag at the end for the next chunk
            keep = next(
                (n for n in range(len(tag) - 1, 0, -1) if self._buffer.endswith(tag[:n])), 0
            )
            ready = self._buffer[: len(self._buffer) - keep]
            if not self._thinking:
                out.append(ready)
            self._buffer = self._buffer[len(ready):]
            break
        return "".join(out)

    def flush(self) -> str:
        rest, self._buffer = ("" if self._thinking else self._buffer), ""
        return rest


async def stream_chat(
    provider: Provider,
    messages: list[dict],
    *,
    max_tokens: int | None = None,
    schema: dict | None = None,
) -> AsyncIterator[str]:
    """Yield the assistant's reply text as it is generated.

    With `schema`, the reply is constrained to that JSON schema (servers that
    support json_schema response formats enforce it token by token).
    """
    body = _body(provider, messages, stream=True)
    if max_tokens:
        body["max_tokens"] = max_tokens
    if schema is not None:
        body["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "result", "schema": schema, "strict": True},
        }
    think = ThinkFilter()
    try:
        async with _client(provider) as client, client.stream(
            "POST", f"{provider.base_url}/chat/completions", json=body
        ) as response:
            await _raise_for_status(response)
            async for line in response.aiter_lines():
                delta = _parse_stream_line(line)
                if delta is None:
                    break
                if text := think.feed(delta):
                    yield text
    except httpx.HTTPError as exc:
        raise LlmError(f"could not reach the model server: {exc}") from exc
    if tail := think.flush():
        yield tail


def _parse_stream_line(line: str) -> str | None:
    """Content delta from one SSE line ("" when there's none); None at [DONE]."""
    if not line.startswith("data:"):
        return ""
    payload = line[5:].strip()
    if payload == "[DONE]":
        return None
    try:
        chunk = json.loads(payload)
    except json.JSONDecodeError:
        return ""
    choices = chunk.get("choices") or [{}]
    return (choices[0].get("delta") or {}).get("content") or ""

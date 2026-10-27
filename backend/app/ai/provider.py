"""Resolve which OpenAI-compatible server an AI request goes to."""

from app.ai.client import Provider
from app.ai.config import AiConfig
from app.ai.download import downloader
from app.ai.runtime import find_llama_server, llama_server

DEFAULT_ENDPOINT_MODEL = "default"


async def resolve_provider(config: AiConfig) -> Provider:
    """The configured endpoint, else the bundled llama-server (started on demand).

    Raises app.ai.runtime.RuntimeUnavailable when the bundled runtime can't run.
    """
    if config.endpoint_url:
        base = config.endpoint_url
        if not base.endswith("/v1"):
            base = f"{base}/v1"
        return Provider(base_url=base, model=config.endpoint_model or DEFAULT_ENDPOINT_MODEL)
    base_url = await llama_server.ensure(config.model)
    return Provider(base_url=base_url, model=config.model.id)


def llm_ready(config: AiConfig) -> bool:
    """Whether an AI request could run now: an endpoint is configured, or the bundled
    runtime is installed and the selected model downloaded (same test as GET /ai/status)."""
    if config.endpoint_url:
        return True
    return find_llama_server() is not None and downloader.status(config.model).downloaded

"""Resolve which OpenAI-compatible server an AI request goes to."""

from app.ai.client import Provider
from app.ai.config import AiConfig
from app.ai.runtime import llama_server

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

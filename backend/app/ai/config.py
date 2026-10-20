"""Which model AI features talk to: the bundled one, or a user-configured endpoint.

Stored in app_settings. Setting `ai_endpoint_url` switches every AI feature to
that OpenAI-compatible server (Ollama, LM Studio, a team server, …) instead of
the bundled llama-server.
"""

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.catalog import DEFAULT_MODEL_ID, ModelSpec, find_model
from app.db.models import AppSetting

AI_MODEL_KEY = "ai_model"
AI_ENDPOINT_URL_KEY = "ai_endpoint_url"
AI_ENDPOINT_MODEL_KEY = "ai_endpoint_model"


@dataclass(frozen=True)
class AiConfig:
    model: ModelSpec  # bundled model (used when no endpoint is configured)
    endpoint_url: str | None
    endpoint_model: str | None

    @property
    def uses_endpoint(self) -> bool:
        return bool(self.endpoint_url)


async def _get(session: AsyncSession, key: str) -> str | None:
    row = await session.get(AppSetting, key)
    value = row.value.strip() if row is not None and row.value else ""
    return value or None


async def load_ai_config(session: AsyncSession) -> AiConfig:
    model = find_model(await _get(session, AI_MODEL_KEY)) or find_model(DEFAULT_MODEL_ID)
    assert model is not None
    endpoint = await _get(session, AI_ENDPOINT_URL_KEY)
    return AiConfig(
        model=model,
        endpoint_url=endpoint.rstrip("/") if endpoint else None,
        endpoint_model=await _get(session, AI_ENDPOINT_MODEL_KEY),
    )

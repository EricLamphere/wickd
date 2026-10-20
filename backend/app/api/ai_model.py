"""AI model status + local model downloads (global, not per project)."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import pro
from app.ai.catalog import MODELS, ModelSpec, find_model
from app.ai.config import load_ai_config
from app.ai.download import downloader
from app.ai.gating import require_ai
from app.ai.runtime import find_llama_server, llama_server
from app.db.engine import get_session
from app.licensing import entitlements

router = APIRouter(prefix="/api/ai", tags=["ai"])


class AiModelDto(BaseModel):
    id: str
    label: str
    description: str
    size_bytes: int
    license: str
    downloaded: bool
    downloading: bool
    bytes_done: int
    error: str | None


class AiStatusDto(BaseModel):
    entitled: bool
    pro_installed: bool
    runtime_installed: bool  # bundled llama-server found
    uses_endpoint: bool
    endpoint_url: str | None
    endpoint_model: str | None
    model_id: str  # selected bundled model
    running_model_id: str | None
    models: list[AiModelDto]
    # everything needed to run an AI request is in place
    ready: bool


def _model_dto(spec: ModelSpec) -> AiModelDto:
    status = downloader.status(spec)
    return AiModelDto(
        id=spec.id,
        label=spec.label,
        description=spec.description,
        size_bytes=spec.size_bytes,
        license=spec.license,
        downloaded=status.downloaded,
        downloading=status.downloading,
        bytes_done=status.bytes_done,
        error=status.error,
    )


@router.get("/status", response_model=AiStatusDto)
async def get_ai_status(session: AsyncSession = Depends(get_session)) -> AiStatusDto:
    config = await load_ai_config(session)
    entitled = (await entitlements.check_entitlement(session)).entitled
    pro_installed = pro.is_available()
    runtime_installed = find_llama_server() is not None
    models = [_model_dto(spec) for spec in MODELS]
    selected = next(m for m in models if m.id == config.model.id)
    local_ready = runtime_installed and selected.downloaded
    return AiStatusDto(
        entitled=entitled,
        pro_installed=pro_installed,
        runtime_installed=runtime_installed,
        uses_endpoint=config.uses_endpoint,
        endpoint_url=config.endpoint_url,
        endpoint_model=config.endpoint_model,
        model_id=config.model.id,
        running_model_id=llama_server.running_model,
        models=models,
        ready=entitled and pro_installed and (config.uses_endpoint or local_ready),
    )


def _spec(model_id: str) -> ModelSpec:
    spec = find_model(model_id)
    if spec is None:
        raise HTTPException(status_code=404, detail="unknown model")
    return spec


@router.post("/models/{model_id}/download", response_model=AiModelDto, status_code=202)
async def start_download(model_id: str, session: AsyncSession = Depends(get_session)) -> AiModelDto:
    await require_ai(session)
    spec = _spec(model_id)
    downloader.start(spec)
    return _model_dto(spec)


@router.delete("/models/{model_id}/download", response_model=AiModelDto)
async def cancel_download(model_id: str) -> AiModelDto:
    spec = _spec(model_id)
    await downloader.cancel(spec)
    return _model_dto(spec)


@router.delete("/models/{model_id}", response_model=AiModelDto)
async def delete_model(model_id: str) -> AiModelDto:
    """Free the disk space; the partial download goes too."""
    spec = _spec(model_id)
    if downloader.is_downloading(spec):
        raise HTTPException(status_code=409, detail="cancel the download first")
    if llama_server.running_model == spec.id:
        await llama_server.stop()
    downloader.delete(spec)
    return _model_dto(spec)

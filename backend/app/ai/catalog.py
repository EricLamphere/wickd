"""Local models wickd can download and run with the bundled llama-server.

Pinned to exact files + checksums so every install runs the same weights and
a truncated or tampered download is caught before it is ever loaded.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class ModelSpec:
    id: str
    label: str
    description: str
    filename: str
    url: str
    sha256: str
    size_bytes: int
    context_size: int  # tokens passed to llama-server -c
    license: str


MODELS: tuple[ModelSpec, ...] = (
    ModelSpec(
        id="qwen3.5-4b",
        label="Qwen3.5 4B",
        description="Fast, fits machines with 8 GB+ of memory.",
        filename="Qwen3.5-4B-Q4_K_M.gguf",
        url="https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf",
        sha256="00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
        size_bytes=2_740_937_888,
        context_size=16_384,
        license="Apache-2.0",
    ),
    ModelSpec(
        id="qwen3.5-9b",
        label="Qwen3.5 9B",
        description="Better results, needs 16 GB+ of memory.",
        filename="Qwen3.5-9B-Q4_K_M.gguf",
        url="https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf",
        sha256="03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8",
        size_bytes=5_680_522_464,
        context_size=16_384,
        license="Apache-2.0",
    ),
)

DEFAULT_MODEL_ID = MODELS[0].id


def find_model(model_id: str | None) -> ModelSpec | None:
    return next((m for m in MODELS if m.id == model_id), None)

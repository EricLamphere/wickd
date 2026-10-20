import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
import yaml

from app.ai import documentation, pro
from app.ai.catalog import MODELS
from app.ai.client import Provider
from app.ai.config import AiConfig
from app.ai.documentation import DocumentationError, NothingToDocument, generate_documentation
from app.dbt.probe import ProbeResult

UID = "model.proj.orders"
CONFIG = AiConfig(model=MODELS[0], endpoint_url=None, endpoint_model=None)


def _project(tmp_path: Path, columns: dict | None = None, schema: str | None = None) -> Path:
    root = tmp_path / "proj"
    (root / "models").mkdir(parents=True)
    (root / "target").mkdir()
    node = {
        "name": "orders",
        "resource_type": "model",
        "original_file_path": "models/orders.sql",
        "columns": columns or {},
    }
    if schema is not None:
        (root / "models" / "schema.yml").write_text(schema)
        node["patch_path"] = "proj://models/schema.yml"
    (root / "target" / "manifest.json").write_text(json.dumps({"nodes": {UID: node}}))
    return root


@pytest.fixture
def model(monkeypatch):
    """Fake probe/provider/model; tests set the model's JSON answer via .answer."""
    state = {"answer": "{}", "prompt_columns": None}

    def _prompt(manifest, unique_id, columns):
        state["prompt_columns"] = columns
        return {"messages": [], "schema": {}, "max_tokens": 10}

    async def _stream(provider, messages, max_tokens=None, schema=None):
        answer = state["answer"]
        yield answer[: len(answer) // 2]
        yield answer[len(answer) // 2:]

    monkeypatch.setattr(pro, "documentation_prompt", _prompt)
    monkeypatch.setattr(pro, "parse_documentation", lambda raw, cols: json.loads(raw))
    monkeypatch.setattr(documentation, "stream_chat", _stream)
    monkeypatch.setattr(
        documentation, "resolve_provider", AsyncMock(return_value=Provider("http://x/v1", "m"))
    )
    monkeypatch.setattr(
        documentation, "probe_warehouse_columns",
        AsyncMock(return_value=ProbeResult(columns=("id", "amount"), error=None)),
    )
    return state


async def _generate(root: Path, overwrite: bool = False, **callbacks):
    return await generate_documentation(
        project_id=1, project_path=root, unique_id=UID, env={}, config=CONFIG, overwrite=overwrite,
        **callbacks,
    )


async def test_new_schema_file_with_descriptions(tmp_path, model):
    root = _project(tmp_path)
    model["answer"] = json.dumps({
        "description": "One row per order.",
        "columns": {"id": "Order key.", "amount": "Total: in cents."},
    })
    phases, texts = [], []

    async def on_phase(p):
        phases.append(p)

    async def on_text(t):
        texts.append(t)

    result = await _generate(root, on_phase=on_phase, on_text=on_text)
    assert phases == ["columns", "writing"]
    assert texts[-1] == model["answer"] and len(texts) == 2
    assert model["prompt_columns"] == ["id", "amount"]
    assert result.change.path == "models/schema.yml"
    assert result.change.original is None
    data = yaml.safe_load(result.change.proposed)
    assert data["models"][0] == {
        "name": "orders",
        "description": "One row per order.",
        "columns": [
            {"name": "id", "description": "Order key."},
            {"name": "amount", "description": "Total: in cents."},
        ],
    }
    assert not (root / "models" / "schema.yml").exists()  # proposal only


async def test_only_missing_columns_are_asked_for(tmp_path, model):
    schema = (
        "models:\n  - name: orders\n    description: Done.\n    columns:\n"
        "      - name: id\n        description: Key.\n"
    )
    root = _project(tmp_path, schema=schema)
    model["answer"] = json.dumps({"description": "ignored", "columns": {"amount": "Total."}})
    result = await _generate(root)
    assert model["prompt_columns"] == ["amount"]
    assert result.summary["description"] is None
    assert result.summary["columns"] == {"amount": "Total."}
    assert result.summary["plan"]["columns"] == ["id", "amount"]

    await _generate(root, overwrite=True)
    assert model["prompt_columns"] == ["id", "amount"]


async def test_fully_documented_skips_the_model(tmp_path, model, monkeypatch):
    schema = (
        "models:\n  - name: orders\n    description: Done.\n    columns:\n"
        "      - name: id\n        description: a\n      - name: amount\n        description: b\n"
    )
    root = _project(tmp_path, schema=schema)
    provider = AsyncMock()
    monkeypatch.setattr(documentation, "resolve_provider", provider)
    with pytest.raises(NothingToDocument):
        await _generate(root)
    provider.assert_not_called()
    assert model["prompt_columns"] is None


async def test_existing_descriptions_kept_unless_overwrite(tmp_path, model):
    schema = "version: 2\nmodels:\n  - name: orders\n    description: Keep me.\n"
    root = _project(tmp_path, schema=schema)
    model["answer"] = json.dumps({"description": "New.", "columns": {"id": "Key."}})
    kept = yaml.safe_load((await _generate(root)).change.proposed)["models"][0]
    assert kept["description"] == "Keep me."
    assert kept["columns"][0] == {"name": "id", "description": "Key."}

    replaced = yaml.safe_load((await _generate(root, overwrite=True)).change.proposed)
    assert replaced["models"][0]["description"] == "New."


async def test_falls_back_to_manifest_columns_when_probe_fails(tmp_path, model, monkeypatch):
    root = _project(tmp_path, columns={"documented_col": {}})
    monkeypatch.setattr(
        documentation, "probe_warehouse_columns",
        AsyncMock(return_value=ProbeResult(columns=(), error="not built")),
    )
    model["answer"] = json.dumps({"description": "x", "columns": {}})
    await _generate(root)
    assert model["prompt_columns"] == ["documented_col"]


async def test_nothing_to_change_raises(tmp_path, model):
    schema = (
        "models:\n  - name: orders\n    description: Done.\n    columns:\n"
        "      - name: id\n        description: a\n      - name: amount\n        description: b\n"
    )
    root = _project(tmp_path, schema=schema)
    model["answer"] = json.dumps({"description": "x", "columns": {"id": "y"}})
    with pytest.raises(NothingToDocument, match="already has a description"):
        await _generate(root)


async def test_unusable_answer_raises(tmp_path, model, monkeypatch):
    root = _project(tmp_path)

    def _bad(raw, cols):
        raise ValueError("not valid JSON")

    monkeypatch.setattr(pro, "parse_documentation", _bad)
    with pytest.raises(DocumentationError, match="wasn't usable"):
        await _generate(root)


async def test_unsupported_node(tmp_path, model):
    root = _project(tmp_path)
    (root / "target" / "manifest.json").write_text(
        json.dumps({"nodes": {UID: {"name": "orders", "resource_type": "test"}}})
    )
    with pytest.raises(DocumentationError, match="not supported"):
        await _generate(root)


async def test_missing_manifest(tmp_path, model):
    with pytest.raises(DocumentationError, match="manifest not found"):
        await _generate(tmp_path)

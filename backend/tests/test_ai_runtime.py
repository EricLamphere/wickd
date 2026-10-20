import json
from pathlib import Path

import pytest

from app.ai import runtime
from app.ai.catalog import MODELS
from app.ai.runtime import LlamaServer, RuntimeUnavailable, build_args, find_llama_server
from app.config import settings


def test_override_path_wins(tmp_path, monkeypatch):
    binary = tmp_path / "llama-server"
    binary.write_text("")
    monkeypatch.setattr(settings, "llama_server_path", binary)
    assert find_llama_server() == binary


def test_missing_override_is_not_found(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "llama_server_path", tmp_path / "nope")
    assert find_llama_server() is None


def test_dev_copy_then_path(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "llama_server_path", None)
    monkeypatch.setattr(runtime, "_repo_runtime_dir", lambda: tmp_path)
    monkeypatch.setattr(runtime.shutil, "which", lambda name: "/usr/local/bin/llama-server")
    assert find_llama_server() == Path("/usr/local/bin/llama-server")
    (tmp_path / "llama-server").write_text("")
    assert find_llama_server() == tmp_path / "llama-server"


def test_build_args(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    args = build_args(Path("/bin/llama-server"), MODELS[0], 1234)
    assert args[0] == "/bin/llama-server"
    assert args[args.index("--model") + 1] == str(tmp_path / "models" / MODELS[0].filename)
    assert args[args.index("--port") + 1] == "1234"
    assert args[args.index("--host") + 1] == "127.0.0.1"
    kwargs = json.loads(args[args.index("--chat-template-kwargs") + 1])
    assert kwargs == {"enable_thinking": False}


async def test_ensure_without_binary_raises(monkeypatch):
    monkeypatch.setattr(runtime, "find_llama_server", lambda: None)
    with pytest.raises(RuntimeUnavailable, match="isn't installed"):
        await LlamaServer().ensure(MODELS[0])


async def test_ensure_without_model_raises(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(runtime, "find_llama_server", lambda: tmp_path / "llama-server")
    with pytest.raises(RuntimeUnavailable, match="hasn't been downloaded"):
        await LlamaServer().ensure(MODELS[0])


async def test_process_that_exits_reports_stderr(tmp_path, monkeypatch):
    """A binary that dies during startup surfaces its stderr instead of hanging."""
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    (tmp_path / "models").mkdir()
    (tmp_path / "models" / MODELS[0].filename).write_bytes(b"x")
    script = tmp_path / "llama-server"
    script.write_text("#!/bin/sh\necho 'error: failed to load model' >&2\nexit 1\n")
    script.chmod(0o755)
    monkeypatch.setattr(runtime, "find_llama_server", lambda: script)
    server = LlamaServer()
    with pytest.raises(RuntimeUnavailable, match="failed to load model"):
        await server.ensure(MODELS[0])
    assert server.running_model is None

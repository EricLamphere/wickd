"""Markdown docs pages (plan 28): folder resolution, path safety, docs block handling."""

from pathlib import Path

import pytest

from app.docs_pages import blocks, service
from app.docs_pages.service import DocsPagesError


def _repo(tmp_path: Path) -> tuple[Path, Path]:
    repo = tmp_path.resolve() / "repo"
    project = repo / "analytics"
    project.mkdir(parents=True)
    return repo, project


# ---- resolve_docs_dir ----


def test_resolve_prefers_project_docs(tmp_path: Path) -> None:
    repo, project = _repo(tmp_path)
    (project / "docs").mkdir()
    (repo / "docs").mkdir()
    assert service.resolve_docs_dir(project, repo, None) == project / "docs"


def test_resolve_falls_back_to_repo_root_docs(tmp_path: Path) -> None:
    repo, project = _repo(tmp_path)
    (repo / "docs").mkdir()
    assert service.resolve_docs_dir(project, repo, "") == repo / "docs"


def test_resolve_without_repo_ignores_parent_docs(tmp_path: Path) -> None:
    _, project = _repo(tmp_path)
    (project.parent / "docs").mkdir()
    assert service.resolve_docs_dir(project, None, None) is None


def test_resolve_setting(tmp_path: Path) -> None:
    repo, project = _repo(tmp_path)
    (project / "handbook").mkdir()
    (repo / "shared").mkdir()
    assert service.resolve_docs_dir(project, repo, "handbook") == project / "handbook"
    assert service.resolve_docs_dir(project, repo, "../shared") == repo / "shared"
    assert service.resolve_docs_dir(project, repo, "missing") is None


def test_resolve_setting_outside_repo_refused(tmp_path: Path) -> None:
    repo, project = _repo(tmp_path)
    (tmp_path / "elsewhere").mkdir()
    with pytest.raises(DocsPagesError) as exc:
        service.resolve_docs_dir(project, repo, "../../elsewhere")
    assert exc.value.code == "bad_path"


# ---- safe_join ----


def test_safe_join_accepts_nested(tmp_path: Path) -> None:
    (tmp_path / "a").mkdir()
    assert service.safe_join(tmp_path, "a/b.md") == tmp_path.resolve() / "a" / "b.md"


@pytest.mark.parametrize("rel", ["../x.md", "a/../../x.md", "/etc/passwd", "", ".", "a\x00b"])
def test_safe_join_refuses_escapes(tmp_path: Path, rel: str) -> None:
    with pytest.raises(DocsPagesError):
        service.safe_join(tmp_path / "docs", rel)


def test_safe_join_refuses_symlink_out(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    docs.mkdir()
    (tmp_path / "secret.png").write_bytes(b"x")
    (docs / "link.png").symlink_to(tmp_path / "secret.png")
    with pytest.raises(DocsPagesError):
        service.safe_join(docs, "link.png")


# ---- titles and listing ----


def test_page_title_skips_code_fences() -> None:
    text = "intro\n```\n# not a title\n```\n## Sub\n# Real title #\n"
    assert service.page_title(text, "fallback") == "Real title"
    assert service.page_title("no heading", "fallback") == "fallback"


def test_list_pages(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    (docs / "guides").mkdir(parents=True)
    (docs / ".hidden").mkdir()
    (docs / "index.md").write_text("# Welcome\n")
    (docs / "guides" / "setup.markdown").write_text("Setup steps\n")
    (docs / "_draft.md").write_text("# Draft\n")
    (docs / ".hidden" / "x.md").write_text("# x\n")
    (docs / "notes.txt").write_text("not markdown\n")
    (docs / "blocks.md").write_text("{% docs orders %}Orders.{% enddocs %}\n")
    (docs / "mixed.md").write_text("# Mixed\n{% docs a %}A{% enddocs %}\n")

    pages = service.list_pages(docs)

    assert [(p.path, p.title, p.folder) for p in pages] == [
        ("index.md", "Welcome", ""),
        ("mixed.md", "Mixed", ""),
        ("guides/setup.markdown", "setup", "guides"),
    ]


def test_image_type() -> None:
    assert service.image_type(Path("a.SVG")) == "image/svg+xml"
    with pytest.raises(DocsPagesError):
        service.image_type(Path("a.md"))


# ---- docs blocks ----


def test_classify() -> None:
    assert blocks.classify("# Page") == "page"
    assert blocks.classify("{% docs a %}A{% enddocs %}\n\n{%- docs b -%}B{%- enddocs -%}") == "blocks_only"
    assert blocks.classify("# Title\n{% docs a %}A{% enddocs %}") == "mixed"


def test_segments() -> None:
    parts = blocks.segments("# Title\n\n{% docs status %}\nOne of *a*, *b*.\n{% enddocs %}\nAfter\n")
    assert parts == [
        {"kind": "markdown", "text": "# Title\n\n"},
        {"kind": "docs_block", "name": "status", "text": "One of *a*, *b*."},
        {"kind": "markdown", "text": "\nAfter\n"},
    ]


def test_usage_from_doc_blocks() -> None:
    manifest = {
        "docs": {"doc.p.status": {"name": "status", "block_contents": "x"}},
        "nodes": {
            "model.p.orders": {"resource_type": "model", "doc_blocks": [], "columns": {"s": {"doc_blocks": ["doc.p.status"]}}},
            "model.p.other": {"resource_type": "model", "doc_blocks": ["doc.p.other"], "columns": {}},
            "test.p.t": {"resource_type": "test", "doc_blocks": ["doc.p.status"]},
        },
        "sources": {"source.p.raw.orders": {"resource_type": "source", "doc_blocks": ["doc.p.status"]}},
    }
    assert blocks.docs_block_usage(manifest, {"status"}) == {"status": ["model.p.orders", "source.p.raw.orders"]}


def test_usage_falls_back_to_descriptions() -> None:
    body = "Status of the order: placed, shipped or returned."
    manifest = {
        "docs": {"doc.p.status": {"name": "status", "block_contents": body}, "doc.p.tiny": {"name": "tiny", "block_contents": "ok"}},
        "nodes": {
            "model.p.orders": {"resource_type": "model", "description": "", "columns": {"s": {"description": body}}},
            "model.p.x": {"resource_type": "model", "description": "ok"},
        },
    }
    assert blocks.docs_block_usage(manifest, {"status", "tiny"}) == {"status": ["model.p.orders"], "tiny": []}

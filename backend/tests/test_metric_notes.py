"""Metric notes (plan 30): format, matching, the store (images, delete) and the routes."""

import asyncio
import json
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.engine import get_session
from app.db.models import Base, Project
from app.events.bus import bus
from app.main import app
from app.semantic import note_store, notes
from app.semantic.notes import Note, NoteError

CASES = json.loads((Path(__file__).parent / "fixtures" / "notes" / "match_cases.json").read_text())
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32

NOTE = """---
title: EU checkout outage
start: 2026-11-03
end: 2026-11-04
metric: revenue
dimension: order__region
value: EU
created: '2026-11-05T14:02:00Z'
owner: data-team
---

Checkout returned 500s.

![error rate](../img/eu-checkout-outage-1.png)
"""


# ── format ───────────────────────────────────────────────────────────────────


def test_parse_render_round_trip_keeps_unknown_keys() -> None:
    note = notes.parse(NOTE)
    assert note.meta.title == "EU checkout outage"
    assert (note.meta.start, note.meta.end) == ("2026-11-03", "2026-11-04")
    assert note.meta.metrics == ["revenue"]
    assert note.meta.model_extra == {"owner": "data-team"}
    assert note.body.startswith("Checkout returned")
    assert notes.render(note) == NOTE
    assert notes.parse(notes.render(note)) == note


def test_metrics_list_and_numeric_value() -> None:
    meta = notes.validate_meta({"title": "t", "start": "2026-01-01", "end": "2026-01-01",
                                "metrics": ["a", "b"], "dimension": "year", "value": 2024})
    assert meta.metrics == ["a", "b"] and meta.value == "2024"
    assert "metrics:\n- a\n- b" in notes.render(Note(meta, ""))


@pytest.mark.parametrize("data, field", [
    ({"title": "t", "start": "2026-01-05", "end": "2026-01-04"}, None),
    ({"title": "t", "start": "2026-01-05", "end": "2026-01-05", "value": "EU"}, None),
    ({"title": "t", "start": "2026-02-30", "end": "2026-03-01"}, "start"),
    ({"start": "2026-01-05", "end": "2026-01-05"}, "title"),
])
def test_invalid_meta_refused(data: dict, field: str | None) -> None:
    with pytest.raises(NoteError) as exc:
        notes.validate_meta(data)
    assert exc.value.code == "invalid_note"
    if field:
        assert exc.value.field == field


def test_parse_errors() -> None:
    with pytest.raises(NoteError, match="frontmatter"):
        notes.parse("no frontmatter here")
    with pytest.raises(NoteError) as exc:
        notes.parse("---\ntitle: [unclosed\n---\nbody")
    assert exc.value.code == "invalid_yaml"


def test_slugs() -> None:
    assert notes.slugify("EU checkout — outage!") == "eu-checkout-outage"
    assert notes.slugify("???") == "note"
    assert notes.unique_slug("a", {"a", "a-2"}) == "a-3"


def test_image_refs() -> None:
    body = '![x](../img/a.png) ![y](<../img/b c.png>) ![z](https://x/y.png) <img src="c.gif"> ![x](../img/a.png)'
    assert notes.image_refs(body) == ["../img/a.png", "c.gif"]


@pytest.mark.parametrize("case", CASES["cases"], ids=lambda c: c["name"])
def test_matches_shared_table(case: dict) -> None:
    raw = CASES["notes"][case["note"]]
    meta = notes.validate_meta({"title": "t", **raw})
    ctx = case["ctx"]
    dims = ctx.get("metric_dimensions")
    got = notes.matches(meta, start=ctx["start"], end=ctx["end"], metric=ctx.get("metric"), dims=ctx.get("dims"),
                        metric_dimensions=set(dims) if dims is not None else None)
    assert got is case["expect"]


# ── store ────────────────────────────────────────────────────────────────────


def _folders(tmp_path: Path) -> note_store.Folders:
    (tmp_path / "proj").mkdir(exist_ok=True)
    return note_store.folders(tmp_path / "proj", None, None)


def test_folders_must_be_inside_project(tmp_path: Path) -> None:
    f = _folders(tmp_path)
    assert f.notes == (tmp_path / "proj" / "wickd" / "notes").resolve()
    with pytest.raises(NoteError) as exc:
        note_store.folders(tmp_path / "proj", "../out", None)
    assert exc.value.field == "NOTES_PATH"


def test_invalid_file_listed_with_its_error(tmp_path: Path) -> None:
    f = _folders(tmp_path)
    f.notes.mkdir(parents=True)
    (f.notes / "good.md").write_text(NOTE)
    (f.notes / "bad.md").write_text("---\ntitle: x\nstart: 2026-01-02\nend: 2026-01-01\n---\n")
    (f.notes / "Not A Slug.md").write_text(NOTE)
    entries = {e.slug: e for e in note_store.list_notes(f)}
    assert set(entries) == {"good", "bad"}
    assert entries["good"].note is not None and entries["good"].error is None
    assert entries["bad"].note is None and "end must be on or after start" in (entries["bad"].error or "")


def test_save_image_names_and_refuses_non_images(tmp_path: Path) -> None:
    f = _folders(tmp_path)
    assert note_store.save_image(f, "EU outage", PNG) == "../img/eu-outage-1.png"
    assert note_store.save_image(f, "EU outage", b"\xff\xd8\xff" + b"\0" * 8) == "../img/eu-outage-2.jpg"
    with pytest.raises(NoteError) as exc:
        note_store.save_image(f, "x", b"<svg onload=alert(1)>")
    assert exc.value.code == "not_image"
    with pytest.raises(NoteError) as exc:
        note_store.save_image(f, "x", PNG + b"\0" * note_store.MAX_IMAGE_BYTES)
    assert exc.value.code == "too_large"


def test_asset_refuses_paths_outside_the_folders(tmp_path: Path) -> None:
    f = _folders(tmp_path)
    rel = note_store.save_image(f, "a", PNG)
    assert note_store.asset(f, rel)[1] == "image/png"
    (tmp_path / "proj" / "secret.png").write_bytes(PNG)
    for bad in ("../../secret.png", "/etc/passwd", "../../../x.png"):
        with pytest.raises(NoteError):
            note_store.asset(f, bad)
    f.notes.mkdir(parents=True, exist_ok=True)
    (f.notes / "x.txt").write_text("hi")
    with pytest.raises(NoteError) as exc:
        note_store.asset(f, "x.txt")
    assert exc.value.code == "not_image"


def test_delete_keeps_shared_images(tmp_path: Path) -> None:
    f = _folders(tmp_path)
    own = note_store.save_image(f, "a", PNG)
    shared = note_store.save_image(f, "s", PNG)
    meta = notes.validate_meta({"title": "a", "start": "2026-01-01", "end": "2026-01-01"})
    note_store.write(f, "a", Note(meta, f"![]({own}) ![]({shared})"), create=True)
    note_store.write(f, "b", Note(meta, f"![]({shared})"), create=True)
    assert [p.name for p in note_store.images_only_in(f, "a")] == ["a-1.png"]
    removed = note_store.delete(f, "a", remove_images=True)
    assert removed == ["wickd/img/a-1.png"]
    assert not (f.images / "a-1.png").exists() and (f.images / "s-1.png").exists()
    with pytest.raises(NoteError):
        note_store.write(f, "b", Note(meta, ""), create=True)


# ── routes ───────────────────────────────────────────────────────────────────


@pytest.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    async def _get_session():
        async with sessions() as s:
            yield s

    app.dependency_overrides[get_session] = _get_session
    async with sessions() as session:
        yield session
    app.dependency_overrides.pop(get_session, None)
    await engine.dispose()


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def _project(db: AsyncSession, tmp_path: Path) -> tuple[int, Path]:
    root = tmp_path.resolve() / "proj"
    (root / "target").mkdir(parents=True)
    (root / "target" / "semantic_manifest.json").write_text(json.dumps({
        "metrics": [{"name": "revenue"}],
        "semantic_models": [{"entities": [{"name": "order", "type": "primary"}], "dimensions": [{"name": "region"}]}],
    }))
    project = Project(name="proj", path=str(root), platform="duckdb")
    db.add(project)
    await db.commit()
    return project.id, root


BODY = {"title": "EU checkout outage", "start": "2026-11-03", "end": "2026-11-04", "metrics": ["revenue"],
        "dimension": "order__region", "value": "EU", "body": "Down."}


async def test_crud_and_event(db: AsyncSession, client: AsyncClient, tmp_path: Path) -> None:
    pid, root = await _project(db, tmp_path)
    queue = await bus.subscribe(f"project:{pid}")
    try:
        created = (await client.post(f"/api/projects/{pid}/metric-notes", json=BODY)).json()
        event = await asyncio.wait_for(queue.get(), timeout=2.0)
        assert (event.type, event.data) == ("metric_notes_changed", {"slug": "eu-checkout-outage"})
    finally:
        await bus.unsubscribe(f"project:{pid}", queue)
    assert created["slug"] == "eu-checkout-outage" and created["warnings"] == [] and created["created"]
    assert (root / "wickd" / "notes" / "eu-checkout-outage.md").read_text().startswith("---\ntitle: EU checkout outage")
    second = (await client.post(f"/api/projects/{pid}/metric-notes", json={**BODY, "metrics": ["gone"]})).json()
    assert second["slug"] == "eu-checkout-outage-2" and "`gone`" in second["warnings"][0]

    listed = (await client.get(f"/api/projects/{pid}/metric-notes")).json()
    assert listed["folder"] == "wickd/notes" and listed["img_folder"] == "wickd/img"
    assert [n["slug"] for n in listed["notes"]] == ["eu-checkout-outage", "eu-checkout-outage-2"]

    saved = await client.put(f"/api/projects/{pid}/metric-notes/eu-checkout-outage",
                             json={**BODY, "title": "Renamed", "base_modified_at": created["modified_at"]})
    assert saved.status_code == 200 and saved.json()["title"] == "Renamed"
    assert saved.json()["created"] == created["created"]
    assert (await client.delete(f"/api/projects/{pid}/metric-notes/eu-checkout-outage")).status_code == 204
    assert (await client.get(f"/api/projects/{pid}/metric-notes/eu-checkout-outage")).status_code == 404


async def test_put_conflict_and_unknown_keys_kept(db: AsyncSession, client: AsyncClient, tmp_path: Path) -> None:
    pid, root = await _project(db, tmp_path)
    (root / "wickd" / "notes").mkdir(parents=True)
    path = root / "wickd" / "notes" / "n.md"
    path.write_text(NOTE)
    loaded = (await client.get(f"/api/projects/{pid}/metric-notes/n")).json()
    stale = {**BODY, "base_modified_at": "2000-01-01T00:00:00+00:00"}
    assert (await client.put(f"/api/projects/{pid}/metric-notes/n", json=stale)).status_code == 409
    ok = await client.put(f"/api/projects/{pid}/metric-notes/n", json={**BODY, "base_modified_at": loaded["modified_at"]})
    assert ok.status_code == 200
    assert "owner: data-team" in path.read_text()


async def test_validation_error_names_the_field(db: AsyncSession, client: AsyncClient, tmp_path: Path) -> None:
    pid, _ = await _project(db, tmp_path)
    res = await client.post(f"/api/projects/{pid}/metric-notes", json={**BODY, "end": "2026-11-01"})
    assert res.status_code == 400 and res.json()["detail"]["error"] == "invalid_note"
    res = await client.post(f"/api/projects/{pid}/metric-notes", json={**BODY, "value": None})
    assert res.status_code == 400


async def test_image_upload_and_asset(db: AsyncSession, client: AsyncClient, tmp_path: Path) -> None:
    pid, _ = await _project(db, tmp_path)
    up = await client.post(f"/api/projects/{pid}/metric-notes/images", data={"name": "EU outage"},
                           files={"file": ("paste.png", PNG, "image/png")})
    assert up.status_code == 201 and up.json() == {"path": "../img/eu-outage-1.png"}
    got = await client.get(f"/api/projects/{pid}/metric-notes/asset", params={"path": up.json()["path"]})
    assert got.status_code == 200 and got.headers["content-type"] == "image/png"
    bad = await client.post(f"/api/projects/{pid}/metric-notes/images", files={"file": ("x.png", b"nope", "image/png")})
    assert bad.status_code == 400
    outside = await client.get(f"/api/projects/{pid}/metric-notes/asset", params={"path": "../../target/semantic_manifest.json"})
    assert outside.status_code == 400


async def test_delete_with_images(db: AsyncSession, client: AsyncClient, tmp_path: Path) -> None:
    pid, root = await _project(db, tmp_path)
    up = (await client.post(f"/api/projects/{pid}/metric-notes/images", files={"file": ("a.png", PNG, "image/png")})).json()
    await client.post(f"/api/projects/{pid}/metric-notes", json={**BODY, "body": f"![]({up['path']})"})
    orphans = (await client.get(f"/api/projects/{pid}/metric-notes/eu-checkout-outage/orphan-images")).json()
    assert orphans == {"images": ["wickd/img/note-1.png"]}
    res = await client.delete(f"/api/projects/{pid}/metric-notes/eu-checkout-outage", params={"remove_images": True})
    assert res.status_code == 204 and not (root / "wickd" / "img" / "note-1.png").exists()


# ── plan 33: tags, incidents, recurring notes, mentions, the saved widget ────


def test_new_fields_round_trip_in_order() -> None:
    meta = notes.validate_meta({
        "title": "Outage", "start": "2026-11-03", "end": "2026-11-04", "tags": "#outage, checkout, Outage",
        "status": "resolved", "resolved": "2026-11-05", "recurs": "yearly", "commits": ["ABCDEF1"],
        "widget": {"type": "timeseries", "metrics": ["revenue"]}, "source": {"dashboard": "kpis", "widget": "w1"},
    })
    assert meta.tags == ["outage", "checkout"]
    text = notes.render(Note(meta=meta, body="x"))
    keys = [line.split(":")[0] for line in text.splitlines()[1:] if line and not line.startswith((" ", "-", "---"))]
    assert meta.type == "incident"  # a status without a type is an incident
    assert keys[:10] == ["title", "start", "end", "tags", "type", "status", "resolved", "recurs", "commits", "widget"]
    again = notes.parse(text).meta
    assert again.widget == {"type": "timeseries", "metrics": ["revenue"]} and again.resolved == "2026-11-05"


@pytest.mark.parametrize("data", [
    {"status": "closed"},
    {"recurs": "weekly"},
    {"resolved": "2026-11-05"},
    {"status": "open", "resolved": "2026-11-05"},
    {"commits": ["not-a-sha"]},
    {"type": "release", "status": "open"},
    {"type": "outage"},
    {"widget": {"x": "y" * 30_000}},
])
def test_new_fields_refused(data: dict) -> None:
    with pytest.raises(NoteError):
        notes.validate_meta({"title": "t", "start": "2026-11-03", "end": "2026-11-03", **data})


def test_mentions_skip_code_and_dedupe() -> None:
    meta = notes.validate_meta({"title": "t", "start": "2026-11-03", "end": "2026-11-03", "models": ["stg_orders"]})
    body = ("See model:fct_orders. Also model:fct_orders and model:stg_orders, commit:3F2A9C1, note:eu-rollback and [[old-link|x]].\n"
            "`model:in_code` and email@model:x\n```\nmodel:fenced commit:aaaaaaa\n```\n")
    m = notes.mentions(body, meta)
    assert m.models == ["stg_orders", "fct_orders"]
    assert m.commits == ["3f2a9c1"]
    assert m.links == ["eu-rollback", "old-link"]


def test_occurrences() -> None:
    plain = notes.validate_meta({"title": "t", "start": "2026-11-03", "end": "2026-11-04"})
    assert notes.occurrences(plain, "2026-11-04", "2026-12-01") == [("2026-11-03", "2026-11-04")]
    assert notes.occurrences(plain, "2027-11-03", "2027-11-04") == []
    yearly = plain.model_copy(update={"recurs": "yearly"})
    assert notes.occurrences(yearly, "2024-01-01", "2026-12-31") == [
        ("2024-11-03", "2024-11-04"), ("2025-11-03", "2025-11-04"), ("2026-11-03", "2026-11-04")]


async def test_api_new_fields_and_mentions(db: AsyncSession, client: AsyncClient, tmp_path: Path) -> None:
    pid, root = await _project(db, tmp_path)
    body = {**BODY, "tags": ["outage"], "type": "incident", "status": "open", "recurs": None,
            "widget": {"type": "summary", "metrics": ["revenue"]}, "source": {"dashboard": "kpis", "widget": "w1"},
            "body": "Caused by model:stg_payments, see commit:3f2a9c1 and note:eu-rollback."}
    created = (await client.post(f"/api/projects/{pid}/metric-notes", json=body)).json()
    assert created["tags"] == ["outage"] and created["type"] == "incident" and created["status"] == "open"
    assert (created["models"], created["commits"], created["links"]) == (["stg_payments"], ["3f2a9c1"], ["eu-rollback"])
    assert created["widget"] == {"type": "summary", "metrics": ["revenue"]}
    # a hand-written `commits:` list survives a save from the editor (which doesn't show it)
    path = root / "wickd" / "notes" / f"{created['slug']}.md"
    path.write_text(path.read_text().replace("status: open\n", "status: open\ncommits:\n- abcdef1\n"))
    saved = (await client.put(f"/api/projects/{pid}/metric-notes/{created['slug']}",
                              json={**body, "status": "resolved", "resolved": "2026-11-06"})).json()
    assert saved["status"] == "resolved" and saved["resolved"] == "2026-11-06"
    assert saved["commits"] == ["abcdef1", "3f2a9c1"]
    # a resolved date without `resolved` status is dropped, not an error
    reopened = (await client.put(f"/api/projects/{pid}/metric-notes/{created['slug']}",
                                 json={**body, "status": "open", "resolved": "2026-11-06"})).json()
    assert reopened["status"] == "open" and reopened["resolved"] is None


def test_note_types() -> None:
    base = {"title": "t", "start": "2026-11-03", "end": "2026-11-03"}
    assert notes.validate_meta(base).type is None
    assert notes.validate_meta({**base, "type": "note"}).type is None
    release = notes.validate_meta({**base, "type": "release"})
    assert "type: release" in notes.render(Note(meta=release, body=""))
    assert "type:" not in notes.render(Note(meta=notes.validate_meta(base), body=""))


async def test_api_type_drops_status_off_incidents(db: AsyncSession, client: AsyncClient, tmp_path: Path) -> None:
    pid, _ = await _project(db, tmp_path)
    created = (await client.post(f"/api/projects/{pid}/metric-notes",
                                 json={**BODY, "type": "release", "status": "open", "resolved": "2026-11-05"})).json()
    assert (created["type"], created["status"], created["resolved"]) == ("release", None, None)
    plain = (await client.post(f"/api/projects/{pid}/metric-notes", json={**BODY, "title": "Plain"})).json()
    assert plain["type"] == "note"

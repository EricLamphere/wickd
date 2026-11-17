"""Metric notes (plan 30): the file format and which notes apply to what.

A note is a Markdown file with YAML frontmatter, `<NOTES_PATH>/<slug>.md`:

    ---
    title: EU checkout outage
    start: 2026-11-03
    end: 2026-11-04          # inclusive; equal to start for a single day
    metric: revenue          # optional (or `metrics: [a, b]`)
    dimension: order__region # optional, together with `value`
    value: EU
    created: 2026-11-05T14:02:00Z
    ---
    Checkout returned 500s for EU cards…

A note with no metric applies to every metric; one with a dimension value applies where
that dimension isn't pinned to another value. Unknown frontmatter keys are kept on save.
`matches()` is mirrored by the frontend's `lib/metricNotes.ts` `noteMatches()`.

The files themselves (folders, images, writes) are `note_store.py`.
"""

import re
from dataclasses import dataclass
from datetime import date, datetime
from typing import Annotated, Any

import yaml
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    field_validator,
    model_validator,
)

SLUG_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,79}$"
_SLUG = re.compile(SLUG_PATTERN)
_FRONTMATTER = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.DOTALL)
MAX_BODY_CHARS = 200_000
MAX_METRICS = 20

IsoDate = Annotated[str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}$")]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]


class NoteError(Exception):
    def __init__(self, code: str, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.field = field


def _iso(value: Any) -> Any:
    """YAML reads `2026-11-03` as a date; the model keeps ISO strings."""
    if isinstance(value, datetime):
        return value.isoformat().replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    return value


class NoteMeta(BaseModel):
    """The frontmatter. Unknown keys (a newer wickd, a hand edit) are kept through a round trip."""

    model_config = ConfigDict(extra="allow")

    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    start: IsoDate
    end: IsoDate
    metrics: list[Name] = Field(default_factory=list, max_length=MAX_METRICS)
    dimension: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] | None = None
    value: Annotated[str, StringConstraints(max_length=500)] | None = None
    created: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _normalise(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        out = {k: _iso(v) for k, v in data.items()}
        single = out.pop("metric", None)
        many = out.get("metrics")
        metrics = [single] if single not in (None, "") else []
        if isinstance(many, list):
            metrics += [m for m in many if m not in metrics]
        elif many not in (None, ""):
            metrics.append(many)
        out["metrics"] = metrics
        if out.get("value") is not None and not isinstance(out["value"], str):
            out["value"] = str(out["value"])  # `value: 2024` is a number in YAML
        for key in ("dimension", "value"):
            if out.get(key) == "":
                out[key] = None
        return out

    @field_validator("start", "end")
    @classmethod
    def _real_date(cls, v: str) -> str:
        try:
            date.fromisoformat(v)
        except ValueError as exc:
            raise ValueError(f"{v} isn't a date") from exc
        return v

    @model_validator(mode="after")
    def _consistent(self) -> "NoteMeta":
        if self.end < self.start:
            raise ValueError("end must be on or after start")
        if (self.dimension is None) != (self.value is None):
            raise ValueError("a dimension and its value go together: set both or neither")
        return self


@dataclass(frozen=True)
class Note:
    meta: NoteMeta
    body: str


def check_slug(slug: str) -> str:
    if not _SLUG.fullmatch(slug):
        raise NoteError("bad_slug", "a note name may only use lowercase letters, digits, `-` and `_`")
    return slug


def is_slug(slug: str) -> bool:
    return bool(_SLUG.fullmatch(slug))


def slugify(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:60].strip("-")
    return slug or "note"


def unique_slug(base: str, taken: set[str]) -> str:
    """`base`, else `base-2`, `base-3`, …"""
    slug, n = base, 2
    while slug in taken:
        slug, n = f"{base}-{n}", n + 1
    return slug


def validation_message(exc: ValidationError) -> tuple[str, str | None]:
    """The first few errors as one message, and the field of the first."""
    errors = exc.errors()
    parts = []
    for err in errors[:5]:
        where = ".".join(str(p) for p in err.get("loc", ()))
        msg = str(err.get("msg", "")).removeprefix("Value error, ")
        parts.append(f"{where}: {msg}" if where else msg)
    first = errors[0].get("loc", ()) if errors else ()
    return "; ".join(parts), (str(first[0]) if first else None)


def validate_meta(data: dict[str, Any]) -> NoteMeta:
    try:
        return NoteMeta.model_validate(data)
    except ValidationError as exc:
        message, field = validation_message(exc)
        raise NoteError("invalid_note", message, field or None) from exc


def parse(text: str) -> Note:
    match = _FRONTMATTER.match(text)
    if not match:
        raise NoteError("invalid_note", "a note starts with a `---` frontmatter block holding title, start and end")
    try:
        data = yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:
        raise NoteError("invalid_yaml", f"the frontmatter isn't valid YAML: {exc}") from exc
    if not isinstance(data, dict):
        raise NoteError("invalid_note", "the frontmatter must be a mapping with title, start and end")
    return Note(meta=validate_meta(data), body=text[match.end():].lstrip("\r\n"))


def to_frontmatter(meta: NoteMeta) -> dict[str, Any]:
    """Key order: title, start, end, metric(s), dimension, value, created, then unknown keys."""
    data: dict[str, Any] = {"title": meta.title, "start": date.fromisoformat(meta.start),
                            "end": date.fromisoformat(meta.end)}
    if len(meta.metrics) == 1:
        data["metric"] = meta.metrics[0]
    elif meta.metrics:
        data["metrics"] = list(meta.metrics)
    if meta.dimension is not None:
        data["dimension"] = meta.dimension
        data["value"] = meta.value
    if meta.created:
        data["created"] = meta.created
    return {**data, **(meta.model_extra or {})}


def render(note: Note) -> str:
    front = yaml.safe_dump(to_frontmatter(note.meta), sort_keys=False, allow_unicode=True, width=120)
    body = note.body.lstrip("\n")
    return f"---\n{front}---\n\n{body}" if body else f"---\n{front}---\n"


# ── which notes apply ────────────────────────────────────────────────────────


def same_dimension(a: str, b: str) -> bool:
    """`order__region` and `region` name the same dimension; so does `metric_time__day` → its root."""
    a, b = a.strip().lower(), b.strip().lower()
    return a == b or a.endswith(f"__{b}") or b.endswith(f"__{a}")


def matches(
    meta: NoteMeta,
    *,
    start: str,
    end: str,
    metric: str | None = None,
    dims: dict[str, str] | None = None,
    metric_dimensions: set[str] | None = None,
) -> bool:
    """Does the note apply to `metric` over [start, end] (inclusive ISO dates)?

    - the ranges overlap (touching at an edge counts);
    - a note tied to metrics applies only to those (any metric when `metric` is None);
    - a note with a dimension value doesn't apply where `dims` pins that dimension to another
      value, nor (with no metric of its own) to a metric that lacks the dimension, when
      `metric_dimensions` says which dimensions the metric has.
    """
    if meta.start > end or meta.end < start:
        return False
    if metric is not None and meta.metrics and metric not in meta.metrics:
        return False
    if meta.dimension is None:
        return True
    if not meta.metrics and metric_dimensions is not None and not any(
        same_dimension(meta.dimension, d) for d in metric_dimensions
    ):
        return False
    for dim, value in (dims or {}).items():
        if same_dimension(meta.dimension, dim) and str(value).strip().lower() != str(meta.value).strip().lower():
            return False
    return True


# ── images a body references ─────────────────────────────────────────────────

_MD_IMAGE = re.compile(r"!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
_HTML_IMAGE = re.compile(r"<img\b[^>]*\bsrc=[\"']([^\"']+)[\"']", re.IGNORECASE)


def image_refs(body: str) -> list[str]:
    """Relative image paths in the body (links with a scheme or an absolute path are left out)."""
    found = _MD_IMAGE.findall(body) + _HTML_IMAGE.findall(body)
    out: list[str] = []
    for ref in found:
        if re.match(r"^[a-z][a-z0-9+.-]*:", ref, re.IGNORECASE) or ref.startswith(("/", "#")):
            continue
        if ref not in out:
            out.append(ref)
    return out

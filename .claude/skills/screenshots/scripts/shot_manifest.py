"""Pure logic for shots.json: validation, feature coverage, and step → JS."""

from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass, field
from typing import Any

TIERS = ("pro", "base")
THEMES = ("dark", "light")
README_FEATURE = re.compile(r"^- \*\*(.+?)\*\*")
GALLERY_START = "<!-- screenshots:gallery:start -->"
GALLERY_END = "<!-- screenshots:gallery:end -->"
PREVIEW_START = "<!-- screenshots:preview:start -->"
PREVIEW_END = "<!-- screenshots:preview:end -->"
PREVIEW_SIZE = 4
SCREENSHOT_ASSET = re.compile(r".+_(1200|2400|2560)\.png")
HERO_ASSET_PATH = "../../assets/img"  # from tools/wickd/index.html
GALLERY_ASSET_PATH = "../../../assets/img"  # from tools/wickd/gallery/index.html
GALLERY_PLACES = ("main", "more")


class ManifestError(ValueError):
    """shots.json doesn't describe a usable set of screenshots."""


@dataclass(frozen=True)
class Shot:
    name: str
    tier: str
    theme: str
    features: tuple[str, ...]
    steps: tuple[dict[str, Any], ...]
    caption: str
    label: str
    alt: str
    pair: str | None = None
    site: dict[str, str] = field(default_factory=dict)
    storage: dict[str, str] = field(default_factory=dict)
    edits: str | None = None


def parse_shot(raw: dict[str, Any]) -> Shot:
    name = raw.get("name")
    if not name or not re.fullmatch(r"[a-z0-9_]+", name):
        raise ManifestError(f"bad shot name: {name!r}")
    if raw.get("tier") not in TIERS:
        raise ManifestError(f"{name}: tier must be one of {TIERS}")
    theme = raw.get("theme", "dark")
    if theme not in THEMES:
        raise ManifestError(f"{name}: theme must be one of {THEMES}")
    if not raw.get("features"):
        raise ManifestError(f"{name}: list the features it shows")
    for key in ("caption", "label", "alt"):
        if not raw.get(key):
            raise ManifestError(f"{name}: needs a {key}")
    site = raw.get("site", {})
    if site.get("gallery", "more") not in GALLERY_PLACES:
        raise ManifestError(f"{name}: site.gallery must be one of {GALLERY_PLACES}")
    if site.get("hero") and "gallery" in site:
        raise ManifestError(f"{name}: a hero has its own section, so it can't also be in the gallery")
    return Shot(
        name=name,
        tier=raw["tier"],
        theme=theme,
        features=tuple(raw["features"]),
        steps=tuple(raw.get("steps", ())),
        caption=raw["caption"],
        label=raw["label"],
        alt=raw["alt"],
        pair=raw.get("pair"),
        site=site,
        storage=raw.get("storage", {}),
        edits=raw.get("edits"),
    )


def load_shots(manifest: dict[str, Any]) -> tuple[Shot, ...]:
    shots = tuple(parse_shot(raw) for raw in manifest.get("shots", ()))
    names = [shot.name for shot in shots]
    duplicates = {name for name in names if names.count(name) > 1}
    if duplicates:
        raise ManifestError(f"duplicate shot names: {sorted(duplicates)}")
    return shots


def readme_features(readme: str) -> tuple[str, ...]:
    matches = (README_FEATURE.match(line) for line in features_section(readme).splitlines())
    return tuple(match.group(1) for match in matches if match)


def features_section(readme: str) -> str:
    _, found, rest = readme.partition("## Features\n")
    if not found:
        raise ManifestError("README.md has no '## Features' section")
    return rest.split("\n## ", 1)[0]


def coverage_problems(
    shots: tuple[Shot, ...],
    features: tuple[str, ...],
    not_shown: dict[str, str],
) -> tuple[str, ...]:
    """Everything wrong with the shot list: gaps, repeats, stale names, bad pairs."""
    known = set(features)
    by_name = {shot.name: shot for shot in shots}
    problems: list[str] = []

    covered = {feature for shot in shots for feature in shot.features}
    for feature in features:
        if feature not in covered and feature not in not_shown:
            problems.append(f"not in any shot: {feature}")
    for feature in sorted(set(not_shown) - known):
        problems.append(f"not_shown names a feature that isn't in the README: {feature}")
    for shot in shots:
        for feature in shot.features:
            if feature not in known:
                problems.append(f"{shot.name}: not a README feature: {feature}")
        problems.extend(_pair_problems(shot, by_name))

    problems.extend(_repeat_problems(shots))
    return tuple(problems)


def _pair_problems(shot: Shot, by_name: dict[str, Shot]) -> list[str]:
    if shot.pair is None:
        return []
    partner = by_name.get(shot.pair)
    if partner is None:
        return [f"{shot.name}: pair {shot.pair!r} doesn't exist"]
    if partner.pair != shot.name:
        return [f"{shot.name}: pair {shot.pair!r} doesn't pair back"]
    if partner.tier == shot.tier and partner.theme == shot.theme:
        return [f"{shot.name}: a pair must differ in tier or theme"]
    return []


def _repeat_problems(shots: tuple[Shot, ...]) -> list[str]:
    problems = []
    for index, shot in enumerate(shots):
        for other in shots[index + 1 :]:
            if shot.pair == other.name:
                continue
            for feature in sorted(set(shot.features) & set(other.features)):
                problems.append(f"{feature}: in both {shot.name} and {other.name}, which aren't a pair")
    return problems


def is_hero(shot: Shot) -> bool:
    return bool(shot.site.get("hero"))


def site_assets(shot: Shot) -> tuple[tuple[int, str], ...]:
    """(width, filename) of each resized copy the website needs."""
    return ((1200, f"{shot.name}_1200.png"), (_full_width(shot), f"{shot.name}_{_full_width(shot)}.png"))


def _full_width(shot: Shot) -> int:
    return 2560 if is_hero(shot) else 2400


def preview_shots(manifest: dict[str, Any], shots: tuple[Shot, ...]) -> tuple[Shot, ...]:
    """The product page's starter tiles, in the order the manifest's `preview` lists them."""
    names = manifest.get("preview", [])
    if len(names) != PREVIEW_SIZE or len(set(names)) != PREVIEW_SIZE:
        raise ManifestError(f"preview must list {PREVIEW_SIZE} different shots: {names}")
    by_name = {shot.name: shot for shot in shots}
    unknown = [name for name in names if name not in by_name]
    if unknown:
        raise ManifestError(f"preview names shots that don't exist: {unknown}")
    heroes = [name for name in names if is_hero(by_name[name])]
    if heroes:
        raise ManifestError(f"preview can't repeat a hero, which is already on the page: {heroes}")
    return tuple(by_name[name] for name in names)


def render_preview(preview: tuple[Shot, ...]) -> str:
    """The product page's starter tiles."""
    return _grid(preview, HERO_ASSET_PATH)


def render_gallery(shots: tuple[Shot, ...], preview: tuple[Shot, ...] = ()) -> str:
    """The gallery page's grid: every shot. Heroes, the preview, main, then the rest."""
    rest = [shot for shot in shots if not is_hero(shot) and shot not in preview]
    ordered = (
        *(shot for shot in shots if is_hero(shot)),
        *preview,
        *(shot for shot in rest if shot.site.get("gallery") == "main"),
        *(shot for shot in rest if shot.site.get("gallery") != "main"),
    )
    return _grid(ordered, GALLERY_ASSET_PATH)


def _grid(shots: tuple[Shot, ...], asset_path: str) -> str:
    items = "\n".join(_gallery_item(shot, "      ", asset_path) for shot in shots)
    return f'    <div class="gallery-grid">\n{items}\n    </div>'


def _gallery_item(shot: Shot, indent: str, asset_path: str) -> str:
    caption, label, alt = (html.escape(text, quote=True) for text in (shot.caption, shot.label, shot.alt))
    full = f"{asset_path}/{shot.name}_{_full_width(shot)}.png"
    return (
        f'{indent}<div class="gallery-item" data-full="{full}" data-cap="{caption}">\n'
        f'{indent}  <img src="{asset_path}/{shot.name}_1200.png" loading="lazy" alt="{alt}">\n'
        f'{indent}  <div class="gallery-cap">{label}</div>\n'
        f"{indent}</div>"
    )


def replace_gallery(page: str, gallery: str) -> str:
    return _replace_between(page, GALLERY_START, GALLERY_END, gallery)


def replace_preview(page: str, preview: str) -> str:
    return _replace_between(page, PREVIEW_START, PREVIEW_END, preview)


def _replace_between(page: str, start_marker: str, end_marker: str, content: str) -> str:
    before, start, rest = page.partition(start_marker)
    _, end, after = rest.partition(end_marker)
    if not start or not end:
        raise ManifestError(f"the page has no {start_marker} … {end_marker} block")
    return f"{before}{start_marker}\n{content}\n    {end_marker}{after}"


def set_hero_alt(page: str, shot: Shot) -> str:
    """A hero's image stays in its hand-written section; only its alt text follows the manifest."""
    pattern = rf'(src="{re.escape(HERO_ASSET_PATH)}/{re.escape(shot.name)}_2560\.png" alt=")[^"]*(")'
    updated, count = re.subn(pattern, lambda m: m[1] + html.escape(shot.alt, quote=True) + m[2], page)
    if count != 1:
        raise ManifestError(f"expected one hero image for {shot.name} on the page, found {count}")
    return updated


def stale_assets(filenames: tuple[str, ...], site_text: str) -> tuple[str, ...]:
    """Resized screenshots nothing on the site refers to any more. Logos and icons never match."""
    return tuple(
        name for name in filenames if SCREENSHOT_ASSET.fullmatch(name) and name not in site_text
    )


def step_to_js(step: dict[str, Any]) -> str:
    """One manifest step as a JS body run by driver.js; `goto` is handled by the caller."""
    if len(step) != 1 and "timeout" not in step:
        raise ManifestError(f"a step does one thing: {step}")
    kind = next(key for key in step if key != "timeout")
    timeout = step.get("timeout", 20000)
    value = step[kind]
    arg = json.dumps(value)
    match kind:
        case "click":
            target, options = _target_and_options(value, ("meta", "button"))
            return f"return await shot.click({json.dumps(target)}, {json.dumps({**options, 'timeout': timeout})});"
        case "wait":
            return f"await shot.wait({arg}, {timeout}); return true;"
        case "gone":
            return f"await shot.waitGone({arg}, {timeout}); return true;"
        case "type":
            target = {key: val for key, val in value.items() if key not in ("value", "enter")}
            options = {"enter": value.get("enter", False), "timeout": timeout}
            return f"return await shot.type({json.dumps(target)}, {json.dumps(value['value'])}, {json.dumps(options)});"
        case "key":
            return f"return shot.key({json.dumps(value['name'])}, {json.dumps({'meta': value.get('meta', False), 'shift': value.get('shift', False)})}, window);"
        case "sleep":
            return f"await shot.sleep({int(value)}); return true;"
        case "settle":
            return f"return await shot.settle({{timeout: {timeout}}});"
        case "js":
            return value
        case "api":
            body = json.dumps(value.get("body")) if "body" in value else "undefined"
            return f"return await shot.api({json.dumps(value['method'])}, {json.dumps(value['path'])}, {body});"
    raise ManifestError(f"unknown step: {kind}")


def _target_and_options(value: Any, option_keys: tuple[str, ...]) -> tuple[Any, dict[str, Any]]:
    if isinstance(value, str):
        return value, {}
    options = {key: value[key] for key in option_keys if key in value}
    target = {key: val for key, val in value.items() if key not in option_keys}
    return target, options

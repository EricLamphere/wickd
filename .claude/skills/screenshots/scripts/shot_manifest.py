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
SCREENSHOT_ASSET = re.compile(r".+_(1200|2400|2560)\.png")
ASSET_PATH = "../../assets/img"
GALLERY_PLACES = ("main", "more")
MAX_MAIN_GALLERY = 12


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
    if is_hero(shot):
        return ((2560, f"{shot.name}_2560.png"),)
    return ((1200, f"{shot.name}_1200.png"), (2400, f"{shot.name}_2400.png"))


def render_gallery(shots: tuple[Shot, ...]) -> str:
    """The site's gallery: main shots, then the rest behind "see more". Manifest order within each."""
    listed = [shot for shot in shots if not is_hero(shot)]
    main = [shot for shot in listed if shot.site.get("gallery") == "main"]
    more = [shot for shot in listed if shot.site.get("gallery") != "main"]
    grid = _gallery_grid(main, "    ")
    if not more:
        return grid
    noun = "screenshot" if len(more) == 1 else "screenshots"
    return (
        f"{grid}\n"
        f'    <details class="gallery-more">\n'
        f'      <summary class="btn btn-secondary">'
        f'<span class="when-closed">See {len(more)} more {noun}</span>'
        f'<span class="when-open">Show fewer</span></summary>\n'
        f"{_gallery_grid(more, '      ')}\n"
        f"    </details>"
    )


def _gallery_grid(shots: list[Shot], indent: str) -> str:
    items = "\n".join(_gallery_item(shot, indent + "  ") for shot in shots)
    return f'{indent}<div class="gallery-grid">\n{items}\n{indent}</div>'


def gallery_problems(shots: tuple[Shot, ...]) -> tuple[str, ...]:
    main = [shot for shot in shots if shot.site.get("gallery") == "main"]
    if len(main) > MAX_MAIN_GALLERY:
        return (f"{len(main)} shots in the main gallery; keep it to about 10 ({MAX_MAIN_GALLERY} at most)",)
    return ()


def _gallery_item(shot: Shot, indent: str) -> str:
    caption, label, alt = (html.escape(text, quote=True) for text in (shot.caption, shot.label, shot.alt))
    return (
        f'{indent}<div class="gallery-item" data-full="{ASSET_PATH}/{shot.name}_2400.png" data-cap="{caption}">\n'
        f'{indent}  <img src="{ASSET_PATH}/{shot.name}_1200.png" loading="lazy" alt="{alt}">\n'
        f'{indent}  <div class="gallery-cap">{label}</div>\n'
        f"{indent}</div>"
    )


def replace_gallery(page: str, gallery: str) -> str:
    before, start, rest = page.partition(GALLERY_START)
    _, end, after = rest.partition(GALLERY_END)
    if not start or not end:
        raise ManifestError(f"the page has no {GALLERY_START} … {GALLERY_END} block")
    return f"{before}{GALLERY_START}\n{gallery}\n    {GALLERY_END}{after}"


def set_hero_alt(page: str, shot: Shot) -> str:
    """A hero's image stays in its hand-written section; only its alt text follows the manifest."""
    pattern = rf'(src="{re.escape(ASSET_PATH)}/{re.escape(shot.name)}_2560\.png" alt=")[^"]*(")'
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

"""Run: backend/.venv/bin/pytest .claude/skills/screenshots/scripts/test_shot_manifest.py"""

import json
from pathlib import Path

import pytest
from shot_manifest import (
    ManifestError,
    coverage_problems,
    gallery_problems,
    load_shots,
    parse_shot,
    readme_features,
    render_gallery,
    replace_gallery,
    site_assets,
    stale_assets,
    step_to_js,
)

REPO = Path(__file__).resolve().parents[4]


def shot(name, features, tier="pro", theme="dark", pair=None, hero=False, gallery="main"):
    return parse_shot(
        {
            "name": name,
            "tier": tier,
            "theme": theme,
            "features": features,
            "caption": "Cap & co",
            "label": "Label & co",
            "alt": 'An "alt"',
            "pair": pair,
            "site": {"hero": "true"} if hero else {"gallery": gallery},
        }
    )


def test_readme_features_reads_only_the_features_section():
    readme = "- **Not this**\n## Features\n\n- **DAG** — x\n- **Wicky** (Pro) — y\n\n## Next\n- **Nor this**\n"
    assert readme_features(readme) == ("DAG", "Wicky")


def test_readme_without_features_section_is_an_error():
    with pytest.raises(ManifestError):
        readme_features("# nothing")


def test_uncovered_feature_is_reported():
    assert coverage_problems((shot("a", ["DAG"]),), ("DAG", "Wicky"), {}) == ("not in any shot: Wicky",)


def test_not_shown_feature_with_a_reason_is_fine():
    assert coverage_problems((shot("a", ["DAG"]),), ("DAG", "Sync"), {"Sync": "invisible"}) == ()


def test_stale_feature_names_are_reported():
    problems = coverage_problems((shot("a", ["Old"]),), (), {"Gone": "x"})
    assert "a: not a README feature: Old" in problems
    assert "not_shown names a feature that isn't in the README: Gone" in problems


def test_repeating_a_feature_is_rejected_unless_the_shots_are_a_pair():
    repeated = (shot("a", ["DAG"]), shot("b", ["DAG"], tier="base"))
    assert coverage_problems(repeated, ("DAG",), {}) == ("DAG: in both a and b, which aren't a pair",)
    paired = (shot("a", ["DAG"], pair="b"), shot("b", ["DAG"], tier="base", pair="a"))
    assert coverage_problems(paired, ("DAG",), {}) == ()


def test_a_pair_must_point_back_and_differ():
    one_way = (shot("a", ["DAG"], pair="b"), shot("b", ["X"], tier="base"))
    assert "a: pair 'b' doesn't pair back" in coverage_problems(one_way, ("DAG", "X"), {})
    same = (shot("a", ["DAG"], pair="b"), shot("b", ["X"], pair="a"))
    assert "a: a pair must differ in tier or theme" in coverage_problems(same, ("DAG", "X"), {})
    missing = (shot("a", ["DAG"], pair="z"),)
    assert "a: pair 'z' doesn't exist" in coverage_problems(missing, ("DAG",), {})


@pytest.mark.parametrize(
    "raw",
    [
        {"name": "Bad Name", "tier": "pro", "features": ["x"], "caption": "c", "label": "l", "alt": "a"},
        {"name": "a", "tier": "gold", "features": ["x"], "caption": "c", "label": "l", "alt": "a"},
        {"name": "a", "tier": "pro", "theme": "blue", "features": ["x"], "caption": "c", "label": "l", "alt": "a"},
        {"name": "a", "tier": "pro", "features": [], "caption": "c", "label": "l", "alt": "a"},
        {"name": "a", "tier": "pro", "features": ["x"], "label": "l", "alt": "a"},
        {"name": "a", "tier": "pro", "features": ["x"], "caption": "c", "alt": "a"},
        {"name": "a", "tier": "pro", "features": ["x"], "caption": "c", "label": "l"},
    ],
)
def test_invalid_shots_are_rejected(raw):
    with pytest.raises(ManifestError):
        parse_shot(raw)


def test_duplicate_names_are_rejected():
    raw = {"name": "a", "tier": "pro", "features": ["x"], "caption": "c", "label": "l", "alt": "a"}
    with pytest.raises(ManifestError):
        load_shots({"shots": [raw, raw]})


def test_steps_become_driver_calls():
    assert 'shot.click("Run"' in step_to_js({"click": "Run"})
    assert '"meta": true' in step_to_js({"click": {"text": "x", "meta": True}})
    assert 'shot.wait("Done", 5)' in step_to_js({"wait": "Done", "timeout": 5})
    assert 'shot.type({"sel": "input"}, "abc"' in step_to_js({"type": {"sel": "input", "value": "abc"}})
    assert 'shot.api("POST", "/api/x", {"a": 1})' in step_to_js(
        {"api": {"method": "POST", "path": "/api/x", "body": {"a": 1}}}
    )
    assert step_to_js({"js": "return 1"}) == "return 1"


def test_a_step_does_one_thing():
    with pytest.raises(ManifestError):
        step_to_js({"click": "a", "wait": "b"})
    with pytest.raises(ManifestError):
        step_to_js({"teleport": "a"})


def test_gallery_lists_non_hero_shots_in_order_and_escapes_text():
    html = render_gallery((shot("b", ["x"]), shot("hero", ["y"], hero=True), shot("a", ["z"])))
    assert "hero" not in html
    assert html.index("b_1200.png") < html.index("a_1200.png")
    assert 'data-full="../../assets/img/b_2400.png"' in html
    assert 'data-cap="Cap &amp; co"' in html
    assert 'alt="An &quot;alt&quot;"' in html
    assert '<div class="gallery-cap">Label &amp; co</div>' in html


def test_gallery_puts_the_rest_behind_see_more():
    html = render_gallery((shot("first", ["x"]), shot("later", ["y"], gallery="more"), shot("second", ["z"])))
    closed_until = html.index("<details")
    assert html.index("first_1200") < closed_until and html.index("second_1200") < closed_until
    assert html.index("later_1200") > closed_until
    assert "See 1 more screenshot<" in html


def test_gallery_without_extras_has_no_see_more():
    assert "<details" not in render_gallery((shot("a", ["x"]),))


def test_gallery_placement_is_validated():
    raw = {"name": "a", "tier": "pro", "features": ["x"], "caption": "c", "label": "l", "alt": "a",
           "site": {"gallery": "sidebar"}}
    with pytest.raises(ManifestError):
        parse_shot(raw)


def test_a_hero_cannot_also_be_in_the_gallery():
    raw = {"name": "a", "tier": "pro", "features": ["x"], "caption": "c", "label": "l", "alt": "a",
           "site": {"hero": "true", "gallery": "main"}}
    with pytest.raises(ManifestError):
        parse_shot(raw)


def test_too_many_main_gallery_images_is_a_problem():
    many = tuple(shot(f"s{i}", ["x"]) for i in range(13))
    assert gallery_problems(many) == ("13 shots in the main gallery; keep it to about 10 (12 at most)",)
    assert gallery_problems(many[:12]) == ()


def test_replace_gallery_swaps_only_what_is_between_the_markers():
    page = "before\n<!-- screenshots:gallery:start -->\nold\n<!-- screenshots:gallery:end -->\nafter"
    result = replace_gallery(page, "new")
    assert "old" not in result
    assert result.startswith("before\n<!-- screenshots:gallery:start -->\nnew\n")
    assert result.endswith("<!-- screenshots:gallery:end -->\nafter")


def test_replace_gallery_needs_its_markers():
    with pytest.raises(ManifestError):
        replace_gallery("no markers", "new")


def test_site_assets_per_shot_kind():
    assert site_assets(shot("a", ["x"])) == ((1200, "a_1200.png"), (2400, "a_2400.png"))
    assert site_assets(shot("a", ["x"], hero=True)) == ((2560, "a_2560.png"),)


def test_stale_assets_are_unreferenced_screenshot_sizes_only():
    files = ("old_1200.png", "old_2400.png", "used_1200.png", "logo.svg", "icon.png", "old_2560.png")
    assert stale_assets(files, 'src="used_1200.png"') == ("old_1200.png", "old_2400.png", "old_2560.png")


def test_the_real_manifest_covers_the_real_readme():
    manifest = json.loads((REPO / ".claude/skills/screenshots/shots.json").read_text())
    features = readme_features((REPO / "README.md").read_text()) + tuple(manifest["upcoming"])
    shots = load_shots(manifest)
    assert coverage_problems(shots, features, manifest["not_shown"]) == ()
    assert gallery_problems(shots) == ()

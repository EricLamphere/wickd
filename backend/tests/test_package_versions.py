from app.dbt.package_versions import (
    as_clauses,
    is_exact,
    is_newer,
    latest_compatible,
    newest,
    range_accepts,
    tag_version,
)


def test_as_clauses_accepts_strings_lists_and_missing():
    assert as_clauses(None) == ()
    assert as_clauses(">=1.3.0") == (">=1.3.0",)
    assert as_clauses(">=1.3.0, <2.0.0") == (">=1.3.0", "<2.0.0")
    assert as_clauses([">=1.3.0", "<2.0.0"]) == (">=1.3.0", "<2.0.0")
    assert as_clauses(1.1) == ("1.1",)


def test_range_accepts():
    assert range_accepts((">=1.3.0", "<2.0.0"), "1.10.13") is True
    assert range_accepts((">=1.3.0", "<1.8.0"), "1.10.13") is False
    assert range_accepts(("1.5.0",), "1.5.0") is True  # bare = exact
    assert range_accepts(("=1.5.0",), "1.5.1") is False
    assert range_accepts(("> = nope",), "1.5.0") is None
    assert range_accepts((), "1.5.0") is True
    assert range_accepts((">=1.0.0",), None) is None
    assert range_accepts((">= 1.3.0",), "1.11.0b2") is True


def test_is_exact():
    assert is_exact(("1.1.1",)) and is_exact(("==1.1.1",))
    assert not is_exact((">=1.0.0",)) and not is_exact((">=1.0.0", "<2.0.0"))


def test_tag_version():
    assert tag_version("v1.2.0") == ("v", "1.2.0")
    assert tag_version("0.9.1") == ("", "0.9.1")
    assert tag_version("main") is None
    assert tag_version("a1b2c3d4e5f6") is None


def test_newest_and_latest_compatible():
    assert newest(["1.0.0", "1.2.0", "1.3.0b1", "bad"]) == "1.2.0"
    requires = {"1.0.0": (">=1.3.0",), "1.1.0": (">=1.3.0", "<1.9.0"), "2.0.0": (">=1.9.0",)}
    assert latest_compatible(requires, "1.8.0") == "1.1.0"
    assert latest_compatible(requires, "1.10.0") == "2.0.0"
    assert latest_compatible(requires, None) is None


def test_is_newer():
    assert is_newer("1.10.0", "1.9.0")
    assert not is_newer("1.0.0", "1.0.0")
    assert not is_newer(None, "1.0.0")

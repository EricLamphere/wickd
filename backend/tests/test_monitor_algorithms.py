"""Metric monitor algorithm settings (app/semantic/monitor_algorithms.py)."""

import pytest

from app.semantic.monitor_algorithms import ConfigError, check_config, label


def test_seasonal_takes_no_settings() -> None:
    assert check_config("seasonal", {"anything": 1}) == {}
    assert label("seasonal") == "Seasonal anomaly"


def test_no_data_defaults_and_validation() -> None:
    assert check_config("no_data", None) == {"check_nulls": True, "check_zeros": True, "periods": 1}
    assert check_config("no_data", {"check_zeros": False, "periods": 3}) == {
        "check_nulls": True, "check_zeros": False, "periods": 3,
    }
    with pytest.raises(ConfigError, match="both"):
        check_config("no_data", {"check_nulls": False, "check_zeros": False})
    with pytest.raises(ConfigError, match="periods"):
        check_config("no_data", {"periods": 0})
    with pytest.raises(ConfigError, match="true or false"):
        check_config("no_data", {"check_nulls": "yes"})


def test_threshold_needs_a_bound_in_order() -> None:
    assert check_config("threshold", {"max": 10}) == {"min": None, "max": 10.0, "periods": 1}
    with pytest.raises(ConfigError, match="minimum, a maximum"):
        check_config("threshold", {})
    with pytest.raises(ConfigError, match="not be above"):
        check_config("threshold", {"min": 5, "max": 1})
    with pytest.raises(ConfigError, match="number"):
        check_config("threshold", {"min": "5"})


def test_change_defaults_and_validation() -> None:
    assert check_config("change", {}) == {"max_change_pct": 50.0, "direction": "both", "periods": 1}
    with pytest.raises(ConfigError, match="direction"):
        check_config("change", {"direction": "sideways"})
    with pytest.raises(ConfigError, match="above 0"):
        check_config("change", {"max_change_pct": 0})


def test_unknown_algorithm_or_bad_shape() -> None:
    with pytest.raises(ConfigError, match="algorithm must be one of"):
        check_config("magic", {})
    with pytest.raises(ConfigError, match="object"):
        check_config("threshold", [1, 2])  # type: ignore[arg-type]


def test_shim_refuses_a_rule_an_older_pro_build_lacks(monkeypatch: pytest.MonkeyPatch) -> None:
    from datetime import date
    from types import SimpleNamespace

    from app.semantic import anomaly

    calls: list[dict] = []
    old = SimpleNamespace(detect=lambda series, **kw: calls.append(kw) or {"points": [], "summary": {}})
    monkeypatch.setattr(anomaly, "_pro", lambda: old)
    anomaly.detect([], grain="day", sensitivity="normal", previous=None, now=date(2026, 1, 1))
    assert "algorithm" not in calls[0]  # an older build's detect() has no such argument
    with pytest.raises(anomaly.AnomalyUnavailable, match="update wickd Pro"):
        anomaly.detect([], grain="day", sensitivity="normal", previous=None, now=date(2026, 1, 1), algorithm="change")
    new = SimpleNamespace(ALGORITHMS=("seasonal", "change"), detect=old.detect)
    monkeypatch.setattr(anomaly, "_pro", lambda: new)
    anomaly.detect([], grain="day", sensitivity="normal", previous=None, now=date(2026, 1, 1), algorithm="change", config={})
    assert calls[-1]["algorithm"] == "change"

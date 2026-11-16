"""Metric monitor algorithms: their names and the settings each takes, validated here (the
public boundary) before they're stored or handed to the private detection
(app/semantic/anomaly.py → wickd_pro.anomaly). Pure; tested in test_monitor_algorithms.py.

    seasonal       Seasonal anomaly: spikes, drops and level shifts against the metric's own
                   seasonal baseline; tuned by the monitor's sensitivity. No settings.
    no_data        No data or zero: flags a period with no data (check_nulls) or a 0
                   (check_zeros), e.g. "did yesterday's data land?".
    threshold      Fixed bounds: flags a value below `min` or above `max`.
    change         Period-over-period change: flags a move of more than `max_change_pct` %
                   from the period before, in `direction` (both / up / down).

The rules alarm when one of the last `periods` complete periods (default 1) is flagged.
"""

from typing import Any

DEFAULT_ALGORITHM = "seasonal"
ALGORITHMS: dict[str, str] = {
    "seasonal": "Seasonal anomaly",
    "no_data": "No data or zero",
    "threshold": "Fixed bounds",
    "change": "Period-over-period change",
}
MAX_PERIODS = 30
MAX_CHANGE_PCT = 10_000.0
DIRECTIONS = ("both", "up", "down")


class ConfigError(ValueError):
    """An algorithm's settings aren't valid; the message is shown to the user."""


def _number(config: dict[str, Any], key: str) -> float | None:
    value = config.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ConfigError(f"{key} must be a number")
    return float(value)


def _flag(config: dict[str, Any], key: str) -> bool:
    value = config.get(key, True)
    if not isinstance(value, bool):
        raise ConfigError(f"{key} must be true or false")
    return value


def _periods(config: dict[str, Any]) -> int:
    value = config.get("periods", 1)
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_PERIODS:
        raise ConfigError(f"periods must be a whole number from 1 to {MAX_PERIODS}")
    return value


def _no_data(config: dict[str, Any]) -> dict[str, Any]:
    nulls, zeros = _flag(config, "check_nulls"), _flag(config, "check_zeros")
    if not nulls and not zeros:
        raise ConfigError("Check for missing data, zeros, or both")
    return {"check_nulls": nulls, "check_zeros": zeros, "periods": _periods(config)}


def _threshold(config: dict[str, Any]) -> dict[str, Any]:
    low, high = _number(config, "min"), _number(config, "max")
    if low is None and high is None:
        raise ConfigError("Set a minimum, a maximum, or both")
    if low is not None and high is not None and low > high:
        raise ConfigError("The minimum must not be above the maximum")
    return {"min": low, "max": high, "periods": _periods(config)}


def _change(config: dict[str, Any]) -> dict[str, Any]:
    pct = _number(config, "max_change_pct")
    if pct is None:
        pct = 50.0
    if not 0 < pct <= MAX_CHANGE_PCT:
        raise ConfigError(f"max_change_pct must be above 0 and at most {MAX_CHANGE_PCT:,.0f}")
    direction = config.get("direction", "both")
    if direction not in DIRECTIONS:
        raise ConfigError(f"direction must be one of {', '.join(DIRECTIONS)}")
    return {"max_change_pct": pct, "direction": direction, "periods": _periods(config)}


_CHECKS = {"seasonal": lambda _config: {}, "no_data": _no_data, "threshold": _threshold, "change": _change}


def check_config(algorithm: str, config: dict[str, Any] | None) -> dict[str, Any]:
    """The algorithm's settings, normalized (defaults filled, unknown keys dropped)."""
    if algorithm not in _CHECKS:
        raise ConfigError(f"algorithm must be one of {', '.join(ALGORITHMS)}")
    if config is not None and not isinstance(config, dict):
        raise ConfigError("algorithm settings must be an object")
    return _CHECKS[algorithm](config or {})


def label(algorithm: str) -> str:
    return ALGORITHMS.get(algorithm, algorithm)

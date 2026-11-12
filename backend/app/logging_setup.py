import contextvars
import logging
import sys
from pathlib import Path

import structlog

_FORWARDED_LEVELS = {"warning", "error", "critical", "exception"}
_forwarding: contextvars.ContextVar[bool] = contextvars.ContextVar("api_log_forwarding", default=False)


def forward_to_api_log(_logger: object, method_name: str, event_dict: dict) -> dict:
    """structlog processor: copy warnings and errors (and info events logged with `api_log=True`)
    into API Logs, so problems show in the app's bottom pane and not only in the console."""
    asked = bool(event_dict.pop("api_log", False))
    level = str(event_dict.get("level") or method_name).lower()
    if (level in _FORWARDED_LEVELS or asked) and not _forwarding.get():
        from app.logs import api_logger  # imports this module

        token = _forwarding.set(True)  # a failed write logs a warning: don't forward that one
        try:
            line, project_id = api_logger.format_log_event(level, event_dict)
            api_logger.append_api_log(line, project_id=project_id)
        except Exception as exc:  # noqa: BLE001 — logging must never raise; no logger here (it would recurse)
            sys.stderr.write(f"api log forwarding failed: {exc}\n")
        finally:
            _forwarding.reset(token)
    return event_dict


def configure_logging(level: str = "INFO", api_log_path: Path | None = None) -> None:
    """Configure structlog with console output + optional file sink for API logs."""
    shared_processors = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        forward_to_api_log,
    ]

    if api_log_path is not None:
        api_log_path.parent.mkdir(parents=True, exist_ok=True)
        _file_handler = logging.FileHandler(str(api_log_path), encoding="utf-8")
        _file_handler.setFormatter(logging.Formatter("%(message)s"))

        _file_logger = logging.getLogger("wickd.api")
        _file_logger.setLevel(level.upper())
        _file_logger.addHandler(_file_handler)
        _file_logger.propagate = False

    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=level.upper(),
    )
    structlog.configure(
        processors=[
            *shared_processors,
            structlog.dev.ConsoleRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, level.upper(), logging.INFO)
        ),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str | None = None) -> structlog.BoundLogger:
    return structlog.get_logger(name)

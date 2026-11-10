"""FastAPI app entrypoint for the Codebase Chatbot."""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any




class JsonFormatter(logging.Formatter):
    """Small JSON formatter for local structured logs."""

    def format(self, record: logging.LogRecord) -> str:
        # Keep the base log shape stable so local logs are easy to search and
        # later metric collectors can parse them without knowing Python logging.
        payload: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        # Agent and API code attach these fields through `extra={...}`. Missing
        # values are skipped so ordinary library logs still serialize cleanly.
        for key in (
            "user_id",
            "session_id",
            "path",
            "triage_class",
            "phase",
            "backend",
            "detail",
            "outcome",
            "service",
            "tool",
            "tool_id",
            "exception_type",
            "exception_detail",
            "error",
            "status",
            "elapsed_ms",
            "iteration_count",
            "artifact_count",
            "error_count",
            "step_count",
            "output_chars",
            "complete",
            "confidence",
        ):
            if hasattr(record, key):
                payload[key] = getattr(record, key)
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        if record.stack_info:
            payload["stack"] = self.formatStack(record.stack_info)
        return json.dumps(payload)


def configure_logging() -> None:
    if os.environ.get("BACKEND_QUIET", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }:
        logging.disable(logging.CRITICAL)
        logging.getLogger().handlers.clear()
        return

    # Configure logging once at app import time. Uvicorn will still emit its own
    # server logs, while application logs use the JSON formatter above.
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO)


configure_logging()



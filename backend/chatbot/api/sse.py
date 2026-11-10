"""Small Server-Sent Events helpers for chat streaming."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

from chatbot.agent.state import AgentResult


def format_sse(event: str, data: dict[str, Any]) -> str:
    """Serialize one Server-Sent Event frame."""

    payload = json.dumps(data, ensure_ascii=True)
    return f"event: {event}\ndata: {payload}\n\n"


def iter_answer_events(
    result: AgentResult, *, chunk_size: int, include_start: bool = True
) -> Iterator[str]:
    # Kept for non-streaming compatibility tests and simple adapters. The main
    # `/chat/stream` route consumes AgentService.stream_chat directly.
    size = max(1, chunk_size)
    if include_start:
        yield format_sse(
            "start",
            {
                "path": result.path,
                "triage_class": result.triage_class,
            },
        )
    for index in range(0, len(result.answer), size):
        yield format_sse("chunk", {"text": result.answer[index : index + size]})
    yield format_sse(
        "done",
        {
            "path": result.path,
            "triage_class": result.triage_class,
        },
    )


def error_event(message: str) -> str:
    return format_sse("error", {"error": message})

"""HTTP routes that adapt requests to the agent service."""

from __future__ import annotations

import logging
import re
import time
from threading import RLock
from collections.abc import Iterator
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from chatbot.agent.service import AgentService
from chatbot.agent.tools.codegraph import CodeGraphTool
from chatbot.config.settings import load_settings
from chatbot.history.factory import build_history_client
from chatbot.history.redaction import RedactingChatHistoryClient

from .guards import oversized_request_detail, validate_request_size
from .schemas import (
    ChatRequest,
    ChatResponse,
    DeleteSessionResponse,
    HealthResponse,
)
from .sse import error_event, format_sse


logger = logging.getLogger(__name__)
router = APIRouter()

_runtime_lock = RLock()
_settings = load_settings()
# Route-level dependencies are composed once so every endpoint shares the same
# history backend, redaction wrapper, agent service, and CodeGraph health probe.
_history_client = RedactingChatHistoryClient(build_history_client(_settings))
_agent_service = AgentService(history_client=_history_client, settings=_settings)
_codegraph_tool = CodeGraphTool(settings=_settings)


def reload_runtime_settings() -> dict[str, Any]:
    """Rebuild route-level services after process environment changes."""

    global _settings, _history_client, _agent_service, _codegraph_tool
    with _runtime_lock:
        _settings = load_settings()
        _history_client = RedactingChatHistoryClient(build_history_client(_settings))
        _agent_service = AgentService(history_client=_history_client, settings=_settings)
        _codegraph_tool = CodeGraphTool(settings=_settings)
        return runtime_settings_snapshot()


def runtime_settings_snapshot() -> dict[str, Any]:
    """Return a redacted summary of the active chatbot runtime settings."""

    return {
        "history_backend": _settings.history_backend,
        "llm_provider": _settings.llm_provider,
        "llm_model": _settings.llm_model,
        "judge_model": _settings.judge_model,
        "codegraph_enabled": _settings.codegraph_enabled,
        "codegraph_database": _settings.codegraph_database,
        "codegraph_base_url": _settings.codegraph_base_url,
        "streaming_enabled": _settings.chat_streaming_enabled,
        "chat_max_request_chars": _settings.chat_max_request_chars,
    }


@router.get("/healthz", response_model=HealthResponse)
def healthz() -> HealthResponse:
    history_health = _history_client.health()
    codegraph_health = _codegraph_tool.health()
    return HealthResponse(
        history_backend=history_health.backend,
        history_status=history_health.status,
        history_degraded=history_health.degraded,
        codegraph_status=codegraph_health.status,
        codegraph_available=codegraph_health.available,
        codegraph_base_url=codegraph_health.metadata.get("codegraph_base_url"),
        codegraph_error=codegraph_health.error,
        streaming_enabled=_settings.chat_streaming_enabled,
        chat_max_request_chars=_settings.chat_max_request_chars,
    )


@router.post("/chat", response_model=ChatResponse)
def chat(request: ChatRequest) -> ChatResponse:
    # The API layer intentionally does not run triage or graph nodes directly.
    # It adapts the HTTP request into the agent service and maps the result back
    # into the public response schema.
    _enforce_chat_guards(request)
    result = _agent_service.handle_chat(
        user_id=request.user_id,
        session_id=request.session_id,
        text=request.text,
    )
    logger.info(
        "chat_turn_complete",
        extra={
            "user_id": request.user_id,
            "session_id": request.session_id,
            "path": result.path,
            "triage_class": result.triage_class,
        },
    )
    return ChatResponse(
        user_id=request.user_id,
        session_id=request.session_id,
        answer=result.answer,
        path=result.path,
        triage_class=result.triage_class,
    )


@router.post("/chat/stream")
def chat_stream(request: ChatRequest) -> StreamingResponse:
    if not _settings.chat_streaming_enabled:
        raise HTTPException(status_code=404, detail="Chat streaming is disabled.")
    _enforce_chat_guards(request)

    def events() -> Iterator[str]:
        started = time.perf_counter()
        logger.info(
            "chat_stream_start",
            extra={
                "user_id": request.user_id,
                "session_id": request.session_id,
                "phase": "stream",
                "outcome": "started",
            },
        )
        try:
            final_path = None
            final_triage_class = None
            for event in _agent_service.stream_chat(
                user_id=request.user_id,
                session_id=request.session_id,
                text=request.text,
            ):
                if event.event == "done":
                    final_path = event.data.get("path")
                    final_triage_class = event.data.get("triage_class")
                yield format_sse(event.event, event.data)
            logger.info(
                "chat_stream_complete",
                extra={
                    "user_id": request.user_id,
                    "session_id": request.session_id,
                    "path": final_path,
                    "triage_class": final_triage_class,
                    "phase": "stream",
                    "outcome": "ok",
                    "elapsed_ms": int((time.perf_counter() - started) * 1000),
                },
            )
        except Exception as exc:
            logger.exception(
                "chat_stream_failed",
                extra={
                    "user_id": request.user_id,
                    "session_id": request.session_id,
                    "phase": "stream",
                    "detail": exc.__class__.__name__,
                    "outcome": "failed",
                    "elapsed_ms": int((time.perf_counter() - started) * 1000),
                },
            )
            yield error_event(_chat_stream_error_message(exc))

    return StreamingResponse(events(), media_type="text/event-stream")


@router.delete("/history/{user_id}/{session_id}", response_model=DeleteSessionResponse)
def delete_session(user_id: str, session_id: str) -> DeleteSessionResponse:
    _history_client.delete_session(user_id, session_id)
    logger.info(
        "history_session_deleted",
        extra={
            "user_id": user_id,
            "session_id": session_id,
            "phase": "privacy",
            "outcome": "ok",
        },
    )
    return DeleteSessionResponse(user_id=user_id, session_id=session_id)


def _enforce_chat_guards(request: ChatRequest) -> None:
    """Apply D2 request hardening before any agent or history work starts."""

    decision = validate_request_size(
        request.text,
        _settings.chat_max_request_chars,
    )
    if decision.allowed:
        return
    logger.info(
        "chat_guardrail_blocked",
        extra={
            "user_id": request.user_id,
            "session_id": request.session_id,
            "phase": "guardrail",
            "detail": decision.reason,
            "outcome": "blocked",
        },
    )
    raise HTTPException(
        status_code=400,
        detail=oversized_request_detail(decision),
    )


def _chat_stream_error_message(exc: Exception) -> str:
    raw = f"{exc.__class__.__name__}: {exc}"
    compact = re.sub(r"\s+", " ", raw).strip()
    compact = re.sub(
        r"(?i)\b(api[_-]?key|password|token)\b\s*[:=]\s*\S+",
        r"\1=<redacted>",
        compact,
    )
    compact = re.sub(r"https?://\S+", "", compact).strip()
    if not compact:
        return "Chat streaming failed before completion."
    return f"Chat streaming failed before completion: {compact[:220]}"

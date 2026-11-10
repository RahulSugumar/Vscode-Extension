"""HTTP request and response models for the chatbot API."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    """Incoming chat turn from the UI or another client."""

    user_id: str = Field(default="local-user", min_length=1)
    session_id: str = Field(default="local-session", min_length=1)
    text: str = Field(min_length=1)


class ChatResponse(BaseModel):
    """Chat answer returned by the agent service."""

    user_id: str
    session_id: str
    answer: str
    path: Literal["fast", "full"]
    triage_class: Literal[
        "smalltalk", "meta", "clarification", "cache_hit", "task"
    ]


class DeleteSessionResponse(BaseModel):
    """Confirmation returned after deleting one scoped chat session."""

    user_id: str
    session_id: str
    deleted: bool = True


class HealthResponse(BaseModel):
    """Health check payload."""

    status: Literal["ok"] = "ok"
    service: str = "codebase-chatbot-api"
    history_backend: str | None = None
    history_status: str | None = None
    history_degraded: bool | None = None
    codegraph_status: str | None = None
    codegraph_available: bool | None = None
    codegraph_base_url: str | None = None
    codegraph_error: str | None = None
    streaming_enabled: bool | None = None
    chat_max_request_chars: int | None = None

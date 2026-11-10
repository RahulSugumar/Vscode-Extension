"""Protocol boundary for chatbot history backends.

The agent layer talks only to this contract. Concrete storage choices such as
in-memory dev state, SQLite, Redis, Postgres, or S3-shaped blob storage stay
behind implementations in `history/`.
"""

from __future__ import annotations

from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field

from chatbot.agent.state import LayeredWindow


HistoryStatus = Literal["ok", "degraded", "unavailable"]


class HistoryHealth(BaseModel):
    """Small health payload returned by every history implementation."""

    status: HistoryStatus = "ok"
    backend: str
    degraded: bool = False
    detail: str | None = None
    counters: dict[str, int] = Field(default_factory=dict)


class ChatHistoryClient(Protocol):
    """Stable contract used by agent code, independent of storage details.

    Method responsibilities:
    - `find_cache_hit` is the triage-time hot lookup and should be cheap.
    - `get_window` is the ingest-time context read and may rehydrate from cold.
    - `append_turn` is called for both user and assistant messages.
    - summary/fact methods are Phase B hooks for the Phase C summarizer worker.
    """

    def get_window(self, user_id: str, session_id: str) -> LayeredWindow:
        """Return the bounded planner window for one user/session."""
        ...

    def append_turn(
        self,
        user_id: str,
        session_id: str,
        role: str,
        content: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Persist one user or assistant turn with optional operational metadata."""
        ...

    def find_cache_hit(
        self, user_id: str, session_id: str, normalized_user_text: str
    ) -> str | None:
        """Return a recent matching assistant answer, or None on miss/unavailable."""
        ...

    def update_summary(
        self,
        user_id: str,
        session_id: str,
        summary: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Replace the rolling summary for a session."""
        ...

    def pin_fact(
        self,
        user_id: str,
        session_id: str,
        fact: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Persist one stable fact that should appear in future layered windows."""
        ...

    def delete_session(self, user_id: str, session_id: str) -> None:
        """Delete all history layers for a session."""
        ...

    def health(self) -> HistoryHealth:
        """Report backend health for `/healthz` and operational logs."""
        ...

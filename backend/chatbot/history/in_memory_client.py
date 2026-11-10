"""In-memory history client for local development and tests."""

from __future__ import annotations

from collections import defaultdict, deque
from datetime import UTC, datetime
from threading import Lock
from typing import Any

from chatbot.agent.state import LayeredWindow, Turn
from chatbot.history.protocol import HistoryHealth
from chatbot.history.utils import normalize_for_match


class InMemoryChatHistoryClient:
    """Small process-local history store implementing the Phase B protocol."""

    def __init__(self, max_turns: int = 20) -> None:
        # Keyed by (user_id, session_id) to match the future durable history API.
        # The deque cap prevents an unbounded in-process transcript during dev.
        self._max_turns = max_turns
        self._turns: dict[tuple[str, str], deque[Turn]] = defaultdict(
            lambda: deque(maxlen=max_turns)
        )
        self._summaries: dict[tuple[str, str], str] = {}
        self._pinned_facts: dict[tuple[str, str], list[str]] = defaultdict(list)
        self._lock = Lock()

    def get_window(self, user_id: str, session_id: str) -> LayeredWindow:
        key = (user_id, session_id)
        with self._lock:
            return LayeredWindow(
                verbatim=list(self._turns[key]),
                summary=self._summaries.get(key),
                pinned_facts=list(self._pinned_facts[key]),
            )

    def append_turn(
        self,
        user_id: str,
        session_id: str,
        role: str,
        content: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        key = (user_id, session_id)
        with self._lock:
            self._turns[key].append(
                Turn(
                    role=role,
                    content=content,
                    metadata=metadata or {},
                    created_at=_now(),
                )
            )

    def find_cache_hit(
        self, user_id: str, session_id: str, normalized_user_text: str
    ) -> str | None:
        key = (user_id, session_id)
        with self._lock:
            turns = list(self._turns[key])

        # Walk backward over user/assistant pairs. A match returns the assistant
        # answer immediately after the matching user prompt.
        for index in range(len(turns) - 2, -1, -1):
            current = turns[index]
            following = turns[index + 1] if index + 1 < len(turns) else None
            if current.role != "user" or following is None:
                continue
            if following.role != "assistant":
                continue
            if normalize_for_match(current.content) == normalized_user_text:
                return following.content
        return None

    def update_summary(
        self,
        user_id: str,
        session_id: str,
        summary: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        key = (user_id, session_id)
        with self._lock:
            self._summaries[key] = summary

    def pin_fact(
        self,
        user_id: str,
        session_id: str,
        fact: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        key = (user_id, session_id)
        with self._lock:
            self._pinned_facts[key].append(fact)

    def delete_session(self, user_id: str, session_id: str) -> None:
        key = (user_id, session_id)
        with self._lock:
            self._turns.pop(key, None)
            self._summaries.pop(key, None)
            self._pinned_facts.pop(key, None)

    def health(self) -> HistoryHealth:
        with self._lock:
            session_count = len(set(self._turns) | set(self._summaries))
            turn_count = sum(len(turns) for turns in self._turns.values())
        return HistoryHealth(
            status="ok",
            backend="memory",
            counters={
                "sessions": session_count,
                "turns": turn_count,
            },
        )

    def refresh_window(
        self, user_id: str, session_id: str, window: LayeredWindow
    ) -> None:
        key = (user_id, session_id)
        with self._lock:
            self._turns[key] = deque(window.verbatim, maxlen=self._max_turns)
            if window.summary is not None:
                self._summaries[key] = window.summary
            self._pinned_facts[key] = list(window.pinned_facts)


def _now() -> str:
    return datetime.now(UTC).isoformat()

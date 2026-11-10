"""Composed Phase B history client for hot/cold tier behavior."""

from __future__ import annotations

import logging
from collections import Counter
from typing import Any

from chatbot.agent.state import LayeredWindow
from chatbot.history.protocol import ChatHistoryClient, HistoryHealth


logger = logging.getLogger(__name__)


class TieredChatHistoryClient:
    """Write-through history client with best-effort hot-tier behavior.

    Cold storage is treated as the source of truth. Hot storage is an
    acceleration layer for recent cache hits and layered windows; hot failures
    are logged and degraded rather than allowed to crash normal chat turns.
    """

    def __init__(
        self,
        cold_client: ChatHistoryClient,
        hot_client: ChatHistoryClient | None = None,
        degraded_policy: str = "cold",
    ) -> None:
        self._cold = cold_client
        self._hot = hot_client
        self._degraded_policy = degraded_policy
        self._counters: Counter[str] = Counter()

    def get_window(self, user_id: str, session_id: str) -> LayeredWindow:
        # Ingest uses this path. Try hot first; if there is no usable window,
        # read from cold storage and refresh hot storage best-effort.
        if self._hot is not None:
            try:
                window = self._hot.get_window(user_id, session_id)
                if window.verbatim or window.summary or window.pinned_facts:
                    self._counters["hot_window_hit"] += 1
                    return window
                self._counters["hot_window_miss"] += 1
            except Exception as exc:  # pragma: no cover - exercised by fake tests
                self._counters["hot_window_error"] += 1
                logger.warning(
                    "history_hot_window_unavailable",
                    extra={
                        "user_id": user_id,
                        "session_id": session_id,
                        "detail": str(exc),
                    },
                )

        try:
            window = self._cold.get_window(user_id, session_id)
        except Exception:
            self._counters["cold_window_error"] += 1
            raise

        self._counters["rehydrate"] += 1
        logger.info(
            "history_rehydrate",
            extra={
                "user_id": user_id,
                "session_id": session_id,
                "window_turn_count": len(window.verbatim),
            },
        )
        self._refresh_hot(user_id, session_id, window)
        return window

    def append_turn(
        self,
        user_id: str,
        session_id: str,
        role: str,
        content: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        # Write-through policy: cold append must succeed first. Hot append is
        # useful for cache/window freshness, but is not the source of truth.
        self._cold.append_turn(user_id, session_id, role, content, metadata)
        self._counters["cold_append"] += 1
        if self._hot is not None:
            try:
                self._hot.append_turn(user_id, session_id, role, content, metadata)
                self._counters["hot_append"] += 1
            except Exception as exc:  # pragma: no cover - exercised by fake tests
                self._counters["hot_append_error"] += 1
                logger.warning(
                    "history_hot_append_unavailable",
                    extra={
                        "user_id": user_id,
                        "session_id": session_id,
                        "detail": str(exc),
                    },
                )

    def find_cache_hit(
        self, user_id: str, session_id: str, normalized_user_text: str
    ) -> str | None:
        # Triage calls this before deciding fast vs full path. It intentionally
        # never reads cold storage, because a cache miss should be cheap.
        if self._hot is None:
            self._counters["cache_skipped_no_hot"] += 1
            return None
        try:
            answer = self._hot.find_cache_hit(
                user_id, session_id, normalized_user_text
            )
        except Exception as exc:  # pragma: no cover - exercised by fake tests
            self._counters["cache_hot_error"] += 1
            logger.warning(
                "history_cache_hot_unavailable",
                extra={
                    "user_id": user_id,
                    "session_id": session_id,
                    "detail": str(exc),
                },
            )
            return None
        if answer is None:
            self._counters["cache_miss"] += 1
        else:
            self._counters["cache_hit"] += 1
        return answer

    def update_summary(
        self,
        user_id: str,
        session_id: str,
        summary: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self._cold.update_summary(user_id, session_id, summary, metadata)
        if self._hot is not None:
            try:
                self._hot.update_summary(user_id, session_id, summary, metadata)
            except Exception:
                self._counters["hot_summary_error"] += 1

    def pin_fact(
        self,
        user_id: str,
        session_id: str,
        fact: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self._cold.pin_fact(user_id, session_id, fact, metadata)
        if self._hot is not None:
            try:
                self._hot.pin_fact(user_id, session_id, fact, metadata)
            except Exception:
                self._counters["hot_pin_error"] += 1

    def delete_session(self, user_id: str, session_id: str) -> None:
        self._cold.delete_session(user_id, session_id)
        if self._hot is not None:
            try:
                self._hot.delete_session(user_id, session_id)
            except Exception:
                self._counters["hot_delete_error"] += 1

    def health(self) -> HistoryHealth:
        cold_health = self._cold.health()
        hot_health = self._hot.health() if self._hot is not None else None
        degraded = cold_health.degraded or (
            hot_health.degraded if hot_health is not None else False
        )
        status = "degraded" if degraded else cold_health.status
        detail = cold_health.detail
        if hot_health is not None and hot_health.detail:
            detail = f"{detail}; {hot_health.detail}" if detail else hot_health.detail
        counters = dict(self._counters)
        counters.update({f"cold_{k}": v for k, v in cold_health.counters.items()})
        if hot_health is not None:
            counters.update({f"hot_{k}": v for k, v in hot_health.counters.items()})
        return HistoryHealth(
            status=status,
            backend="tiered",
            degraded=degraded,
            detail=detail,
            counters=counters,
        )

    def _refresh_hot(
        self, user_id: str, session_id: str, window: LayeredWindow
    ) -> None:
        if self._hot is None:
            return
        try:
            refresh = getattr(self._hot, "refresh_window", None)
            if callable(refresh):
                refresh(user_id, session_id, window)
                self._counters["hot_refresh"] += 1
        except Exception as exc:  # pragma: no cover - exercised by fake tests
            self._counters["hot_refresh_error"] += 1
            logger.warning(
                "history_hot_refresh_unavailable",
                extra={
                    "user_id": user_id,
                    "session_id": session_id,
                    "detail": str(exc),
                },
            )

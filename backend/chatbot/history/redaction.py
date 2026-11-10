"""Storage-independent redaction helpers for history writes."""

from __future__ import annotations

import re
from typing import Any

from chatbot.agent.state import LayeredWindow
from chatbot.history.protocol import ChatHistoryClient, HistoryHealth


_REDACTION_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(
            r"(?i)\b(api[_-]?key|secret|token|password)\s*[:=]\s*['\"]?([^\s'\",;]+)"
        ),
        r"\1=[REDACTED]",
    ),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"), "[REDACTED_OPENAI_KEY]"),
    (re.compile(r"\bghp_[A-Za-z0-9_]{20,}\b"), "[REDACTED_GITHUB_TOKEN]"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"), "[REDACTED_GITHUB_TOKEN]"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[REDACTED_AWS_ACCESS_KEY]"),
    (
        re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"),
        "[REDACTED_JWT]",
    ),
    (
        re.compile(r"(?i)\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s]+"),
        "[REDACTED_CONNECTION_STRING]",
    ),
    (
        re.compile(r"\b[A-Za-z0-9+/]{32,}={0,2}\b"),
        "[REDACTED_SECRET]",
    ),
)


def redact_text(value: str) -> str:
    """Mask common secret-looking values before they are stored."""

    redacted = value
    for pattern, replacement in _REDACTION_RULES:
        redacted = pattern.sub(replacement, redacted)
    return redacted


class RedactingChatHistoryClient:
    """Decorator that redacts obvious secrets before persisting history."""

    def __init__(self, wrapped: ChatHistoryClient) -> None:
        self._wrapped = wrapped

    def get_window(self, user_id: str, session_id: str) -> LayeredWindow:
        return self._wrapped.get_window(user_id, session_id)

    def append_turn(
        self,
        user_id: str,
        session_id: str,
        role: str,
        content: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        # Redaction happens at the history boundary. The current user turn can
        # still be used by the agent, but raw obvious secrets are not persisted.
        self._wrapped.append_turn(
            user_id,
            session_id,
            role,
            redact_text(content),
            _with_redaction_metadata(content, metadata),
        )

    def find_cache_hit(
        self, user_id: str, session_id: str, normalized_user_text: str
    ) -> str | None:
        return self._wrapped.find_cache_hit(user_id, session_id, normalized_user_text)

    def update_summary(
        self,
        user_id: str,
        session_id: str,
        summary: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self._wrapped.update_summary(
            user_id,
            session_id,
            redact_text(summary),
            _with_redaction_metadata(summary, metadata),
        )

    def pin_fact(
        self,
        user_id: str,
        session_id: str,
        fact: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self._wrapped.pin_fact(
            user_id,
            session_id,
            redact_text(fact),
            _with_redaction_metadata(fact, metadata),
        )

    def delete_session(self, user_id: str, session_id: str) -> None:
        self._wrapped.delete_session(user_id, session_id)

    def health(self) -> HistoryHealth:
        return self._wrapped.health()


def _with_redaction_metadata(
    original: str, metadata: dict[str, Any] | None
) -> dict[str, Any]:
    updated = dict(metadata or {})
    updated["redacted"] = redact_text(original) != original
    return updated

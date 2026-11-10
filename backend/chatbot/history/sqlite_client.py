"""SQLite-backed durable history client for local Phase B development."""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock
from typing import Any

from chatbot.agent.state import LayeredWindow, Turn
from chatbot.history.protocol import HistoryHealth
from chatbot.history.utils import normalize_for_match


class SQLiteChatHistoryClient:
    """Durable local cold-tier client using the Python stdlib sqlite3 module.

    This is the Phase B source-of-truth implementation for local development.
    It mirrors the production cold-tier shape without requiring Postgres.
    """

    def __init__(self, database_path: str, recent_turns: int = 20) -> None:
        self._database_path = database_path
        self._recent_turns = recent_turns
        self._lock = Lock()
        if database_path != ":memory:":
            Path(database_path).parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(database_path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._apply_schema()

    def get_window(self, user_id: str, session_id: str) -> LayeredWindow:
        with self._lock:
            # Pull the newest rows in descending order for an efficient LIMIT,
            # then reverse them below so the planner sees chronological context.
            rows = self._connection.execute(
                """
                SELECT role, content, metadata_json, created_at
                FROM chat_turns
                WHERE user_id = ? AND session_id = ?
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """,
                (user_id, session_id, self._recent_turns),
            ).fetchall()
            summary_row = self._connection.execute(
                """
                SELECT summary
                FROM chat_session_summaries
                WHERE user_id = ? AND session_id = ?
                """,
                (user_id, session_id),
            ).fetchone()
            fact_rows = self._connection.execute(
                """
                SELECT fact
                FROM chat_pinned_facts
                WHERE user_id = ? AND session_id = ?
                ORDER BY created_at ASC, id ASC
                """,
                (user_id, session_id),
            ).fetchall()

        turns = [
            Turn(
                role=row["role"],
                content=row["content"],
                metadata=_loads(row["metadata_json"]),
                created_at=row["created_at"],
            )
            for row in reversed(rows)
        ]
        return LayeredWindow(
            verbatim=turns,
            summary=summary_row["summary"] if summary_row else None,
            pinned_facts=[row["fact"] for row in fact_rows],
        )

    def append_turn(
        self,
        user_id: str,
        session_id: str,
        role: str,
        content: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        created_at = _now()
        # User turns keep a normalized copy for cache-hit comparisons. Assistant
        # turns do not need one because they are only returned after a match.
        normalized = normalize_for_match(content) if role == "user" else None
        with self._lock:
            self._connection.execute(
                """
                INSERT INTO chat_turns (
                    user_id, session_id, role, content, normalized_content,
                    metadata_json, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    user_id,
                    session_id,
                    role,
                    content,
                    normalized,
                    json.dumps(metadata or {}, sort_keys=True),
                    created_at,
                ),
            )
            self._connection.commit()

    def find_cache_hit(
        self, user_id: str, session_id: str, normalized_user_text: str
    ) -> str | None:
        # SQLite can support cache-hit checks for standalone local mode. In
        # tiered mode, this method is called only on the hot client so triage
        # remains cheap and avoids cold rehydrate.
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT role, content, normalized_content
                FROM chat_turns
                WHERE user_id = ? AND session_id = ?
                ORDER BY created_at ASC, id ASC
                """,
                (user_id, session_id),
            ).fetchall()

        for index in range(len(rows) - 2, -1, -1):
            current = rows[index]
            following = rows[index + 1] if index + 1 < len(rows) else None
            if current["role"] != "user" or following is None:
                continue
            if following["role"] != "assistant":
                continue
            normalized = current["normalized_content"] or normalize_for_match(
                current["content"]
            )
            if normalized == normalized_user_text:
                return following["content"]
        return None

    def update_summary(
        self,
        user_id: str,
        session_id: str,
        summary: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        with self._lock:
            self._connection.execute(
                """
                INSERT INTO chat_session_summaries (
                    user_id, session_id, summary, metadata_json, updated_at
                )
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(user_id, session_id)
                DO UPDATE SET
                    summary = excluded.summary,
                    metadata_json = excluded.metadata_json,
                    updated_at = excluded.updated_at
                """,
                (
                    user_id,
                    session_id,
                    summary,
                    json.dumps(metadata or {}, sort_keys=True),
                    _now(),
                ),
            )
            self._connection.commit()

    def pin_fact(
        self,
        user_id: str,
        session_id: str,
        fact: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        with self._lock:
            self._connection.execute(
                """
                INSERT INTO chat_pinned_facts (
                    user_id, session_id, fact, metadata_json, created_at
                )
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    user_id,
                    session_id,
                    fact,
                    json.dumps(metadata or {}, sort_keys=True),
                    _now(),
                ),
            )
            self._connection.commit()

    def delete_session(self, user_id: str, session_id: str) -> None:
        with self._lock:
            for table in (
                "chat_turns",
                "chat_session_summaries",
                "chat_pinned_facts",
            ):
                self._connection.execute(
                    f"DELETE FROM {table} WHERE user_id = ? AND session_id = ?",
                    (user_id, session_id),
                )
            self._connection.commit()

    def health(self) -> HistoryHealth:
        try:
            with self._lock:
                self._connection.execute("SELECT 1").fetchone()
        except sqlite3.Error as exc:
            return HistoryHealth(
                status="unavailable",
                backend="sqlite",
                degraded=True,
                detail=str(exc),
            )
        return HistoryHealth(status="ok", backend="sqlite")

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def _apply_schema(self) -> None:
        # The schema is kept in SQL so the table/index design is visible and can
        # be adapted to Postgres when the production cold tier is introduced.
        schema_path = Path(__file__).with_name("models.sql")
        schema = schema_path.read_text(encoding="utf-8")
        with self._lock:
            self._connection.executescript(schema)
            self._connection.commit()


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _loads(value: str) -> dict[str, Any]:
    try:
        loaded = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}

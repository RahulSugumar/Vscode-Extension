"""Redis hot-tier boundary for Phase B.

The local project can run without Redis installed. This module keeps Redis
imports and operations isolated so production wiring can opt into them later
without leaking Redis details into the agent layer.

Current status:
- Local Phase B runs use memory or SQLite without Redis.
- `TieredChatHistoryClient` can accept a hot-tier object with this same shape.
- The methods below intentionally fail closed until real Redis commands or Lua
  scripts are added in a later production-hardening pass.
"""

from __future__ import annotations

from typing import Any

from chatbot.agent.state import LayeredWindow


class RedisUnavailable(RuntimeError):
    """Raised when the optional Redis hot tier cannot be used."""


class RedisHistoryHotTier:
    """Production-shaped hot-tier adapter.

    Phase B keeps this as a narrow boundary. A real deployment can replace the
    method bodies with Lua-scripted atomic upserts while preserving the client
    contract used by `TieredChatHistoryClient`.
    """

    def __init__(self, redis_url: str, ttl_seconds: int = 3600) -> None:
        # Keep optional Redis dependency loading here. Importing the app should
        # not require `redis` unless the configured backend explicitly asks for
        # a Redis hot tier.
        self.redis_url = redis_url
        self.ttl_seconds = ttl_seconds
        try:
            import redis  # type: ignore  # noqa: F401
        except ImportError as exc:
            raise RedisUnavailable("redis package is not installed") from exc

        raise RedisUnavailable(
            "Redis hot-tier operations are not enabled in this local build"
        )

    def get_window(self, user_id: str, session_id: str) -> LayeredWindow | None:
        # Future implementation: read recent turns, summary, and pinned facts
        # from Redis keys. Empty/missing keys should return None so the tiered
        # client can rehydrate from cold storage during ingest.
        raise RedisUnavailable("Redis hot tier is unavailable")

    def append_turn(
        self,
        user_id: str,
        session_id: str,
        role: str,
        content: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        # Future implementation: atomically append a turn to the recent-turns
        # list, trim to the configured window size, and refresh key TTLs.
        raise RedisUnavailable("Redis hot tier is unavailable")

    def find_cache_hit(
        self, user_id: str, session_id: str, normalized_user_text: str
    ) -> str | None:
        # Future implementation: scan only hot recent user/assistant pairs.
        # Triage must not trigger cold-tier reads or rehydrate work.
        raise RedisUnavailable("Redis hot tier is unavailable")

    def refresh_window(
        self, user_id: str, session_id: str, window: LayeredWindow
    ) -> None:
        # Future implementation: overwrite the hot session window after a cold
        # rehydrate, using a Lua script or transaction to keep layers aligned.
        raise RedisUnavailable("Redis hot tier is unavailable")

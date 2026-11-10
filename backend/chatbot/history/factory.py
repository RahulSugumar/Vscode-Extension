"""Factory for configured history clients."""

from __future__ import annotations

import logging

from chatbot.config.settings import Settings
from chatbot.history.client import TieredChatHistoryClient
from chatbot.history.in_memory_client import InMemoryChatHistoryClient
from chatbot.history.protocol import ChatHistoryClient
from chatbot.history.redis_ops import RedisHistoryHotTier, RedisUnavailable
from chatbot.history.sqlite_client import SQLiteChatHistoryClient


logger = logging.getLogger(__name__)


def build_history_client(settings: Settings) -> ChatHistoryClient:
    """Create the configured history backend with local-safe defaults."""

    if settings.history_backend == "sqlite":
        return SQLiteChatHistoryClient(
            database_path=settings.sqlite_history_path,
            recent_turns=settings.history_recent_turns,
        )

    if settings.history_backend == "tiered":
        # Local tiered mode mirrors production shape: SQLite is durable cold
        # storage, while Redis or memory can serve hot recent-window reads.
        cold_client: ChatHistoryClient = SQLiteChatHistoryClient(
            database_path=settings.sqlite_history_path,
            recent_turns=settings.history_recent_turns,
        )
        hot_client: ChatHistoryClient | None = None
        if settings.redis_url:
            try:
                hot_client = RedisHistoryHotTier(settings.redis_url)
            except RedisUnavailable as exc:
                logger.warning("history_redis_disabled", extra={"detail": str(exc)})
        else:
            # Without Redis, an in-memory hot tier still exercises cache-hit and
            # rehydrate behavior during local development.
            hot_client = InMemoryChatHistoryClient(
                max_turns=settings.history_recent_turns
            )
        return TieredChatHistoryClient(
            cold_client=cold_client,
            hot_client=hot_client,
            degraded_policy=settings.history_degraded_policy,
        )

    if settings.history_backend != "memory":
        logger.warning(
            "history_unknown_backend",
            extra={"backend": settings.history_backend},
        )
    return InMemoryChatHistoryClient(max_turns=settings.history_recent_turns)

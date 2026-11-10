from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from chatbot.agent.state import LayeredWindow, Turn
from chatbot.config.settings import Settings
from chatbot.history.client import TieredChatHistoryClient
from chatbot.history.factory import build_history_client
from chatbot.history.in_memory_client import InMemoryChatHistoryClient
from chatbot.history.protocol import HistoryHealth
from chatbot.history.redaction import RedactingChatHistoryClient, redact_text
from chatbot.history.redis_ops import RedisHistoryHotTier, RedisUnavailable
from chatbot.history.sqlite_client import SQLiteChatHistoryClient, _loads
from chatbot.history.utils import normalize_for_match


def test_normalize_and_in_memory_history_lifecycle() -> None:
    history = InMemoryChatHistoryClient(max_turns=4)
    assert normalize_for_match("  Hello   WORLD ") == "hello world"
    history.append_turn("u", "s", "user", "Hello world", {"source": "ui"})
    history.append_turn("u", "s", "assistant", "Hi")
    history.update_summary("u", "s", "Summary")
    history.pin_fact("u", "s", "Uses Python")

    window = history.get_window("u", "s")
    assert [turn.content for turn in window.verbatim] == ["Hello world", "Hi"]
    assert window.verbatim[0].metadata == {"source": "ui"}
    assert window.summary == "Summary"
    assert window.pinned_facts == ["Uses Python"]
    assert history.find_cache_hit("u", "s", "hello world") == "Hi"
    assert history.find_cache_hit("u", "s", "missing") is None
    assert history.health().counters == {"sessions": 1, "turns": 2}

    replacement = LayeredWindow(
        verbatim=[Turn(role="user", content="New")],
        summary="New summary",
        pinned_facts=["Fact"],
    )
    history.refresh_window("u", "s", replacement)
    assert history.get_window("u", "s") == replacement
    history.delete_session("u", "s")
    assert history.get_window("u", "s").verbatim == []


def test_in_memory_history_enforces_turn_bound() -> None:
    history = InMemoryChatHistoryClient(max_turns=2)
    for index in range(4):
        history.append_turn("u", "s", "user" if index % 2 == 0 else "assistant", str(index))
    assert [turn.content for turn in history.get_window("u", "s").verbatim] == ["2", "3"]


def test_sqlite_history_persists_all_layers_and_cache(tmp_path) -> None:
    path = tmp_path / "history.sqlite3"
    history = SQLiteChatHistoryClient(str(path), recent_turns=2)
    history.append_turn("u", "s", "user", "First question", {"n": 1})
    history.append_turn("u", "s", "assistant", "First answer")
    history.append_turn("u", "s", "user", "Second question")
    history.append_turn("u", "s", "assistant", "Second answer")
    history.update_summary("u", "s", "Summary", {"kind": "rolling"})
    history.update_summary("u", "s", "Updated summary")
    history.pin_fact("u", "s", "Fact one")

    window = history.get_window("u", "s")
    assert [turn.content for turn in window.verbatim] == ["Second question", "Second answer"]
    assert window.summary == "Updated summary"
    assert window.pinned_facts == ["Fact one"]
    assert history.find_cache_hit("u", "s", "first question") == "First answer"
    assert history.find_cache_hit("u", "s", "missing") is None
    assert history.health().status == "ok"

    history.delete_session("u", "s")
    assert history.get_window("u", "s") == LayeredWindow()
    history.close()
    assert history.health().status == "unavailable"
    assert _loads('{"ok": 1}') == {"ok": 1}
    assert _loads("[]") == {}
    assert _loads("not-json") == {}


def test_redaction_masks_secrets_and_delegates() -> None:
    assert "[REDACTED]" in redact_text("password=hunter2")
    assert "[REDACTED_OPENAI_KEY]" in redact_text("sk-" + "a" * 24)
    assert "[REDACTED_GITHUB_TOKEN]" in redact_text("ghp_" + "b" * 24)
    assert redact_text("ordinary text") == "ordinary text"

    wrapped = MagicMock()
    wrapped.get_window.return_value = LayeredWindow()
    wrapped.find_cache_hit.return_value = "cached"
    wrapped.health.return_value = HistoryHealth(backend="fake")
    client = RedactingChatHistoryClient(wrapped)
    client.append_turn("u", "s", "user", "token=secret", {"x": 1})
    client.update_summary("u", "s", "api_key=secret")
    client.pin_fact("u", "s", "safe")
    assert wrapped.append_turn.call_args.args[3] == "token=[REDACTED]"
    assert wrapped.append_turn.call_args.args[4] == {"x": 1, "redacted": True}
    assert wrapped.update_summary.call_args.args[3] == {"redacted": True}
    assert wrapped.pin_fact.call_args.args[3] == {"redacted": False}
    assert client.get_window("u", "s") == LayeredWindow()
    assert client.find_cache_hit("u", "s", "q") == "cached"
    client.delete_session("u", "s")
    assert client.health().backend == "fake"


def test_tiered_history_rehydrates_writes_through_and_reports_health() -> None:
    cold = InMemoryChatHistoryClient()
    hot = InMemoryChatHistoryClient()
    cold.append_turn("u", "s", "user", "Question")
    cold.append_turn("u", "s", "assistant", "Answer")
    client = TieredChatHistoryClient(cold, hot)

    assert client.get_window("u", "s").verbatim[0].content == "Question"
    assert client.get_window("u", "s").verbatim[1].content == "Answer"
    assert client.find_cache_hit("u", "s", "question") == "Answer"
    assert client.find_cache_hit("u", "s", "unknown") is None
    client.append_turn("u", "s", "user", "Next")
    client.update_summary("u", "s", "Summary")
    client.pin_fact("u", "s", "Fact")
    health = client.health()
    assert health.backend == "tiered"
    assert health.counters["rehydrate"] == 1
    assert health.counters["hot_refresh"] == 1
    assert health.counters["hot_append"] == 1
    client.delete_session("u", "s")
    assert cold.get_window("u", "s") == LayeredWindow()
    assert hot.get_window("u", "s") == LayeredWindow()


def test_tiered_history_survives_hot_failures_but_propagates_cold_failure() -> None:
    cold = MagicMock()
    cold.get_window.return_value = LayeredWindow(summary="cold")
    cold.health.return_value = HistoryHealth(
        backend="cold", degraded=False, counters={"reads": 1}
    )
    hot = MagicMock()
    hot.get_window.side_effect = RuntimeError("hot down")
    hot.append_turn.side_effect = RuntimeError("hot down")
    hot.find_cache_hit.side_effect = RuntimeError("hot down")
    hot.update_summary.side_effect = RuntimeError("hot down")
    hot.pin_fact.side_effect = RuntimeError("hot down")
    hot.delete_session.side_effect = RuntimeError("hot down")
    hot.health.return_value = HistoryHealth(
        status="degraded", backend="hot", degraded=True, detail="hot down"
    )
    client = TieredChatHistoryClient(cold, hot)

    assert client.get_window("u", "s").summary == "cold"
    client.append_turn("u", "s", "user", "text")
    assert client.find_cache_hit("u", "s", "text") is None
    client.update_summary("u", "s", "summary")
    client.pin_fact("u", "s", "fact")
    client.delete_session("u", "s")
    health = client.health()
    assert health.status == "degraded"
    assert health.detail == "hot down"
    assert health.counters["hot_window_error"] == 1
    assert health.counters["hot_append_error"] == 1

    cold.get_window.side_effect = ValueError("cold down")
    with pytest.raises(ValueError, match="cold down"):
        client.get_window("u", "s")


def test_tiered_without_hot_skips_cache() -> None:
    cold = InMemoryChatHistoryClient()
    client = TieredChatHistoryClient(cold, None)
    assert client.find_cache_hit("u", "s", "q") is None
    assert client.get_window("u", "s") == LayeredWindow()
    assert client.health().counters["cache_skipped_no_hot"] == 1


def test_history_factory_selects_memory_sqlite_and_tiered(tmp_path, monkeypatch) -> None:
    memory = build_history_client(Settings(history_backend="unknown", history_recent_turns=3))
    assert isinstance(memory, InMemoryChatHistoryClient)

    sqlite = build_history_client(
        Settings(history_backend="sqlite", sqlite_history_path=str(tmp_path / "one.db"))
    )
    assert isinstance(sqlite, SQLiteChatHistoryClient)
    sqlite.close()

    tiered = build_history_client(
        Settings(history_backend="tiered", sqlite_history_path=str(tmp_path / "two.db"))
    )
    assert isinstance(tiered, TieredChatHistoryClient)
    tiered._cold.close()  # type: ignore[attr-defined]

    monkeypatch.setattr(
        "chatbot.history.factory.RedisHistoryHotTier",
        MagicMock(side_effect=RedisUnavailable("disabled")),
    )
    redis_fallback = build_history_client(
        Settings(
            history_backend="tiered",
            sqlite_history_path=str(tmp_path / "three.db"),
            redis_url="redis://localhost",
        )
    )
    assert redis_fallback._hot is None  # type: ignore[attr-defined]
    redis_fallback._cold.close()  # type: ignore[attr-defined]


def test_redis_boundary_fails_closed() -> None:
    with pytest.raises(RedisUnavailable):
        RedisHistoryHotTier("redis://localhost")
    client = object.__new__(RedisHistoryHotTier)
    with pytest.raises(RedisUnavailable):
        client.get_window("u", "s")
    with pytest.raises(RedisUnavailable):
        client.append_turn("u", "s", "user", "text")
    with pytest.raises(RedisUnavailable):
        client.find_cache_hit("u", "s", "text")
    with pytest.raises(RedisUnavailable):
        client.refresh_window("u", "s", LayeredWindow())

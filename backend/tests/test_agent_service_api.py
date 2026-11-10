from __future__ import annotations

from collections import Counter
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

import main as unified_main
from chatbot.agent import service
from chatbot.agent.state import (
    AgentResult,
    AgentState,
    AgentStreamEvent,
    Plan,
    PlanStep,
    StepArtifact,
    TriageDecision,
)
from chatbot.api import main as api_main
from chatbot.api import routes
from chatbot.api.schemas import ChatRequest
from chatbot.config.settings import Settings
from chatbot.history.in_memory_client import InMemoryChatHistoryClient
from chatbot.history.protocol import HistoryHealth


def build_service(decision: TriageDecision, *, answer="Answer", cadence=2):
    instance = object.__new__(service.AgentService)
    instance._settings = Settings(
        llm_provider="local",
        summarizer_enabled=True,
        summarizer_every_turns=cadence,
    )
    instance._history = InMemoryChatHistoryClient()
    instance._triage = SimpleNamespace(decide=lambda *args: decision)
    instance._fast_path = SimpleNamespace(
        compose=lambda text, value: answer,
        stream=lambda text, value: iter(["An", "swer"]),
    )

    def run(state):
        state.response_md = answer
        state.done = True
        state.plan = Plan(steps=[PlanStep(id="a", action="reason", instruction="x")])
        state.scratchpad = [StepArtifact(step_id="a", action="reason", output="done")]
        state.critique_complete = True
        return state

    instance._graph = SimpleNamespace(run=run, run_until_compose=run)
    instance._summarizer = MagicMock()
    instance._turn_counts = Counter()
    return instance


def test_agent_service_fast_and_full_chat(monkeypatch) -> None:
    log_turn = MagicMock()
    schedule = MagicMock()
    monkeypatch.setattr(service.abkb, "log_turn", log_turn)
    monkeypatch.setattr(service, "schedule_judge_run", schedule)

    fast_decision = TriageDecision(triage_class="smalltalk", path="fast", reason="rule")
    fast = build_service(fast_decision)
    result = fast.handle_chat("u", "s", "hello")
    assert result == AgentResult(answer="Answer", path="fast", triage_class="smalltalk")
    assert [turn.role for turn in fast._history.get_window("u", "s").verbatim] == [
        "user",
        "assistant",
    ]
    assert log_turn.call_args.kwargs["agent_id"] == "fast_path"

    full_decision = TriageDecision(triage_class="task", path="full", reason="task")
    full = build_service(full_decision)
    result = full.handle_chat("u", "s", "question")
    assert result.path == "full"
    assert log_turn.call_args.kwargs["agent_id"] == service.FULL_PATH_AGENT_ID
    assert schedule.call_count == 0


def test_agent_service_streams_fast_and_full(monkeypatch) -> None:
    monkeypatch.setattr(service.abkb, "log_turn", MagicMock())
    monkeypatch.setattr(service, "schedule_judge_run", MagicMock())
    fast = build_service(
        TriageDecision(triage_class="smalltalk", path="fast", reason="rule")
    )
    events = list(fast.stream_chat("u", "s", "hello"))
    assert [event.event for event in events] == ["start", "status", "chunk", "chunk", "done"]

    full = build_service(TriageDecision(triage_class="task", path="full", reason="task"))

    class Composer:
        def __init__(self, settings=None):
            pass

        def stream(self, state):
            yield "Full answer"

        def compose(self, state):
            return "fallback"

    monkeypatch.setattr(service, "ComposerClient", Composer)
    events = list(full.stream_chat("u", "s", "question"))
    assert [event.event for event in events][-2:] == ["chunk", "done"]
    assert full._history.get_window("u", "s").verbatim[-1].content == "Full answer"


def test_agent_service_summary_cadence_and_error_telemetry(monkeypatch) -> None:
    instance = build_service(
        TriageDecision(triage_class="smalltalk", path="fast", reason="rule"), cadence=2
    )
    instance._maybe_enqueue_summary("u", "s")
    instance._maybe_enqueue_summary("u", "s")
    instance._summarizer.enqueue_summary_refresh.assert_called_once_with("u", "s")
    instance._summarizer.enqueue_summary_refresh.side_effect = RuntimeError("queue")
    instance._maybe_enqueue_summary("u", "s")
    instance._maybe_enqueue_summary("u", "s")

    instance._settings = Settings(summarizer_enabled=False)
    instance._maybe_enqueue_summary("u", "s")

    log_turn = MagicMock()
    monkeypatch.setattr(service.abkb, "log_turn", log_turn)
    monkeypatch.setattr(service, "schedule_judge_run", MagicMock())
    broken = build_service(
        TriageDecision(triage_class="task", path="full", reason="task")
    )
    broken._triage.decide = MagicMock(side_effect=ValueError("broken"))
    with pytest.raises(ValueError):
        broken.handle_chat("u", "s", "question")
    assert log_turn.call_args.kwargs["error"] == "ValueError"


def test_service_telemetry_helpers_cover_errors_tokens_and_decisions() -> None:
    events = [
        {"kind": "graph_node", "node_id": "planner", "message": "planned", "outcome": "ok"},
        {
            "kind": "tool_call",
            "node_id": "executor",
            "tool_id": "codegraph",
            "step_id": "a",
            "status": "error",
            "error": "down",
            "token_count": "3",
        },
        {
            "kind": "subagent_call",
            "node_id": "planner",
            "subagent_id": "planner",
            "status": "success",
            "token_count": 4,
        },
    ]
    assert service._graph_trace(events)[0]["node"] == "planner"
    tools = service._tool_events(events)
    assert tools[0]["tool_id"] == "codegraph"
    assert service._event_names(service._subagent_events(events), "subagent_id") == ["planner"]
    assert service._message_trace_from_events(events)[0]["role"] == "tool"
    state = AgentState(user_id="u", session_id="s", user_text="q", errors=["agent error"])
    assert len(service._error_events(state, tools)) == 2
    assert service._token_total(events) == 7
    assert service._terminal_action([{"action": "reject_unrelated"}]) == "reject_unrelated"
    assert service._asked_clarifying_question("Could you clarify?") is True
    metrics = service._turn_metrics(
        final_output="answer",
        has_errors=False,
        tool_calls_count=1,
        subagent_calls_count=2,
        node_metrics={},
    )
    assert metrics["task_completion_rate"]["score"] == 0.85
    assert service._runtime_context(Settings())["history_backend"] == "memory"
    assert len(service._tool_definitions()) == 2
    assert service._intent_signals("Where is my_service?", None)["mentions_code_symbol"] is True


def test_routes_health_chat_delete_and_guards(monkeypatch) -> None:
    history = MagicMock()
    history.health.return_value = HistoryHealth(backend="memory")
    codegraph_health = SimpleNamespace(
        status="ok", available=True, metadata={"codegraph_base_url": "internal"}, error=None
    )
    agent = MagicMock()
    agent.handle_chat.return_value = AgentResult(
        answer="Answer", path="fast", triage_class="smalltalk"
    )
    monkeypatch.setattr(routes, "_history_client", history)
    monkeypatch.setattr(routes, "_codegraph_tool", SimpleNamespace(health=lambda: codegraph_health))
    monkeypatch.setattr(routes, "_agent_service", agent)
    monkeypatch.setattr(routes, "_settings", Settings(chat_max_request_chars=5))

    health = routes.healthz()
    assert health.history_backend == "memory"
    response = routes.chat(ChatRequest(user_id="u", session_id="s", text="hello"))
    assert response.answer == "Answer"
    agent.handle_chat.assert_called_once_with(user_id="u", session_id="s", text="hello")
    deleted = routes.delete_session("u", "s")
    assert deleted.deleted is True
    history.delete_session.assert_called_once_with("u", "s")
    with pytest.raises(HTTPException) as exc:
        routes.chat(ChatRequest(text="too long"))
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_routes_stream_success_failure_and_disabled(monkeypatch) -> None:
    monkeypatch.setattr(routes, "_settings", Settings(chat_streaming_enabled=False))
    with pytest.raises(HTTPException) as exc:
        routes.chat_stream(ChatRequest(text="hello"))
    assert exc.value.status_code == 404

    service_mock = MagicMock()
    service_mock.stream_chat.return_value = iter(
        [
            AgentStreamEvent(event="chunk", data={"text": "Hi"}),
            AgentStreamEvent(event="done", data={"path": "fast", "triage_class": "smalltalk"}),
        ]
    )
    monkeypatch.setattr(routes, "_settings", Settings(chat_streaming_enabled=True))
    monkeypatch.setattr(routes, "_agent_service", service_mock)
    response = routes.chat_stream(ChatRequest(text="hello"))
    chunks = [chunk async for chunk in response.body_iterator]
    text = "".join(
        chunk.decode() if isinstance(chunk, bytes) else chunk for chunk in chunks
    )
    assert "event: chunk" in text and "event: done" in text

    service_mock.stream_chat.side_effect = RuntimeError("token=secret https://private")
    response = routes.chat_stream(ChatRequest(text="hello"))
    chunks = [chunk async for chunk in response.body_iterator]
    text = "".join(
        chunk.decode() if isinstance(chunk, bytes) else chunk for chunk in chunks
    )
    assert "event: error" in text
    assert "secret" not in text
    assert "https://" not in text
    assert "<redacted>" in routes._chat_stream_error_message(RuntimeError("api_key=secret"))


def test_reload_runtime_settings_rebuilds_dependencies(monkeypatch) -> None:
    loaded = Settings(history_backend="memory", llm_model="new")
    history = object()
    redacted = object()
    agent = object()
    graph_tool = object()
    monkeypatch.setattr(routes, "load_settings", lambda: loaded)
    monkeypatch.setattr(routes, "build_history_client", lambda settings: history)
    monkeypatch.setattr(routes, "RedactingChatHistoryClient", lambda value: redacted)
    monkeypatch.setattr(routes, "AgentService", lambda **kwargs: agent)
    monkeypatch.setattr(routes, "CodeGraphTool", lambda **kwargs: graph_tool)
    snapshot = routes.reload_runtime_settings()
    assert snapshot["llm_model"] == "new"
    assert routes._history_client is redacted
    assert routes._agent_service is agent


def test_unified_main_endpoints_and_runtime_hot_update(monkeypatch) -> None:
    assert unified_main.root()["status"] == "ok"
    assert unified_main.health()["pid"] > 0
    assert unified_main.admin_health()["project_root"]

    with pytest.raises(ValueError, match="Unsupported runtime config keys"):
        unified_main._apply_runtime_config({"NOT_ALLOWED": "x"})

    close = MagicMock()
    reset = MagicMock()
    reload = MagicMock(return_value={"llm_model": "gpt"})
    snapshot = MagicMock(return_value={"llm_model": "old"})
    monkeypatch.setattr(unified_main, "close_driver", close)
    monkeypatch.setattr(unified_main, "reset_openai_client", reset)
    monkeypatch.setattr(unified_main, "reload_runtime_settings", reload)
    monkeypatch.setattr(unified_main, "runtime_settings_snapshot", snapshot)
    monkeypatch.delenv("NEO4J_PASSWORD", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    result = unified_main._apply_runtime_config(
        {"NEO4J_PASSWORD": " secret ", "OPENAI_API_KEY": "key"}
    )
    assert result == ["NEO4J_PASSWORD", "OPENAI_API_KEY"]
    close.assert_called_once()
    reset.assert_called_once()
    reload.assert_called_once()

    reload.reset_mock()
    result = unified_main._apply_runtime_config({"NEO4J_PASSWORD": "secret"})
    assert result == []
    snapshot.assert_called_once()


def test_json_logging_formatter_and_configuration(monkeypatch) -> None:
    import logging
    import json

    record = logging.LogRecord("name", logging.INFO, __file__, 1, "hello %s", ("world",), None)
    record.user_id = "u"
    payload = json.loads(api_main.JsonFormatter().format(record))
    assert payload["message"] == "hello world"
    assert payload["user_id"] == "u"
    root = logging.getLogger()
    old_handlers = list(root.handlers)
    monkeypatch.delenv("BACKEND_QUIET", raising=False)
    api_main.configure_logging()
    assert len(root.handlers) == 1
    root.handlers = old_handlers

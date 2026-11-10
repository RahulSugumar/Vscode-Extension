from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from chatbot.agent import fast_path, graph, llm, triage
from chatbot.agent.nodes import compose, critique, execute, ingest, plan
from chatbot.agent.state import (
    AgentState,
    LayeredWindow,
    Plan,
    PlanStep,
    StepArtifact,
    TriageDecision,
    Turn,
)
from chatbot.config.settings import Settings
from chatbot.history.in_memory_client import InMemoryChatHistoryClient
from chatbot.worker import summarizer


class FakeChatModel:
    def __init__(self, response=None, chunks=None, error=None):
        self.response = response
        self.chunks = chunks or []
        self.error = error
        self.messages = []

    def invoke(self, messages):
        self.messages = messages
        if self.error:
            raise self.error
        return self.response

    def stream(self, messages):
        self.messages = messages
        if self.error:
            raise self.error
        yield from self.chunks


def test_llm_client_local_live_and_failure_paths(monkeypatch) -> None:
    local = llm.LangChainLLMClient(Settings(llm_provider="local"))
    result = local.invoke("planner", "question")
    assert result.fallback is True
    assert json.loads(result.text)["steps"][0]["action"] == "reason"
    assert "Hi." in "".join(local.stream("fast_path", "hello"))

    response = SimpleNamespace(
        content=[{"text": "Hello"}, " world"],
        usage_metadata={"input_tokens": 2, "output_tokens": 3},
    )
    model = FakeChatModel(response=response, chunks=[SimpleNamespace(content="a"), {"ignored": 1}, "b"])
    client = llm.LangChainLLMClient(
        Settings(llm_provider="openai", llm_model="gpt-test"), chat_model=model
    )
    result = client.invoke("planner", "question", system_prompt="System")
    assert result.text == "Hello\n world"
    assert result.token_count == 3
    assert result.provider == "openai"
    assert len(model.messages) == 2
    assert "a" in "".join(client.stream("planner", "question", system_prompt="System"))

    broken = llm.LangChainLLMClient(
        Settings(llm_provider="openai", llm_model="gpt-test"),
        chat_model=FakeChatModel(error=RuntimeError("down")),
    )
    assert broken.invoke("critic", "x").fallback is True
    assert "complete" in "".join(broken.stream("critic", "x"))


def test_llm_helpers_normalize_responses_and_prompts() -> None:
    assert "planner" in llm.load_prompt("planner").lower()
    assert llm._response_text(SimpleNamespace(content=" text ")) == "text"
    assert llm._response_text(SimpleNamespace(content=[{"text": "a"}, "b", {}])) == "a\nb"
    assert llm._response_text(12) == "12"
    assert llm._stream_chunk_text(SimpleNamespace(content=[{"text": "a"}, " b"])) == "a b"
    assert llm._token_count(SimpleNamespace(response_metadata={"token_usage": {"total_tokens": 9}})) == 9
    assert llm._token_count(object()) is None
    assert len(llm._hash_text("x")) == 16
    assert list(llm._chunk_text("abc", 2)) == ["ab", "c"]
    assert "Recent conversation" in llm._local_response("summarizer", "x")
    assert "available context" in llm._local_response("reason", "x")


def test_llm_build_model_declines_unsupported_or_unconfigured_provider() -> None:
    assert llm.LangChainLLMClient(Settings(llm_provider="unsupported"))._chat_model is None
    assert llm.LangChainLLMClient(
        Settings(llm_provider="openai", llm_model="gpt-test", openai_api_key=None)
    )._chat_model is None


class LLMStub:
    def __init__(self, text="", chunks=()):
        self.text = text
        self.chunks = chunks
        self.calls = []

    def invoke(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return SimpleNamespace(text=self.text)

    def stream(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        yield from self.chunks


@pytest.mark.parametrize(
    ("triage_class", "expected"),
    [
        ("meta", "local codebase chatbot"),
        ("clarification", "specific previous point"),
        ("smalltalk", "Ask me about this codebase"),
    ],
)
def test_fast_path_composer_fallbacks(monkeypatch, triage_class, expected) -> None:
    monkeypatch.setattr(fast_path.abkb, "compose_prompt", lambda prompt, **kwargs: prompt)
    client = fast_path.FastPathComposer(
        llm=LLMStub(text=""), settings=Settings(llm_provider="local")
    )
    decision = TriageDecision(
        triage_class=triage_class, path="fast", reason="rule"
    )
    assert expected in client.compose("hello", decision)


def test_fast_path_cache_model_and_stream(monkeypatch) -> None:
    monkeypatch.setattr(fast_path.abkb, "compose_prompt", lambda prompt, **kwargs: prompt)
    cached = TriageDecision(
        triage_class="cache_hit", path="fast", reason="cache", cached_answer="Old"
    )
    composer = fast_path.FastPathComposer(
        llm=LLMStub(text="Answer", chunks=["A", "", "B"]),
        settings=Settings(llm_provider="local"),
    )
    assert composer.compose("q", cached) == "From the recent conversation: Old"
    assert list(composer.stream("q", cached)) == ["From the recent conversation: Old"]
    decision = TriageDecision(triage_class="meta", path="fast", reason="rule")
    assert composer.compose("q", decision) == "Answer"
    assert list(composer.stream("q", decision)) == ["A", "B"]

    empty_stream = fast_path.FastPathComposer(
        llm=LLMStub(text="fallback", chunks=["", "  "]),
        settings=Settings(llm_provider="local"),
    )
    assert list(empty_stream.stream("q", decision))[-1] == "fallback"


class History:
    def __init__(self, answer=None, error=None):
        self.answer = answer
        self.error = error

    def find_cache_hit(self, *_args):
        if self.error:
            raise self.error
        return self.answer


@pytest.mark.parametrize(
    ("text", "triage_class", "path"),
    [
        ("hello", "smalltalk", "fast"),
        ("what can you do", "meta", "fast"),
        ("can you clarify", "clarification", "fast"),
        ("where is AuthService", "task", "full"),
        ("unknown words", "task", "full"),
    ],
)
def test_triage_rules(text, triage_class, path) -> None:
    decision = triage.TriageEngine(History()).decide("u", "s", text)
    assert (decision.triage_class, decision.path) == (triage_class, path)


def test_triage_cache_classifier_timeout_and_graph_evidence() -> None:
    assert triage.TriageEngine(History(answer="cached")).decide("u", "s", "repeat").triage_class == "cache_hit"
    assert triage.TriageEngine(History(answer="cached")).decide("u", "s", "project code").triage_class == "task"
    assert triage.TriageEngine(History(error=RuntimeError())).decide("u", "s", "hi").triage_class == "smalltalk"
    classifier = SimpleNamespace(classify=lambda text: "meta")
    assert triage.TriageEngine(History(), classifier).decide("u", "s", "ambiguous").triage_class == "meta"
    timed_out = SimpleNamespace(classify=MagicMock(side_effect=TimeoutError()))
    assert triage.TriageEngine(History(), timed_out).decide("u", "s", "ambiguous").path == "full"
    assert triage.needs_current_graph_evidence("architecture") is True
    assert triage.needs_current_graph_evidence("hello") is False


def base_state() -> AgentState:
    return AgentState(
        user_id="u",
        session_id="s",
        user_text="  Explain   code  ",
        triage_class="task",
        path="full",
    )


def test_agent_nodes_mutate_state_and_record_events(monkeypatch) -> None:
    history = InMemoryChatHistoryClient()
    state = ingest.ingest_node(base_state(), history)
    assert state.user_text == "Explain code"
    assert state.window is not None
    assert state.telemetry_events[-1]["node_id"] == "ingest"

    planned = Plan(steps=[PlanStep(id="one", action="reason", instruction="do")])
    monkeypatch.setattr(plan, "PlannerClient", lambda: SimpleNamespace(create_plan=lambda state: planned))
    state = plan.plan_node(state)
    assert state.plan == planned

    def execute_state(value):
        value.scratchpad.append(StepArtifact(step_id="one", action="reason", output="done"))
        value.iteration_count += 1
        return value

    monkeypatch.setattr(execute, "ExecutorClient", lambda: SimpleNamespace(execute=execute_state))
    state = execute.execute_node(state)
    assert state.scratchpad[0].output == "done"

    def critique_state(value):
        value.critique_complete = True
        value.critique_confidence = 0.9
        return value

    monkeypatch.setattr(critique, "CriticClient", lambda: SimpleNamespace(critique=critique_state))
    state = critique.critique_node(state)
    assert state.critique_complete is True

    monkeypatch.setattr(compose, "ComposerClient", lambda: SimpleNamespace(compose=lambda state: "Answer"))
    state = compose.compose_node(state, history)
    assert state.done is True
    assert state.response_md == "Answer"
    assert history.get_window("u", "s").verbatim[-1].role == "assistant"
    state.response_md = "Existing"
    compose.compose_node(state, history)
    assert state.response_md == "Existing"


def test_graph_helpers_and_run_until_compose(monkeypatch) -> None:
    state = base_state()
    assert graph._coerce_state(state.model_dump()) == state
    state.iteration_count = 0
    state.max_iterations = 2
    assert graph._route_after_critique(state) == "execute"
    state.critique_complete = True
    assert graph._route_after_critique(state) == "compose"

    history = InMemoryChatHistoryClient()
    runner = object.__new__(graph.LangGraphAgentRunner)
    runner._history = history
    monkeypatch.setattr(graph, "ingest_node", lambda value, history: value)
    monkeypatch.setattr(graph, "plan_node", lambda value: value)

    def fake_execute(value):
        value.iteration_count += 1
        return value

    def fake_critique(value):
        value.critique_complete = value.iteration_count >= 2
        return value

    monkeypatch.setattr(graph, "execute_node", fake_execute)
    monkeypatch.setattr(graph, "critique_node", fake_critique)
    result = runner.run_until_compose(base_state())
    assert result.iteration_count == 2
    assert result.critique_complete is True

    runner._graph = SimpleNamespace(invoke=lambda payload: {**payload, "done": True})
    assert runner.run(base_state()).done is True
    assert isinstance(graph.build_graph_runner(history), graph.LangGraphAgentRunner)


def test_summary_parser_and_fallback() -> None:
    parsed = summarizer.parse_summary_json(
        '```json\n{"summary":"Done","pinned_facts":["Python"]}\n```'
    )
    assert parsed.summary == "Done"
    assert summarizer.parse_summary_json('prefix {"summary":"Found"} suffix').summary == "Found"
    with pytest.raises(ValueError):
        summarizer.parse_summary_json("[]")
    with pytest.raises(ValueError):
        summarizer.parse_summary_json("no json")
    assert "No durable" in summarizer._fallback_summary([])
    turns = [Turn(role="user", content=str(index)) for index in range(6)]
    assert summarizer._fallback_summary(turns) == "Recent session context: 2 | 3 | 4 | 5"


def test_summary_queue_success_failure_disabled_and_background(monkeypatch) -> None:
    history = InMemoryChatHistoryClient()
    history.append_turn("u", "s", "user", "Question")
    history.pin_fact("u", "s", "Existing")
    model = LLMStub(text='{"summary":"Summary","pinned_facts":[" Existing ","New",""]}')
    monkeypatch.setattr(summarizer.abkb, "compose_prompt", lambda prompt, **kwargs: prompt)
    queue = summarizer.SummaryRefreshQueue(
        history,
        llm=model,
        settings=Settings(summarizer_enabled=True),
        auto_start=False,
    )
    assert queue.drain_once() is False
    queue.enqueue_summary_refresh("u", "s")
    assert queue.drain_once() is True
    window = history.get_window("u", "s")
    assert window.summary == "Summary"
    assert window.pinned_facts == ["Existing", "New"]
    assert queue.counters == {"enqueued": 1, "completed": 1, "failed": 0}

    model.text = "bad json"
    queue.enqueue_summary_refresh("u", "s")
    assert queue.drain_once() is True
    assert history.get_window("u", "s").summary.startswith("Recent session context")

    broken_history = MagicMock()
    broken_history.get_window.side_effect = RuntimeError("history down")
    broken = summarizer.SummaryRefreshQueue(
        broken_history, llm=model, settings=Settings(), auto_start=False
    )
    broken.enqueue_summary_refresh("u", "s")
    assert broken.drain_once() is False
    assert broken.counters["failed"] == 1

    disabled = summarizer.SummaryRefreshQueue(
        history,
        llm=model,
        settings=Settings(summarizer_enabled=False),
        auto_start=False,
    )
    disabled.enqueue_summary_refresh("u", "s")
    assert disabled.counters["enqueued"] == 0

    thread = MagicMock()
    monkeypatch.setattr(summarizer, "Thread", MagicMock(return_value=thread))
    auto = summarizer.SummaryRefreshQueue(history, llm=model, settings=Settings(), auto_start=True)
    auto.enqueue_summary_refresh("u", "s")
    thread.start.assert_called_once()

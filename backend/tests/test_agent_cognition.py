from __future__ import annotations

import json
from concurrent.futures import TimeoutError as FutureTimeout
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from chatbot.agent import composer, critic, executor, planner
from chatbot.agent.llm import LLMCallResult
from chatbot.agent.state import AgentState, LayeredWindow, Plan, PlanStep, StepArtifact, Turn
from chatbot.agent.tools.codegraph import CodeGraphToolResult
from chatbot.config.settings import Settings


def call_result(text: str) -> LLMCallResult:
    return LLMCallResult(
        text=text,
        provider="local",
        model="test",
        prompt_hash="hash",
        latency_ms=1,
        token_count=2,
        fallback=False,
    )


class InvokeLLM:
    def __init__(self, text: str):
        self.text = text

    def invoke(self, *_args, **_kwargs):
        return call_result(self.text)


class StreamLLM(InvokeLLM):
    def __init__(self, text="", chunks=()):
        super().__init__(text)
        self.chunks = chunks

    def stream(self, *_args, **_kwargs):
        yield from self.chunks


def state_for(text="bounded question") -> AgentState:
    return AgentState(
        user_id="u",
        session_id="s",
        user_text=text,
        triage_class="task",
        path="full",
        window=LayeredWindow(
            verbatim=[Turn(role="user", content="previous")],
            summary="summary",
            pinned_facts=["fact"],
        ),
    )


def test_planner_client_valid_and_fallback_results(monkeypatch) -> None:
    monkeypatch.setattr(planner.abkb, "compose_prompt", lambda prompt, **kwargs: prompt)
    valid = '{"steps":[{"id":"one","action":"reason","instruction":"Answer"}]}'
    state = state_for("bounded question")
    plan_value = planner.PlannerClient(
        llm=InvokeLLM(valid), settings=Settings(planner_max_steps=3)
    ).create_plan(state)
    assert plan_value.steps[0].action == "reason"
    assert plan_value.metadata["parse_outcome"] == "ok"
    assert state.metrics["planner"]["token_count"] == 2
    assert state.telemetry_events[-1]["subagent_id"] == "planner"

    broken = planner.PlannerClient(
        llm=InvokeLLM("not json"), settings=Settings(planner_max_steps=3)
    ).create_plan(state_for("summarize this"))
    assert broken.metadata["parse_outcome"] == "fallback"
    assert broken.metadata["parse_error"] == "ValueError"


@pytest.mark.parametrize(
    "plan_value",
    [
        Plan(),
        Plan(steps=[PlanStep(id="a", action="reason", instruction="x")] * 2),
        Plan(steps=[PlanStep(id="a", action="reason", instruction="x", depends_on=["missing"])]),
    ],
)
def test_validate_plan_rejects_invalid_plans(plan_value) -> None:
    with pytest.raises(ValueError):
        planner.validate_plan(plan_value, 1)


def test_validate_plan_detects_cycle_and_accepts_ordered_dependencies() -> None:
    valid = Plan(
        steps=[
            PlanStep(id="a", action="reason", instruction="x"),
            PlanStep(id="b", action="reason", instruction="y", depends_on=["a"]),
        ]
    )
    planner.validate_plan(valid, 2)
    cyclic = Plan(
        steps=[
            PlanStep(id="a", action="reason", instruction="x", depends_on=["b"]),
            PlanStep(id="b", action="reason", instruction="y", depends_on=["a"]),
        ]
    )
    with pytest.raises(ValueError):
        planner._ensure_acyclic(cyclic)


@pytest.mark.parametrize(
    ("text", "action"),
    [
        ("", "ask_clarification"),
        ("Give full project overview", "query_project_inventory"),
        ("Where is AuthService used?", "query_codegraph"),
        ("compare two values", "compare"),
        ("summarize notes", "summarize"),
        ("ordinary bounded request", "reason"),
    ],
)
def test_fallback_plan_selects_safe_action(text, action) -> None:
    assert planner.fallback_plan(text).steps[0].action == action


def test_planner_helpers_parse_context_and_clip() -> None:
    assert planner.parse_plan_json(
        '```json\n{"steps":[{"id":"a","action":"reason","instruction":"x"}]}\n```'
    ).steps[0].id == "a"
    assert planner._extract_json_object('prefix {"steps": []} suffix') == {"steps": []}
    with pytest.raises(ValueError):
        planner._extract_json_object("[]")
    with pytest.raises(ValueError):
        planner._extract_json_object("no json")
    payload = json.loads(planner._planner_input(state_for()))
    assert payload["layered_window"]["summary"] == "summary"
    assert "truncated" in planner._clip_text("abcdef", 3)
    plan_value = Plan(steps=[PlanStep(id="step", action="reason", instruction="x")])
    assert planner._unique_step_id(plan_value, "step") == "step-1"


def test_executor_handles_missing_invalid_terminal_and_step_cap(monkeypatch) -> None:
    monkeypatch.setattr(executor.abkb, "compose_prompt", lambda prompt, **kwargs: prompt)
    client = executor.ExecutorClient(
        llm=InvokeLLM("reasoned"), settings=Settings(executor_max_steps=1), codegraph=MagicMock()
    )
    no_plan = client.execute(state_for())
    assert no_plan.errors == ["No plan available for execution."]

    invalid = state_for()
    invalid.plan = Plan(
        steps=[PlanStep(id="b", action="reason", instruction="x", depends_on=["missing"])]
    )
    assert "unknown dependencies" in client.execute(invalid).errors[0]

    terminal = state_for()
    terminal.plan = Plan(
        steps=[
            PlanStep(id="a", action="ask_clarification", instruction="Please specify"),
            PlanStep(id="b", action="reason", instruction="never"),
        ]
    )
    client.execute(terminal)
    assert terminal.done is True
    assert terminal.response_md == "Please specify"
    assert len(terminal.scratchpad) == 1

    capped = state_for()
    capped.plan = Plan(
        steps=[
            PlanStep(id="a", action="reason", instruction="one"),
            PlanStep(id="b", action="reason", instruction="two", depends_on=["a"]),
        ]
    )
    client.execute(capped)
    assert "Executor step cap reached." in capped.errors


def test_executor_llm_step_timeout_and_helpers(monkeypatch) -> None:
    monkeypatch.setattr(executor.abkb, "compose_prompt", lambda prompt, **kwargs: prompt)
    state = state_for()
    state.plan = Plan(steps=[PlanStep(id="a", action="reason", instruction="reason")])
    client = executor.ExecutorClient(
        llm=InvokeLLM("output"), settings=Settings(), codegraph=MagicMock()
    )
    client.execute(state)
    assert state.scratchpad[0].output == "output"
    assert state.scratchpad[0].metadata["provider"] == "local"

    monkeypatch.setattr(executor, "_with_timeout", MagicMock(side_effect=FutureTimeout()))
    timed = state_for()
    artifact = client._execute_step(
        PlanStep(id="t", action="reason", instruction="slow"), timed
    )
    assert artifact.error == "timeout"
    monkeypatch.undo()

    assert executor._with_timeout(None, lambda: 3) == 3
    assert executor._metadata_int({"x": "bad"}, "x", 4) == 4
    assert executor._clip_text(None) == ""
    assert "truncated" in executor._clip_text("abcd", 2)
    step = PlanStep(
        id="r",
        action="query_codegraph",
        instruction="q",
        metadata={"retrieval_profile": "workflow", "requested_top_k": 20},
    )
    request = executor._retrieval_request_for_step(step)
    assert request["profile"] == "workflow"
    assert request["final_k"] == 20


class CodeGraph:
    def __init__(self, value=None, error=None):
        self.value = value
        self.error = error
        self.calls = []

    def retrieve(self, query, **kwargs):
        self.calls.append((query, kwargs))
        if self.error:
            raise self.error
        return self.value

    def project_inventory(self):
        if self.error:
            raise self.error
        return self.value


def test_executor_normalizes_codegraph_results_legacy_and_failures() -> None:
    result = CodeGraphToolResult(
        output="evidence",
        available=True,
        status="ok",
        metadata={"tool": "codegraph"},
    )
    client = executor.ExecutorClient(llm=InvokeLLM(""), settings=Settings(), codegraph=CodeGraph(result))
    step = PlanStep(id="g", action="query_codegraph", instruction="query")
    artifact = client._query_codegraph(step, state_for())
    assert artifact.output == "evidence"
    assert artifact.metadata["available"] is True

    legacy = executor.ExecutorClient(
        llm=InvokeLLM(""), settings=Settings(), codegraph=CodeGraph("legacy truncated=True")
    )
    assert legacy._query_codegraph(step, state_for()).truncated is True
    assert legacy._query_project_inventory(
        PlanStep(id="i", action="query_project_inventory", instruction="inventory"),
        state_for(),
    ).metadata["tool"] == "codegraph_project_inventory_legacy"

    broken = executor.ExecutorClient(
        llm=InvokeLLM(""),
        settings=Settings(),
        codegraph=CodeGraph(error=RuntimeError("down")),
    )
    assert broken._query_codegraph(step, state_for()).error == "RuntimeError"
    assert broken._query_project_inventory(
        PlanStep(id="i", action="query_project_inventory", instruction="inventory"),
        state_for(),
    ).error == "RuntimeError"


def test_execution_dependency_validator_and_step_input() -> None:
    valid = Plan(
        steps=[
            PlanStep(id="a", action="reason", instruction="a"),
            PlanStep(id="b", action="reason", instruction="b", depends_on=["a"]),
        ]
    )
    assert executor.validate_execution_dependencies(valid) is None
    cyclic = Plan(
        steps=[
            PlanStep(id="a", action="reason", instruction="a", depends_on=["b"]),
            PlanStep(id="b", action="reason", instruction="b", depends_on=["a"]),
        ]
    )
    assert "Cyclic" in executor.validate_execution_dependencies(cyclic)
    missing = Plan(
        steps=[PlanStep(id="b", action="reason", instruction="b", depends_on=["x"])]
    )
    assert "unknown dependencies" in executor.validate_execution_dependencies(missing)
    state = state_for()
    state.scratchpad = [StepArtifact(step_id="a", action="reason", output="evidence")]
    assert "evidence" in executor._step_input(valid.steps[1], state)


def test_critic_parsing_completion_followup_and_guards(monkeypatch) -> None:
    monkeypatch.setattr(critic.abkb, "compose_prompt", lambda prompt, **kwargs: prompt)
    parsed = critic.parse_critique_json(
        '```json\n{"complete":true,"confidence":0.9,"missing":null}\n```'
    )
    assert parsed.complete is True
    with pytest.raises(ValueError):
        critic.parse_critique_json("[]")

    state = state_for()
    state.plan = Plan(steps=[PlanStep(id="a", action="reason", instruction="x")])
    client = critic.CriticClient(
        llm=InvokeLLM(
            '{"complete":false,"confidence":0.3,"missing":"more",'
            '"follow_up_instruction":"Get more evidence"}'
        ),
        settings=Settings(critic_confidence_threshold=0.8),
    )
    no_artifacts = client.critique(state)
    assert no_artifacts.critique_complete is False
    assert no_artifacts.plan.steps[-1].metadata["critic_follow_up"] is True

    state = state_for()
    state.plan = Plan(steps=[PlanStep(id="a", action="reason", instruction="x")])
    state.scratchpad = [StepArtifact(step_id="a", action="reason", output="done")]
    state.iteration_count = 1
    result = client.critique(state)
    assert result.critique_complete is False
    assert result.critique_missing == "more"

    state.iteration_count = state.max_iterations
    assert client.critique(state).critique_complete is True

    unchanged = state_for()
    unchanged.plan = state.plan
    unchanged.scratchpad = state.scratchpad
    unchanged.last_scratchpad_hash = critic._scratchpad_hash(unchanged)
    assert client.critique(unchanged).critique_complete is True


def test_critic_malformed_output_helpers_and_inventory_recovery(monkeypatch) -> None:
    monkeypatch.setattr(critic.abkb, "compose_prompt", lambda prompt, **kwargs: prompt)
    state = state_for("Give full project overview")
    state.plan = Plan(steps=[PlanStep(id="a", action="query_codegraph", instruction="q")])
    state.scratchpad = [
        StepArtifact(step_id="a", action="query_codegraph", output="few matches")
    ]
    result = critic.CriticClient(llm=InvokeLLM("bad json"), settings=Settings()).critique(state)
    assert result.plan.steps[-1].action == "query_project_inventory"
    assert critic._needs_project_inventory_recovery(result) is False

    normal = state_for()
    normal.plan = Plan(steps=[PlanStep(id="a", action="reason", instruction="x")])
    normal.scratchpad = [StepArtifact(step_id="a", action="reason", output="done")]
    called = critic.CriticClient(llm=InvokeLLM("bad json"), settings=Settings()).critique(normal)
    assert called.critique_confidence == 0.75
    assert "malformed" in called.critique_missing
    assert json.loads(critic._critic_input(normal))["artifacts"]
    assert len(critic._scratchpad_hash(normal)) == 16
    assert "truncated" in critic._clip_text("abcd", 2)


def test_composer_existing_live_fallback_stream_and_codegraph_notes(monkeypatch) -> None:
    monkeypatch.setattr(composer.abkb, "compose_prompt", lambda prompt, **kwargs: prompt)
    state = state_for()
    state.response_md = "Existing"
    client = composer.ComposerClient(llm=StreamLLM(), settings=Settings())
    assert client.compose(state) == "Existing"
    assert list(client.stream(state)) == ["Existing"]

    state.response_md = None
    state.plan = Plan(steps=[PlanStep(id="g", action="query_codegraph", instruction="q")])
    state.scratchpad = [
        StepArtifact(
            step_id="g",
            action="query_codegraph",
            output="evidence",
            metadata={"tool": "codegraph_stub", "available": True},
        )
    ]
    live = composer.ComposerClient(
        llm=StreamLLM(text="Answer", chunks=["Answer"]), settings=Settings()
    )
    assert "stub mode" in live.compose(state)
    assert "stub mode" in "".join(live.stream(state))

    empty = composer.ComposerClient(
        llm=StreamLLM(text="", chunks=[""]), settings=Settings()
    )
    assert "CodeGraph evidence directly" in empty.compose(state)
    assert "CodeGraph evidence directly" in "".join(empty.stream(state))

    state.scratchpad[0].metadata = {"tool": "codegraph", "available": False}
    state.scratchpad[0].error = "down"
    assert "unavailable" in composer._codegraph_note(state, "Answer")
    assert composer._bounded_artifact_output("abcd", 2).endswith("characters]")
    assert composer._looks_like_llm_local_fallback(
        "I processed this through the cognition path using the available layered window"
    )
    assert json.loads(composer._composer_input(state))["layered_window"]["summary"] == "summary"

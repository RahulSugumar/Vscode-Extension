from __future__ import annotations

from types import SimpleNamespace

import pytest
from pydantic import ValidationError

import abkb_runtime
import state as improvement_state
from chatbot.agent.state import AgentState, record_telemetry_event
from models import ABKBFile, PolicyPayload, StoredPolicy, Suggestion


def test_policy_payload_normalizes_text_and_scope() -> None:
    global_policy = PolicyPayload(
        workflow_id="flow",
        policy="  first line\nsecond line  ",
        scope_type="global",
        scope_id="ignored",
    )
    assert global_policy.policy == "first line second line"
    assert global_policy.scope_id is None

    tool_policy = PolicyPayload(
        workflow_id="flow",
        policy="Use validation",
        scope_type="tool",
        scope_id=["shell", "git"],
    )
    assert tool_policy.scope_id == ["shell", "git"]


@pytest.mark.parametrize(
    "payload",
    [
        {"workflow_id": "flow", "policy": "   ", "scope_type": "global"},
        {"workflow_id": "flow", "policy": "Rule", "scope_type": "agent"},
        {"workflow_id": "flow", "policy": "Rule", "scope_type": "tool", "scope_id": []},
    ],
)
def test_policy_payload_rejects_invalid_policy(payload: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        PolicyPayload.model_validate(payload)


def test_stored_policy_and_container_defaults_are_independent() -> None:
    base = {
        "workflow_id": "flow",
        "policy": "Rule",
        "scope_type": "global",
        "origin": "user_custom",
    }
    first = StoredPolicy(**base)
    second = StoredPolicy(**base)
    assert first.id.startswith("pol_")
    assert first.id != second.id
    assert first.active is True
    assert first.timestamp

    file_one = ABKBFile()
    file_two = ABKBFile()
    file_one.policies.append(first)
    assert file_two.policies == []

    suggestion = Suggestion(
        title="Rule",
        description="Description",
        policy_payload=PolicyPayload(**{k: v for k, v in base.items() if k != "origin"}),
    )
    assert suggestion.id.startswith("sug_")
    assert suggestion.steps == []


def test_runtime_paths_follow_environment(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    project = tmp_path / "project"
    home = tmp_path / "custom-home"
    monkeypatch.setenv("ABKB_PROJECT_ROOT", str(project))
    monkeypatch.setenv("ABKB_HOME", str(home))
    monkeypatch.delenv("ABKB_DB_PATH", raising=False)
    monkeypatch.delenv("ABKB_TELEMETRY_PATH", raising=False)
    monkeypatch.delenv("ABKB_JUDGE_STATE_PATH", raising=False)
    monkeypatch.delenv("ABKB_JUDGE_TRACE_PATH", raising=False)

    assert abkb_runtime.project_root() == project.resolve()
    assert abkb_runtime.abkb_dir() == home
    assert home.is_dir()
    assert abkb_runtime.db_path() == home / "abkb.db"
    assert abkb_runtime.telemetry_path() == home / "telemetry" / "agent_turns.jsonl"
    assert abkb_runtime.judge_state_path().name == "judge_state.json"
    assert abkb_runtime.judge_trace_path().name == "judge_trace.jsonl"

    monkeypatch.setenv("ABKB_DB_PATH", str(tmp_path / "override.db"))
    assert abkb_runtime.db_path() == tmp_path / "override.db"


def test_runtime_serializes_policies_reports_and_scope_ids(monkeypatch) -> None:
    policy = SimpleNamespace(
        id=7,
        workflow_id="flow",
        policy="Rule",
        scope="tool",
        scope_id="shell",
        metadata={"confidence": 0.9},
        status="pending",
    )
    assert abkb_runtime.policy_to_payload(policy, origin="user") == {
        "id": "7",
        "workflow_id": "flow",
        "policy": "Rule",
        "scope_type": "tool",
        "scope_id": "shell",
        "metadata": {"confidence": 0.9},
        "origin": "user",
        "status": "pending",
    }

    monkeypatch.setenv("ABKB_INTEGRATOR_MODEL", "judge-model")
    llm_report = SimpleNamespace(
        to_dict=lambda: {"findings": []}, raw_response="{}", reviewer_error=""
    )
    fallback_report = SimpleNamespace(
        to_dict=lambda: {}, raw_response="", reviewer_error="timeout"
    )
    assert abkb_runtime.report_to_payload(llm_report)["reviewer"] == {
        "mode": "llm",
        "model": "judge-model",
    }
    assert abkb_runtime.report_to_payload(fallback_report)["reviewer"]["mode"] == "heuristic_fallback"
    assert abkb_runtime.report_to_payload(fallback_report)["reviewer"]["error"] == "timeout"
    assert abkb_runtime.report_to_payload(object())["reviewer"]["mode"] == "heuristic"

    assert abkb_runtime.scope_id_to_storage(None) is None
    assert abkb_runtime.scope_id_to_storage([" shell ", "", "git"]) == "shell, git"
    assert abkb_runtime.scope_id_to_storage([]) is None
    assert abkb_runtime.scope_id_to_storage("  agent-1 ") == "agent-1"
    assert abkb_runtime.scope_id_to_storage(" ") is None


def test_agent_state_records_structured_telemetry() -> None:
    state = AgentState(user_id="u", session_id="s", user_text="hello")
    record_telemetry_event(
        state,
        kind="tool_call",
        node_id="executor",
        message="done",
        status="ok",
    )
    event = state.telemetry_events[0]
    assert event["kind"] == "tool_call"
    assert event["node_id"] == "executor"
    assert event["status"] == "ok"
    assert event["timestamp"]


def test_improvement_plane_suggestion_cache_is_mutable_and_typed() -> None:
    improvement_state.SUGGESTION_CACHE.clear()
    cached = PolicyPayload(
        workflow_id="flow", policy="Cached rule", scope_type="global"
    )
    improvement_state.SUGGESTION_CACHE["suggestion-1"] = cached
    assert improvement_state.SUGGESTION_CACHE["suggestion-1"] is cached
    improvement_state.SUGGESTION_CACHE.clear()

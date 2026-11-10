from __future__ import annotations

import json
from dataclasses import dataclass
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

import abkb_api
import abkb_background


def make_policy(policy_id: int = 7, text: str = "Validate input", **kwargs):
    defaults = {
        "id": policy_id,
        "workflow_id": "flow",
        "policy": text,
        "scope": "global",
        "scope_id": None,
        "metadata": {},
        "status": "pending",
    }
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


def make_report(candidate=None, related_ids=None, compared=None):
    return SimpleNamespace(
        candidate=candidate,
        related_policy_ids=related_ids or [],
        compared_policies=compared or [],
        raw_response="",
        reviewer_error="",
        to_dict=lambda: {
            "findings": [],
            "related_policy_ids": related_ids or [],
            "recommendation": "review",
            "rationale": "check",
        },
    )


@pytest.fixture(autouse=True)
def reset_background_state():
    abkb_background._reset_for_tests()
    yield
    abkb_background._reset_for_tests()


def test_abkb_health_diagnostics_and_policy_listing(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(abkb_api, "db_path", lambda: tmp_path / "db")
    monkeypatch.setattr(abkb_api, "telemetry_path", lambda: tmp_path / "turns")
    monkeypatch.setattr(abkb_api, "background_judge_status", lambda: {"running": False})
    monkeypatch.setattr(abkb_api.abkb, "doctor", lambda emit=False: {"ok": not emit})
    integrator = MagicMock()
    integrator.list_policies.return_value = [make_policy()]
    monkeypatch.setattr(abkb_api.abkb, "Integrator", lambda: integrator)

    assert abkb_api.abkb_health()["background_judge"] == {"running": False}
    assert abkb_api.abkb_diagnostics() == {"ok": True}
    listed = abkb_api.list_policies("flow", "active", "global", None)
    assert listed["policies"][0]["id"] == "7"
    integrator.list_policies.assert_called_once_with(
        workflow_id="flow", status="active", scope="global", scope_id=None
    )

    monkeypatch.setattr(abkb_api.abkb, "doctor", MagicMock(side_effect=RuntimeError("broken")))
    with pytest.raises(HTTPException) as exc:
        abkb_api.abkb_diagnostics()
    assert exc.value.status_code == 500


def test_judge_suggestions_combines_run_and_pending(monkeypatch) -> None:
    run = SimpleNamespace(
        source_id="source",
        source_kind="jsonl",
        turns_read=3,
        turns_processed=2,
        skipped_turns=1,
        malformed_records=0,
        candidates_added=1,
        candidate_policy_ids=[7],
    )
    policy = make_policy(metadata={"confidence": 0.8})
    monkeypatch.setattr(abkb_api, "_run_judge", lambda: run)
    monkeypatch.setattr(abkb_api, "_suggestions", lambda workflow_id: [abkb_api._suggestion_from_policy(policy)])
    response = abkb_api.judge_suggestions(abkb_api.SuggestionsRequest(workflow_id="flow"))
    assert response["run"]["turns_processed"] == 2
    assert response["suggestions"][0]["description"].endswith("(confidence 0.8)")

    monkeypatch.setattr(abkb_api, "_run_judge", MagicMock(side_effect=ValueError("judge down")))
    monkeypatch.setattr(abkb_api, "_suggestions", MagicMock(side_effect=RuntimeError("db down")))
    failed = abkb_api.judge_suggestions(abkb_api.SuggestionsRequest())
    assert failed["run"] is None
    assert failed["run_error"] == "judge down"
    assert failed["suggestions"] == []
    assert failed["suggestions_error"] == "db down"


@pytest.mark.asyncio
async def test_judge_suggestion_stream_emits_complete_protocol(monkeypatch) -> None:
    monkeypatch.setattr(abkb_api, "telemetry_path", lambda: "turns.jsonl")
    monkeypatch.setattr(abkb_api, "db_path", lambda: "db.sqlite")
    monkeypatch.setattr(abkb_api, "_run_judge_safe", lambda: (None, None))
    monkeypatch.setattr(abkb_api, "_suggestions_safe", lambda workflow: ([{"id": "7"}], None))
    response = abkb_api.judge_suggestions_stream(abkb_api.SuggestionsRequest())
    chunks = [chunk async for chunk in response.body_iterator]
    text = "".join(chunk.decode() if isinstance(chunk, bytes) else chunk for chunk in chunks)
    assert "event: start" in text
    assert "event: judge.run" in text
    assert "event: suggestion" in text
    assert "event: done" in text

    monkeypatch.setattr(abkb_api, "_suggestions_safe", MagicMock(side_effect=RuntimeError("stream broke")))
    error_response = abkb_api.judge_suggestions_stream(abkb_api.SuggestionsRequest(run_judge=False))
    error_chunks = [chunk async for chunk in error_response.body_iterator]
    error_text = "".join(
        chunk.decode() if isinstance(chunk, bytes) else chunk for chunk in error_chunks
    )
    assert "event: error" in error_text
    assert "stream broke" in error_text


def test_accept_requires_review_then_activates_when_confirmed(monkeypatch) -> None:
    candidate = make_policy()
    conflict = make_policy(8, "Old rule", status="active")
    report = make_report(candidate, [8], [conflict])
    activated = make_policy(7, status="active")
    integrator = MagicMock()
    integrator.check_policy.return_value = report
    integrator.activate_candidate.return_value = activated
    monkeypatch.setattr(abkb_api.abkb, "Integrator", lambda: integrator)

    review = abkb_api.abkb_accept(abkb_api.AcceptPolicyRequest(policyId="policy:7"))
    assert review["needs_review"] is True
    assert review["conflicting_policies"][0]["id"] == "8"
    integrator.activate_candidate.assert_not_called()

    accepted = abkb_api.abkb_accept(
        abkb_api.AcceptPolicyRequest(
            policyId="7", force_replace=True, delete_policy_ids=[8]
        )
    )
    assert accepted["activated"] is True
    integrator.activate_candidate.assert_called_once_with(
        7, delete_policy_ids=[8], delete_all_pending=True
    )

    integrator.check_policy.side_effect = RuntimeError("cannot check")
    with pytest.raises(HTTPException) as exc:
        abkb_api.abkb_accept(abkb_api.AcceptPolicyRequest(policyId="7"))
    assert exc.value.status_code == 400


def test_custom_policy_and_discard(monkeypatch) -> None:
    candidate = make_policy(scope="tool", scope_id="shell, git")
    report = make_report(candidate)
    integrator = MagicMock()
    integrator.propose_policy.return_value = report
    monkeypatch.setattr(abkb_api.abkb, "Integrator", lambda: integrator)
    request = abkb_api.CustomPolicyRequest(
        payload=abkb_api.PolicyPayload(
            workflow_id="flow",
            policy="Custom",
            scope_type="tool",
            scope_id=["shell", "git"],
            metadata={"owner": "user"},
        )
    )
    response = abkb_api.abkb_custom(request)
    assert response["needs_review"] is True
    assert response["policy"]["origin"] == "user"
    integrator.propose_policy.assert_called_once_with(
        workflow_id="flow",
        scope="tool",
        scope_id="shell, git",
        policy="Custom",
        metadata={
            "created_by": "extension.custom",
            "prompt_placement": "tail",
            "owner": "user",
        },
    )

    assert abkb_api.abkb_discard(abkb_api.DiscardPolicyRequest(policyId="7")) == {
        "ok": True,
        "discarded_id": "7",
    }
    integrator.discard_candidate.assert_called_with(7)
    integrator.discard_candidate.side_effect = RuntimeError("cannot discard")
    with pytest.raises(HTTPException):
        abkb_api.abkb_discard(abkb_api.DiscardPolicyRequest(policyId="7"))


def test_abkb_helpers_cover_payload_edge_cases(monkeypatch) -> None:
    assert abkb_api._activation_confirmed(abkb_api.AcceptPolicyRequest(policyId="1")) is False
    assert abkb_api._activation_confirmed(
        abkb_api.AcceptPolicyRequest(policyId="1", delete_policy_ids=[2])
    ) is True
    assert abkb_api._candidate_payload(None, origin="judge") is None
    assert abkb_api._candidate_payload({"id": "draft"}, origin="judge") == {"id": "draft"}
    assert abkb_api._title_for_policy(make_policy(text="a" * 80)).endswith("...")
    assert abkb_api._run_payload(None) is None
    assert json.loads(abkb_api._format_sse("x", {"value": object()}).split("data: ", 1)[1])
    assert abkb_api._parse_policy_id(" policy:12 ") == 12
    with pytest.raises(HTTPException) as exc:
        abkb_api._parse_policy_id("bad")
    assert exc.value.status_code == 400


def test_background_scheduler_disabled_coalesces_and_handles_thread_failure(monkeypatch) -> None:
    monkeypatch.setenv("ABKB_BACKGROUND_JUDGE_ENABLED", "false")
    assert abkb_background.schedule_judge_run() is False

    monkeypatch.setenv("ABKB_BACKGROUND_JUDGE_ENABLED", "true")
    thread = MagicMock()
    constructor = MagicMock(return_value=thread)
    monkeypatch.setattr(abkb_background.threading, "Thread", constructor)
    assert abkb_background.schedule_judge_run("first") is True
    assert abkb_background.schedule_judge_run("second") is True
    constructor.assert_called_once()
    thread.start.assert_called_once()
    assert abkb_background.background_judge_status()["pending_requests"] == 2

    abkb_background._reset_for_tests()
    thread.start.side_effect = RuntimeError("no threads")
    assert abkb_background.schedule_judge_run() is False
    assert abkb_background.background_judge_status()["scheduled"] is False


def test_background_worker_success_failure_and_cadence(monkeypatch) -> None:
    monkeypatch.setattr(
        abkb_background,
        "run_judge_once",
        lambda: {"turns_processed": 2, "candidates_added": 1},
    )
    abkb_background._run_background_judge("turn", 3)
    status = abkb_background.background_judge_status()
    assert status["run_count"] == 1
    assert status["last_result"]["turns_processed"] == 2

    monkeypatch.setattr(
        abkb_background,
        "run_judge_once",
        MagicMock(side_effect=ValueError("judge failed")),
    )
    abkb_background._run_background_judge("turn", 1)
    status = abkb_background.background_judge_status()
    assert status["error_count"] == 1
    assert status["last_error"] == "ValueError"

    monkeypatch.setenv("ABKB_BACKGROUND_JUDGE_MIN_INTERVAL_SECONDS", "5")
    abkb_background._last_finished_monotonic = 10
    monkeypatch.setattr(abkb_background.time, "monotonic", lambda: 12)
    sleeper = MagicMock()
    monkeypatch.setattr(abkb_background.time, "sleep", sleeper)
    abkb_background._sleep_until_cadence_allows_run()
    sleeper.assert_called_once_with(3.0)


def test_background_worker_drains_follow_up_and_result_shapes(monkeypatch) -> None:
    calls: list[tuple[str, int]] = []

    def run(reason: str, count: int) -> None:
        calls.append((reason, count))
        if len(calls) == 1:
            abkb_background._pending_reason = "follow-up"
            abkb_background._pending_requests = 2

    abkb_background._scheduled = True
    abkb_background._pending_reason = "first"
    abkb_background._pending_requests = 1
    monkeypatch.setattr(abkb_background, "_sleep_until_cadence_allows_run", lambda: None)
    monkeypatch.setattr(abkb_background, "_run_background_judge", run)
    abkb_background._judge_worker()
    assert calls == [("first", 1), ("follow-up", 2)]
    assert abkb_background._scheduled is False

    @dataclass
    class Result:
        turns_processed: int

    assert abkb_background._result_payload(Result(3)) == {"turns_processed": 3}
    assert abkb_background._result_payload({"x": 1}) == {"x": 1}
    assert "source_id" in abkb_background._result_payload(SimpleNamespace(source_id="s"))
    assert abkb_background._env_bool("MISSING_BOOL", True) is True
    monkeypatch.setenv("BAD_INTERVAL", "unused")
    monkeypatch.setenv("ABKB_BACKGROUND_JUDGE_MIN_INTERVAL_SECONDS", "bad")
    assert abkb_background._min_interval_seconds() == abkb_background.DEFAULT_MIN_INTERVAL_SECONDS
    monkeypatch.setenv("ABKB_BACKGROUND_JUDGE_MIN_INTERVAL_SECONDS", "-2")
    assert abkb_background._min_interval_seconds() == 0.0

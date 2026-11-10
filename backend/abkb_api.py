from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from typing import Any

import abkb
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from abkb_background import background_judge_status, run_judge_once
from abkb_runtime import (
    WORKFLOW_ID,
    db_path,
    policy_to_payload,
    report_to_payload,
    scope_id_to_storage,
    telemetry_path,
)


log = logging.getLogger("abkb_api")
router = APIRouter()


class SuggestionsRequest(BaseModel):
    sessionId: str | None = None
    workflow_id: str | None = None
    run_judge: bool = True


class AcceptPolicyRequest(BaseModel):
    policyId: str
    delete_all_pending: bool = True
    delete_policy_ids: list[int] = Field(default_factory=list)
    force_replace: bool = False


class PolicyPayload(BaseModel):
    workflow_id: str = WORKFLOW_ID
    policy: str
    scope_type: str = "global"
    scope_id: str | list[str] | None = None
    metadata: dict[str, Any] | None = None


class CustomPolicyRequest(BaseModel):
    payload: PolicyPayload
    activate_if_clean: bool = True
    force_replace: bool = False
    delete_policy_ids: list[int] = Field(default_factory=list)


class DiscardPolicyRequest(BaseModel):
    policyId: str


def _format_sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=True, default=str)}\n\n"


@router.get("/abkb/health")
def abkb_health() -> dict[str, Any]:
    return {
        "status": "ok",
        "workflow_id": WORKFLOW_ID,
        "db_path": str(db_path()),
        "telemetry_path": str(telemetry_path()),
        "background_judge": background_judge_status(),
    }


@router.get("/abkb/diagnostics")
def abkb_diagnostics() -> dict[str, Any]:
    try:
        return abkb.doctor(emit=False)
    except Exception as exc:
        log.exception("ABKB diagnostics failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/judge/suggestions")
def judge_suggestions(req: SuggestionsRequest) -> dict[str, Any]:
    workflow_id = req.workflow_id or WORKFLOW_ID
    run = None
    run_error = None
    if req.run_judge:
        run, run_error = _run_judge_safe()
    suggestions, suggestions_error = _suggestions_safe(workflow_id)
    return {
        "run": _run_payload(run),
        "run_error": run_error,
        "suggestions_error": suggestions_error,
        "suggestions": suggestions,
    }


@router.post("/judge/suggestions/stream")
def judge_suggestions_stream(req: SuggestionsRequest) -> StreamingResponse:
    workflow_id = req.workflow_id or WORKFLOW_ID

    def events() -> Iterator[str]:
        try:
            yield _format_sse(
                "start",
                {
                    "workflow_id": workflow_id,
                    "telemetry_path": str(telemetry_path()),
                    "db_path": str(db_path()),
                },
            )
            run = None
            run_error = None
            if req.run_judge:
                run, run_error = _run_judge_safe()
            yield _format_sse("judge.run", {"run": _run_payload(run), "error": run_error})
            suggestions, suggestions_error = _suggestions_safe(workflow_id)
            for suggestion in suggestions:
                yield _format_sse("suggestion", {"suggestion": suggestion})
            yield _format_sse(
                "done",
                {
                    "run": _run_payload(run),
                    "run_error": run_error,
                    "suggestions_error": suggestions_error,
                    "suggestion_count": len(suggestions),
                    "suggestions": suggestions,
                },
            )
        except Exception as exc:
            log.exception("ABKB suggestion stream failed")
            yield _format_sse("error", {"error": str(exc)})

    return StreamingResponse(events(), media_type="text/event-stream")


@router.get("/abkb/policies")
def list_policies(
    workflow_id: str = WORKFLOW_ID,
    status: str | None = None,
    scope: str | None = None,
    scope_id: str | None = None,
) -> dict[str, Any]:
    integrator = abkb.Integrator()
    policies = integrator.list_policies(
        workflow_id=workflow_id,
        status=status,
        scope=scope,
        scope_id=scope_id,
    )
    return {"policies": [policy_to_payload(p, origin="judge") for p in policies]}


@router.post("/abkb/accept")
def abkb_accept(req: AcceptPolicyRequest) -> dict[str, Any]:
    policy_id = _parse_policy_id(req.policyId)
    integrator = abkb.Integrator()
    try:
        report = integrator.check_policy(policy_id)
        candidate_policy = report.candidate

        if not _activation_confirmed(req):
            return _review_required_response(candidate_policy, report)

        policy = integrator.activate_candidate(
            policy_id,
            delete_policy_ids=req.delete_policy_ids or report.related_policy_ids,
            delete_all_pending=req.delete_all_pending,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "ok": True,
        "needs_review": False,
        "activated": True,
        "policy": policy_to_payload(policy, origin="judge"),
        "review": report_to_payload(report),
    }


@router.post("/abkb/custom")
def abkb_custom(req: CustomPolicyRequest) -> dict[str, Any]:
    payload = req.payload
    scope = payload.scope_type
    scope_id = scope_id_to_storage(payload.scope_id)
    if scope == "global":
        scope_id = None
    metadata = {
        "created_by": "extension.custom",
        "prompt_placement": "tail",
        **(payload.metadata or {}),
    }
    integrator = abkb.Integrator()

    try:
        # Custom user proposals must always pass through an explicit integrator
        # review before activation. The first request saves a pending candidate
        # and returns it to the UI. A follow-up accept request is required to
        # activate it or replace older active policies.
        report = integrator.propose_policy(
            workflow_id=payload.workflow_id or WORKFLOW_ID,
            scope=scope,
            scope_id=scope_id,
            policy=payload.policy,
            metadata=metadata,
        )
        return _review_required_response(report.candidate, report, origin="user")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/abkb/discard")
def abkb_discard(req: DiscardPolicyRequest) -> dict[str, Any]:
    policy_id = _parse_policy_id(req.policyId)
    try:
        abkb.Integrator().discard_candidate(policy_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "discarded_id": str(policy_id)}


def _run_judge() -> Any:
    return run_judge_once()


def _run_judge_safe() -> tuple[Any | None, str | None]:
    try:
        return _run_judge(), None
    except Exception as exc:
        log.exception("ABKB judge run failed; returning pending suggestions only")
        return None, str(exc)


def _review_required_response(
    candidate: Any,
    report: Any,
    *,
    origin: str = "judge",
) -> dict[str, Any]:
    return {
        "ok": False,
        "needs_review": True,
        "activated": False,
        "policy": _candidate_payload(candidate, origin=origin),
        "review": report_to_payload(report),
        "conflicting_policies": [
            policy_to_payload(policy, origin="judge")
            for policy in getattr(report, "compared_policies", [])
            if getattr(policy, "id", None) in set(getattr(report, "related_policy_ids", []))
        ],
    }


def _activation_confirmed(req: AcceptPolicyRequest) -> bool:
    return req.force_replace or bool(req.delete_policy_ids)


def _candidate_payload(candidate: Any, *, origin: str) -> dict[str, Any] | None:
    if candidate is None:
        return None
    if isinstance(candidate, dict):
        return candidate
    return policy_to_payload(candidate, origin=origin)


def _suggestions(workflow_id: str) -> list[dict[str, Any]]:
    pending = abkb.Integrator().list_pending_policies(workflow_id)
    return [_suggestion_from_policy(policy) for policy in pending]


def _suggestions_safe(workflow_id: str) -> tuple[list[dict[str, Any]], str | None]:
    try:
        return _suggestions(workflow_id), None
    except Exception as exc:
        log.exception("ABKB pending suggestion fetch failed")
        return [], str(exc)


def _suggestion_from_policy(policy: Any) -> dict[str, Any]:
    payload = policy_to_payload(policy, origin="judge")
    confidence = payload.get("metadata", {}).get("confidence")
    return {
        "id": str(policy.id),
        "title": _title_for_policy(policy),
        "description": (
            f"Pending ABKB policy candidate"
            + (f" (confidence {confidence})" if confidence is not None else "")
        ),
        "steps": [
            "Review the scoped policy.",
            "Activate it to apply to future agent prompts.",
        ],
        "policy_payload": payload,
    }


def _title_for_policy(policy: Any) -> str:
    text = " ".join(str(policy.policy).split())
    if len(text) <= 72:
        return text
    return text[:69].rstrip() + "..."


def _run_payload(run: Any) -> dict[str, Any] | None:
    if run is None:
        return None
    return {
        "source_id": run.source_id,
        "source_kind": run.source_kind,
        "turns_read": run.turns_read,
        "turns_processed": run.turns_processed,
        "skipped_turns": run.skipped_turns,
        "malformed_records": run.malformed_records,
        "candidates_added": run.candidates_added,
        "candidate_policy_ids": run.candidate_policy_ids,
    }


def _parse_policy_id(raw: str) -> int:
    text = str(raw or "").strip()
    if text.startswith("policy:"):
        text = text.split(":", 1)[1]
    try:
        return int(text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid policy id: {raw}") from exc

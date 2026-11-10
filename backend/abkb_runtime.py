from __future__ import annotations

import os
from pathlib import Path
from typing import Any


WORKFLOW_ID = os.environ.get("ABKB_WORKFLOW_ID", "vscode-codegraph-chatbot")
DEFAULT_INTEGRATOR_MODEL = "gpt-4o-mini"


def project_root() -> Path:
    return Path(os.environ.get("ABKB_PROJECT_ROOT") or Path.cwd()).resolve()


def abkb_dir() -> Path:
    configured_home = str(os.environ.get("ABKB_HOME") or "").strip()
    root = (
        Path(configured_home).expanduser()
        if configured_home
        else project_root() / ".abkb"
    )
    root.mkdir(parents=True, exist_ok=True)
    return root


def db_path() -> Path:
    return Path(os.environ.get("ABKB_DB_PATH") or abkb_dir() / "abkb.db")


def telemetry_path() -> Path:
    return Path(
        os.environ.get("ABKB_TELEMETRY_PATH")
        or abkb_dir() / "telemetry" / "agent_turns.jsonl"
    )


def judge_state_path() -> Path:
    return Path(
        os.environ.get("ABKB_JUDGE_STATE_PATH")
        or abkb_dir() / "telemetry" / "judge_state.json"
    )


def judge_trace_path() -> Path:
    return Path(
        os.environ.get("ABKB_JUDGE_TRACE_PATH")
        or abkb_dir() / "telemetry" / "judge_trace.jsonl"
    )


def policy_to_payload(policy: Any, *, origin: str = "judge") -> dict[str, Any]:
    return {
        "id": str(policy.id),
        "workflow_id": policy.workflow_id,
        "policy": policy.policy,
        "scope_type": policy.scope,
        **({"scope_id": policy.scope_id} if policy.scope_id is not None else {}),
        "metadata": policy.metadata or {},
        "origin": origin,
        "status": policy.status,
    }


def report_to_payload(report: Any) -> dict[str, Any]:
    payload = report.to_dict() if hasattr(report, "to_dict") else {}
    if isinstance(payload, dict):
        raw_response = str(getattr(report, "raw_response", "") or "")
        reviewer_error = str(getattr(report, "reviewer_error", "") or "")
        mode = "llm" if raw_response else "heuristic_fallback" if reviewer_error else "heuristic"
        payload["reviewer"] = {
            "mode": mode,
            "model": os.environ.get("ABKB_INTEGRATOR_MODEL", "") or DEFAULT_INTEGRATOR_MODEL,
        }
        if reviewer_error:
            payload["reviewer"]["error"] = reviewer_error
    return payload


def scope_id_to_storage(scope_id: Any) -> str | None:
    if scope_id is None:
        return None
    if isinstance(scope_id, list):
        values = [str(item).strip() for item in scope_id if str(item).strip()]
        return ", ".join(values) if values else None
    text = str(scope_id).strip()
    return text or None

"""Background ABKB judge scheduling for chat turns."""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any

import abkb


log = logging.getLogger("abkb_background")

DEFAULT_MIN_INTERVAL_SECONDS = 15.0

_lock = threading.Lock()
_scheduled = False
_running = False
_pending_reason = ""
_pending_requests = 0
_last_reason = ""
_last_started_monotonic = 0.0
_last_finished_monotonic = 0.0
_last_started_at = ""
_last_finished_at = ""
_last_result: dict[str, Any] | None = None
_last_error = ""
_run_count = 0
_error_count = 0


def run_judge_once() -> Any:
    """Run the ABKB judge once using the public outer API."""

    integrator = abkb.Integrator()
    return abkb.Judge(integrator).run_once()


def schedule_judge_run(reason: str = "chat_turn") -> bool:
    """Queue a non-blocking judge run.

    Multiple requests are coalesced into one background worker. If a run is
    active, one follow-up run is kept pending so turns written during the active
    run are still evaluated.
    """

    if not _env_bool("ABKB_BACKGROUND_JUDGE_ENABLED", False):
        return False

    should_start = False
    normalized_reason = str(reason or "scheduled")
    with _lock:
        global _scheduled, _pending_reason, _pending_requests
        _pending_reason = normalized_reason
        _pending_requests += 1
        if not _scheduled:
            _scheduled = True
            should_start = True

    if not should_start:
        return True

    try:
        thread = threading.Thread(
            target=_judge_worker,
            name="abkb-background-judge",
            daemon=True,
        )
        thread.start()
        return True
    except Exception:
        with _lock:
            _scheduled = False
        log.exception("Failed to start ABKB background judge worker")
        return False


def background_judge_status() -> dict[str, Any]:
    with _lock:
        return {
            "enabled": _env_bool("ABKB_BACKGROUND_JUDGE_ENABLED", False),
            "scheduled": _scheduled,
            "running": _running,
            "pending_requests": _pending_requests,
            "min_interval_seconds": _min_interval_seconds(),
            "last_reason": _last_reason,
            "last_started_at": _last_started_at,
            "last_finished_at": _last_finished_at,
            "last_result": _last_result,
            "last_error": _last_error,
            "run_count": _run_count,
            "error_count": _error_count,
        }


def _judge_worker() -> None:
    global _scheduled
    while True:
        _sleep_until_cadence_allows_run()
        with _lock:
            global _pending_reason, _pending_requests
            reason = _pending_reason or "scheduled"
            request_count = _pending_requests
            _pending_reason = ""
            _pending_requests = 0

        _run_background_judge(reason, request_count)

        with _lock:
            if _pending_reason:
                continue
            _scheduled = False
            return


def _sleep_until_cadence_allows_run() -> None:
    with _lock:
        last_finished = _last_finished_monotonic
    if last_finished <= 0:
        return
    delay = max(0.0, _min_interval_seconds() - (time.monotonic() - last_finished))
    if delay > 0:
        time.sleep(delay)


def _run_background_judge(reason: str, request_count: int) -> None:
    _mark_started(reason)
    try:
        result = run_judge_once()
        payload = _result_payload(result)
        _mark_finished(payload, "")
        log.info(
            "abkb_background_judge_complete",
            extra={
                "reason": reason,
                "request_count": request_count,
                "turns_processed": payload.get("turns_processed", 0),
                "candidates_added": payload.get("candidates_added", 0),
                "outcome": "ok",
            },
        )
    except Exception as exc:
        _mark_finished(None, exc.__class__.__name__)
        log.exception(
            "ABKB background judge failed",
            extra={
                "reason": reason,
                "request_count": request_count,
                "outcome": "failed",
            },
        )


def _mark_started(reason: str) -> None:
    with _lock:
        global _running, _last_reason, _last_started_monotonic, _last_started_at
        _running = True
        _last_reason = reason
        _last_started_monotonic = time.monotonic()
        _last_started_at = _utc_now()


def _mark_finished(result: dict[str, Any] | None, error: str) -> None:
    with _lock:
        global _running, _last_finished_monotonic, _last_finished_at
        global _last_result, _last_error, _run_count, _error_count
        _running = False
        _last_finished_monotonic = time.monotonic()
        _last_finished_at = _utc_now()
        _last_result = result
        _last_error = error
        if error:
            _error_count += 1
        else:
            _run_count += 1


def _result_payload(result: Any) -> dict[str, Any]:
    try:
        return asdict(result)
    except TypeError:
        pass
    if isinstance(result, dict):
        return dict(result)
    return {
        key: getattr(result, key, None)
        for key in (
            "source_id",
            "source_kind",
            "turns_read",
            "turns_processed",
            "skipped_turns",
            "malformed_records",
            "candidates_added",
            "candidate_policy_ids",
        )
    }


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return str(raw).strip().lower() not in {"0", "false", "no", "off"}


def _min_interval_seconds() -> float:
    raw = os.environ.get("ABKB_BACKGROUND_JUDGE_MIN_INTERVAL_SECONDS")
    if not raw:
        return DEFAULT_MIN_INTERVAL_SECONDS
    try:
        return max(0.0, float(raw))
    except ValueError:
        return DEFAULT_MIN_INTERVAL_SECONDS


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _reset_for_tests() -> None:
    with _lock:
        global _scheduled, _running, _pending_reason, _pending_requests
        global _last_reason, _last_started_monotonic, _last_finished_monotonic
        global _last_started_at, _last_finished_at, _last_result, _last_error
        global _run_count, _error_count
        _scheduled = False
        _running = False
        _pending_reason = ""
        _pending_requests = 0
        _last_reason = ""
        _last_started_monotonic = 0.0
        _last_finished_monotonic = 0.0
        _last_started_at = ""
        _last_finished_at = ""
        _last_result = None
        _last_error = ""
        _run_count = 0
        _error_count = 0

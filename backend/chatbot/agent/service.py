"""Agent service boundary used by the API layer."""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import Counter
from collections.abc import Iterator
from datetime import datetime, timezone
from typing import Any

import abkb

from abkb_background import schedule_judge_run
from abkb_runtime import telemetry_path
from chatbot.agent.composer import ComposerClient
from chatbot.agent.fast_path import FastPathComposer
from chatbot.agent.graph import build_graph_runner
from chatbot.agent.planner import (
    codegraph_query_for_request,
    is_project_overview_request,
    requires_codegraph,
    retrieval_profile_for_request,
)
from chatbot.agent.state import (
    AgentResult,
    AgentState,
    AgentStreamEvent,
    TriageDecision,
    record_telemetry_event,
)
from chatbot.agent.triage import TriageEngine
from chatbot.config.settings import Settings, load_settings
from chatbot.history.protocol import ChatHistoryClient
from chatbot.history.redaction import redact_text
from chatbot.worker.summarizer import SummaryRefreshQueue


logger = logging.getLogger(__name__)
_TELEMETRY_FILE_LOCK = threading.Lock()


FULL_PATH_AGENT_ID = "agent-primary"
FULL_PATH_NODE_ID = "chat"
FULL_PATH_TOOL_IDS = ("codegraph", "codegraph_project_inventory")
FULL_PATH_SUBAGENT_IDS = ("planner", "executor", "critic", "composer")
FULL_PATH_GRAPH_NODES = ("ingest", "planner", "executor", "critic", "composer")
FULL_PATH_COMPONENT_ROUTE = ("ingest", "planner", "executor", "critic", "composer", "final-answer")
FULL_PATH_COMPONENT_IDS = (
    FULL_PATH_AGENT_ID,
    *FULL_PATH_GRAPH_NODES,
    "final-answer",
    *FULL_PATH_TOOL_IDS,
)
FAST_PATH_GRAPH_NODES = ("fast_path",)
FAST_PATH_COMPONENT_ROUTE = ("fast_path", "final-answer")
FAST_PATH_COMPONENT_IDS = ("fast_path", "final-answer")

FULL_PATH_COMPONENT_DEFINITIONS = (
    {
        "component_id": "orchestrator",
        "agent_id": FULL_PATH_AGENT_ID,
        "kind": "orchestrator",
        "description": "Coordinates the full codebase chatbot graph.",
    },
    {
        "component_id": "planner",
        "agent_id": "planner",
        "kind": "planner",
        "description": "Builds bounded task plans and chooses retrieval actions.",
    },
    {
        "component_id": "executor",
        "agent_id": "executor",
        "kind": "tool-agent",
        "description": "Executes plan steps, CodeGraph retrieval, inventory, and reasoning artifacts.",
    },
    {
        "component_id": "critic",
        "agent_id": "critic",
        "kind": "critic",
        "description": "Checks whether execution evidence is sufficient before final composition.",
    },
    {
        "component_id": "composer",
        "agent_id": "composer",
        "kind": "composer",
        "description": "Drafts the final answer from history, plan, artifacts, and critique.",
    },
    {
        "component_id": "final-answer",
        "agent_id": "composer",
        "kind": "final-answer",
        "description": "Customer-facing final answer writer.",
    },
)
FAST_PATH_COMPONENT_DEFINITIONS = (
    {
        "component_id": "fast_path",
        "agent_id": "fast_path",
        "kind": "final-answer",
        "description": "Answers smalltalk, meta, clarification, and cache-hit turns without the full graph.",
    },
    {
        "component_id": "final-answer",
        "agent_id": "fast_path",
        "kind": "final-answer",
        "description": "Customer-facing fast-path answer writer.",
    },
)


class AgentService:
    """Coordinates one chat turn without exposing internals to FastAPI."""

    def __init__(
        self,
        history_client: ChatHistoryClient,
        settings: Settings | None = None,
        summarizer: SummaryRefreshQueue | None = None,
    ) -> None:
        # All agent dependencies are composed here, keeping FastAPI unaware of
        # triage rules, prompt strategy, and full-path orchestration internals.
        self._settings = settings or load_settings()
        self._history = history_client
        self._triage = TriageEngine(history_client=history_client)
        self._fast_path = FastPathComposer(settings=self._settings)
        self._graph = build_graph_runner(history_client=history_client)
        self._summarizer = summarizer or SummaryRefreshQueue(
            history_client=history_client,
            settings=self._settings,
        )
        self._turn_counts: Counter[tuple[str, str]] = Counter()

    def handle_chat(self, user_id: str, session_id: str, text: str) -> AgentResult:
        started = time.perf_counter()
        try:
            # Every turn starts with triage. The decision is the single gate between
            # the cheap fast path and the full graph path.
            decision = self._triage.decide(user_id, session_id, text)
            logger.info(
                "triage_decision",
                extra={
                    "user_id": user_id,
                    "session_id": session_id,
                    "path": decision.path,
                    "triage_class": decision.triage_class,
                },
            )

            if decision.path == "fast":
                answer = self._fast_path.compose(text, decision)
                # Fast-path turns still persist minimal history so cache-hit and
                # follow-up behavior have context even without the full graph.
                self._append_fast_path_turns(user_id, session_id, text, answer, decision)
                self._maybe_enqueue_summary(user_id, session_id)
                telemetry = _fast_path_turn_telemetry(
                    text,
                    answer,
                    decision,
                    settings=self._settings,
                )
                _log_turn_if_enabled(
                    user_input=text,
                    final_output=answer,
                    agent_id="fast_path",
                    node_id="fast_path",
                    tool_ids=(),
                    subagent_ids=("fast_path",),
                    target_model=self._settings.llm_model,
                    session_id=session_id,
                    latency_ms=_elapsed_ms(started),
                    observability=telemetry["observability"],
                    quality_signals=telemetry["quality_signals"],
                    turn_metrics=telemetry["turn_metrics"],
                    extra={"user_id": user_id, **telemetry["extra"]},
                    sync_policies=True,
                )
                _schedule_judge_if_enabled(reason="chat_turn")
                return AgentResult(
                    answer=answer,
                    path=decision.path,
                    triage_class=decision.triage_class,
                )

            # Full-path state is explicit and typed. Phase A can swap the current
            # runner implementation for a compiled LangGraph without changing API.
            state = AgentState(
                user_id=user_id,
                session_id=session_id,
                user_text=text,
                triage_class=decision.triage_class,
                path=decision.path,
            )
            state = self._graph.run(state)
            self._maybe_enqueue_summary(user_id, session_id)
            telemetry = _full_path_turn_telemetry(
                state,
                decision,
                settings=self._settings,
            )
            _log_turn_if_enabled(
                user_input=state.user_text,
                final_output=state.response_md or "",
                agent_id=FULL_PATH_AGENT_ID,
                node_id=FULL_PATH_NODE_ID,
                tool_ids=FULL_PATH_TOOL_IDS,
                subagent_ids=FULL_PATH_SUBAGENT_IDS,
                target_model=self._settings.llm_model,
                session_id=session_id,
                latency_ms=_elapsed_ms(started),
                error="; ".join(state.errors),
                observability=telemetry["observability"],
                quality_signals=telemetry["quality_signals"],
                turn_metrics=telemetry["turn_metrics"],
                extra={"user_id": user_id, **telemetry["extra"]},
                sync_policies=True,
            )
            _schedule_judge_if_enabled(reason="chat_turn")
            return AgentResult(
                answer=state.response_md or "",
                path="full",
                triage_class=decision.triage_class,
            )
        except Exception as exc:
            _append_error_turn_telemetry(user_id, session_id, text, started, exc)
            raise

    def stream_chat(
        self, user_id: str, session_id: str, text: str
    ) -> Iterator[AgentStreamEvent]:
        started = time.perf_counter()
        try:
            yield AgentStreamEvent(
                event="start",
                data={
                    "status": "accepted",
                    "message": "Chat turn accepted; generating answer.",
                },
            )
            decision = self._triage.decide(user_id, session_id, text)
            logger.info(
                "triage_decision",
                extra={
                    "user_id": user_id,
                    "session_id": session_id,
                    "path": decision.path,
                    "triage_class": decision.triage_class,
                },
            )
            yield AgentStreamEvent(
                data={"path": decision.path, "triage_class": decision.triage_class},
                event="status",
            )

            if decision.path == "fast":
                answer_parts: list[str] = []
                for chunk in self._fast_path.stream(text, decision):
                    answer_parts.append(chunk)
                    yield AgentStreamEvent(event="chunk", data={"text": chunk})
                answer = "".join(answer_parts).strip() or self._fast_path.compose(
                    text, decision
                )
                self._append_fast_path_turns(user_id, session_id, text, answer, decision)
                self._maybe_enqueue_summary(user_id, session_id)
                telemetry = _fast_path_turn_telemetry(
                    text,
                    answer,
                    decision,
                    settings=self._settings,
                )
                _log_turn_if_enabled(
                    user_input=text,
                    final_output=answer,
                    agent_id="fast_path",
                    node_id="fast_path",
                    tool_ids=(),
                    subagent_ids=("fast_path",),
                    target_model=self._settings.llm_model,
                    session_id=session_id,
                    latency_ms=_elapsed_ms(started),
                    observability=telemetry["observability"],
                    quality_signals=telemetry["quality_signals"],
                    turn_metrics=telemetry["turn_metrics"],
                    extra={"user_id": user_id, **telemetry["extra"]},
                    sync_policies=True,
                )
                _schedule_judge_if_enabled(reason="chat_turn")
                yield AgentStreamEvent(
                    event="done",
                    data={"path": decision.path, "triage_class": decision.triage_class},
                )
                return

            state = AgentState(
                user_id=user_id,
                session_id=session_id,
                user_text=text,
                triage_class=decision.triage_class,
                path=decision.path,
            )
            state = self._graph.run_until_compose(state)
            composer = ComposerClient(settings=self._settings)
            answer_parts = []
            for chunk in composer.stream(state):
                answer_parts.append(chunk)
                yield AgentStreamEvent(event="chunk", data={"text": chunk})
            state.response_md = "".join(answer_parts).strip() or ComposerClient(
                settings=self._settings
            ).compose(state)
            state.done = True
            record_telemetry_event(
                state,
                kind="graph_node",
                node_id="composer",
                message="Composer streamed final assistant response.",
                component="composer",
                output_chars=len(state.response_md or ""),
                artifact_count=len(state.scratchpad),
                outcome="ok",
            )
            self._history.append_turn(
                user_id,
                session_id,
                "assistant",
                state.response_md,
                metadata={
                    "path": state.path,
                    "triage_class": state.triage_class,
                    "done": state.done,
                    "artifact_count": len(state.scratchpad),
                },
            )
            self._maybe_enqueue_summary(user_id, session_id)
            telemetry = _full_path_turn_telemetry(
                state,
                decision,
                settings=self._settings,
            )
            _log_turn_if_enabled(
                user_input=state.user_text,
                final_output=state.response_md,
                agent_id=FULL_PATH_AGENT_ID,
                node_id=FULL_PATH_NODE_ID,
                tool_ids=FULL_PATH_TOOL_IDS,
                subagent_ids=FULL_PATH_SUBAGENT_IDS,
                target_model=self._settings.llm_model,
                session_id=session_id,
                latency_ms=_elapsed_ms(started),
                error="; ".join(state.errors),
                observability=telemetry["observability"],
                quality_signals=telemetry["quality_signals"],
                turn_metrics=telemetry["turn_metrics"],
                extra={"user_id": user_id, **telemetry["extra"]},
                sync_policies=True,
            )
            _schedule_judge_if_enabled(reason="chat_turn")
            yield AgentStreamEvent(
                event="done",
                data={"path": "full", "triage_class": decision.triage_class},
            )
        except Exception as exc:
            _append_error_turn_telemetry(user_id, session_id, text, started, exc)
            raise

    def _maybe_enqueue_summary(self, user_id: str, session_id: str) -> None:
        if not self._settings.summarizer_enabled:
            return
        cadence = max(1, self._settings.summarizer_every_turns)
        key = (user_id, session_id)
        self._turn_counts[key] += 1
        if self._turn_counts[key] % cadence != 0:
            return
        try:
            self._summarizer.enqueue_summary_refresh(user_id, session_id)
        except Exception as exc:
            logger.warning(
                "summarizer_enqueue_failed",
                extra={
                    "user_id": user_id,
                    "session_id": session_id,
                    "phase": "summarizer",
                    "detail": exc.__class__.__name__,
                    "outcome": "failed",
                },
            )

    def _append_fast_path_turns(
        self,
        user_id: str,
        session_id: str,
        text: str,
        answer: str,
        decision: TriageDecision,
    ) -> None:
        self._history.append_turn(
            user_id,
            session_id,
            "user",
            text,
            metadata={"path": decision.path, "triage_class": decision.triage_class},
        )
        self._history.append_turn(
            user_id,
            session_id,
            "assistant",
            answer,
            metadata={"path": decision.path, "triage_class": decision.triage_class},
        )


def _elapsed_ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


def _env_enabled(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _redact_telemetry_value(value: Any) -> Any:
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, dict):
        return {str(key): _redact_telemetry_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact_telemetry_value(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_redact_telemetry_value(item) for item in value)
    return value


def _log_turn_if_enabled(**kwargs: Any) -> None:
    if not _env_enabled("ABKB_TELEMETRY_ENABLED", True):
        return
    abkb.log_turn(**_redact_telemetry_value(kwargs))
    _enforce_local_telemetry_retention()


def _schedule_judge_if_enabled(reason: str) -> None:
    if not _env_enabled("ABKB_TELEMETRY_ENABLED", True):
        return
    if not _env_enabled("ABKB_BACKGROUND_JUDGE_ENABLED", False):
        return
    schedule_judge_run(reason=reason)


def _enforce_local_telemetry_retention() -> None:
    max_bytes = max(64_000, int(os.environ.get("ABKB_TELEMETRY_MAX_BYTES", "5242880")))
    max_turns = max(10, int(os.environ.get("ABKB_TELEMETRY_MAX_TURNS", "1000")))
    path = telemetry_path()
    try:
        if not path.exists() or path.stat().st_size <= max_bytes:
            return
        with _TELEMETRY_FILE_LOCK:
            lines = path.read_text(encoding="utf-8").splitlines()
            retained = lines[-max_turns:]
            temporary = path.with_suffix(path.suffix + ".tmp")
            temporary.write_text("\n".join(retained) + ("\n" if retained else ""), encoding="utf-8")
            temporary.replace(path)
    except (OSError, ValueError):
        logger.warning("telemetry_retention_failed", extra={"outcome": "ignored"})


def _fast_path_turn_telemetry(
    user_text: str,
    answer: str,
    decision: TriageDecision,
    *,
    settings: Settings,
) -> dict[str, Any]:
    events = _fast_path_events(user_text, answer, decision)
    intent_signals = _intent_signals(user_text, None)
    quality_signals = {
        "path": decision.path,
        "triage_class": decision.triage_class,
        "triage_reason": decision.reason,
        "graph_mode": "fast_path",
        "has_final_output": bool(answer.strip()),
        "final_output_chars": len(answer),
        "asked_clarifying_question": _asked_clarifying_question(answer),
        "requires_codegraph": intent_signals["requires_codegraph"],
        "is_project_overview": intent_signals["is_project_overview"],
        "used_codegraph": False,
        "used_project_inventory": False,
        "has_errors": False,
        "tool_calls_count": 0,
        "tool_call_names": [],
        "subagent_calls_count": 1,
        "subagent_call_names": ["fast_path"],
    }
    observability = {
        "graph_mode": "fast_path",
        "event_trace": events,
        "graph_trace": _graph_trace(events),
        "decision_events": [
            {
                "type": "triage",
                "decision": decision.path,
                "reason_summary": decision.reason,
                "status": decision.triage_class,
            },
            {
                "type": "final_answer",
                "decision": "fast_path_answer",
                "reason_summary": "Fast path produced the customer-facing response.",
                "status": "ok" if answer.strip() else "empty",
            },
        ],
        "tool_events": [],
        "errors": [],
        "intent_signals": intent_signals,
        "reasoning_summary": (
            f"Fast path handled triage_class={decision.triage_class} "
            f"because {decision.reason}."
        ),
    }
    return {
        "observability": observability,
        "quality_signals": quality_signals,
        "turn_metrics": _turn_metrics(
            final_output=answer,
            has_errors=False,
            tool_calls_count=0,
            subagent_calls_count=1,
            node_metrics={},
        ),
        "extra": {
            "path": decision.path,
            "graph_mode": "fast_path",
            "graph_nodes": list(FAST_PATH_GRAPH_NODES),
            "component_ids": list(FAST_PATH_COMPONENT_IDS),
            "component_route": list(FAST_PATH_COMPONENT_ROUTE),
            "component_definitions": list(FAST_PATH_COMPONENT_DEFINITIONS),
            "runtime_context": _runtime_context(settings),
            "intent_signals": intent_signals,
            "message_trace": _message_trace_from_events(events),
            "subagent_call_names": ["fast_path"],
            "subagent_calls_count": 1,
            "tool_call_names": [],
            "tool_call_unique_names": [],
            "tool_calls_count": 0,
            "tool_events": [],
            "token_usage": {"prompt": 0, "completion": 0, "total": 0},
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
    }


def _full_path_turn_telemetry(
    state: AgentState,
    decision: TriageDecision,
    *,
    settings: Settings,
) -> dict[str, Any]:
    events = state.telemetry_events
    graph_trace = _graph_trace(events)
    tool_events = _tool_events(events)
    subagent_events = _subagent_events(events)
    tool_call_names = _event_names(tool_events, "tool_id")
    subagent_call_names = _event_names(subagent_events, "subagent_id")
    intent_signals = _intent_signals(state.user_text, state.window)
    plan_steps = [step.model_dump() for step in (state.plan.steps if state.plan is not None else [])]
    artifacts = [artifact.model_dump() for artifact in state.scratchpad]
    action_counts = Counter(step["action"] for step in plan_steps if step.get("action"))
    error_events = _error_events(state, tool_events)
    token_total = _token_total(events)
    quality_signals = {
        "path": "full",
        "triage_class": decision.triage_class,
        "triage_reason": decision.reason,
        "graph_mode": "langgraph",
        "has_final_output": bool(str(state.response_md or "").strip()),
        "final_output_chars": len(state.response_md or ""),
        "has_errors": bool(state.errors or error_events),
        "error_count": len(state.errors),
        "tool_error_count": sum(1 for event in tool_events if str(event.get("status")) == "error" or event.get("error")),
        "tool_calls_count": len(tool_events),
        "tool_call_names": tool_call_names,
        "subagent_calls_count": len(subagent_events),
        "subagent_call_names": subagent_call_names,
        "plan_step_count": len(plan_steps),
        "plan_actions": list(action_counts.keys()),
        "plan_action_counts": dict(action_counts),
        "artifact_count": len(state.scratchpad),
        "artifact_error_count": sum(1 for artifact in state.scratchpad if artifact.error),
        "used_codegraph": any(name.startswith("codegraph") for name in tool_call_names),
        "used_project_inventory": any("project_inventory" in name for name in tool_call_names)
        or any(step.get("action") == "query_project_inventory" for step in plan_steps),
        "requires_codegraph": intent_signals["requires_codegraph"],
        "is_project_overview": intent_signals["is_project_overview"],
        "retrieval_profile": intent_signals["retrieval_profile"],
        "asked_clarifying_question": _asked_clarifying_question(state.response_md or "")
        or any(step.get("action") == "ask_clarification" for step in plan_steps),
        "terminal_action": _terminal_action(plan_steps),
        "critique_complete": state.critique_complete,
        "critique_confidence": state.critique_confidence,
        "critique_missing": state.critique_missing,
        "iteration_count": state.iteration_count,
        "max_iterations": state.max_iterations,
        "planner_parse_outcome": (state.plan.metadata.get("parse_outcome") if state.plan is not None else ""),
        "codegraph_guard_applied": bool(state.plan and state.plan.metadata.get("codegraph_guard_applied")),
        "project_inventory_guard_applied": bool(
            state.plan and state.plan.metadata.get("project_inventory_guard_applied")
        ),
    }
    observability = {
        "graph_mode": "langgraph",
        "event_trace": events,
        "graph_trace": graph_trace,
        "decision_events": _decision_events(state, decision, quality_signals),
        "tool_events": tool_events,
        "errors": error_events,
        "plan_steps": plan_steps,
        "artifacts": artifacts,
        "critique": {
            "complete": state.critique_complete,
            "confidence": state.critique_confidence,
            "missing": state.critique_missing,
        },
        "component_route": list(FULL_PATH_COMPONENT_ROUTE),
        "component_definitions": list(FULL_PATH_COMPONENT_DEFINITIONS),
        "intent_signals": intent_signals,
        "reasoning_summary": _reasoning_summary(state, quality_signals),
    }
    return {
        "observability": observability,
        "quality_signals": quality_signals,
        "turn_metrics": _turn_metrics(
            final_output=state.response_md or "",
            has_errors=quality_signals["has_errors"],
            tool_calls_count=len(tool_events),
            subagent_calls_count=len(subagent_events),
            node_metrics=state.metrics,
        ),
        "extra": {
            "path": "full",
            "graph_mode": "langgraph",
            "graph_nodes": list(FULL_PATH_GRAPH_NODES),
            "component_ids": list(FULL_PATH_COMPONENT_IDS),
            "component_route": list(FULL_PATH_COMPONENT_ROUTE),
            "component_definitions": list(FULL_PATH_COMPONENT_DEFINITIONS),
            "runtime_context": _runtime_context(settings),
            "tool_definitions": _tool_definitions(),
            "intent_signals": intent_signals,
            "message_trace": _message_trace_from_events(events),
            "tool_events": tool_events,
            "tool_call_names": tool_call_names,
            "tool_call_unique_names": sorted(set(tool_call_names)),
            "tool_calls_count": len(tool_events),
            "subagent_call_names": subagent_call_names,
            "subagent_calls_count": len(subagent_events),
            "token_usage": {"prompt": 0, "completion": 0, "total": token_total},
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": token_total,
        },
    }


def _fast_path_events(
    user_text: str,
    answer: str,
    decision: TriageDecision,
) -> list[dict[str, object]]:
    now = datetime.now(timezone.utc).isoformat()
    return [
        {
            "timestamp": now,
            "kind": "subagent_call",
            "node_id": "fast_path",
            "subagent_id": "fast_path",
            "message": "Fast-path composer handled the turn.",
            "prompt_name": "fast_path",
            "input_preview": user_text,
            "output_preview": answer,
            "triage_class": decision.triage_class,
            "triage_reason": decision.reason,
            "status": "success",
        },
        {
            "timestamp": now,
            "kind": "graph_node",
            "node_id": "fast_path",
            "component": "fast_path",
            "message": "Fast path produced final response.",
            "output_chars": len(answer),
            "outcome": "ok",
        },
    ]


def _intent_signals(user_text: str, window: Any | None) -> dict[str, Any]:
    text = str(user_text or "")
    query = codegraph_query_for_request(text, window=window)
    overview = is_project_overview_request(text)
    requires_retrieval = requires_codegraph(text) or query is not None or overview
    contextual_markers = (
        "how am i",
        "what am i",
        "what have i",
        "what did i",
        "my task",
        "my tasks",
        "my project",
        "my code",
        "my repo",
        "this repo",
    )
    lowered = text.lower()
    return {
        "normalized_user_input": " ".join(text.strip().split()),
        "requires_codegraph": requires_retrieval,
        "codegraph_query": query or "",
        "is_project_overview": overview,
        "retrieval_profile": retrieval_profile_for_request(text) if requires_retrieval and not overview else "",
        "contextual_personal_or_project_request": any(marker in lowered for marker in contextual_markers),
        "mentions_code_symbol": any(char in text for char in ("_", "(", ")")),
        "question_like": "?" in text
        or any(lowered.startswith(prefix) for prefix in ("how ", "what ", "where ", "why ", "which ")),
    }


def _graph_trace(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    trace = []
    for event in events:
        if event.get("kind") != "graph_node":
            continue
        node_id = str(event.get("node_id") or "")
        trace.append(
            {
                "node": node_id,
                "node_id": node_id,
                "component": event.get("component") or node_id,
                "message": event.get("message", ""),
                "outcome": event.get("outcome") or event.get("status") or "",
                "error": event.get("error", ""),
                "timestamp": event.get("timestamp", ""),
            }
        )
    return trace


def _tool_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "category": event.get("category") or "tool",
            "tool_id": event.get("tool_id") or event.get("tool") or "",
            "tool_call_id": event.get("tool_call_id") or event.get("step_id") or "",
            "node_id": event.get("node_id") or "",
            "status": event.get("status") or "",
            "input_preview": event.get("input_preview") or "",
            "output_preview": event.get("output_preview") or "",
            "error": event.get("error") or "",
            "truncated": bool(event.get("truncated")),
            "available": event.get("available"),
            "metadata": event.get("metadata") if isinstance(event.get("metadata"), dict) else {},
        }
        for event in events
        if event.get("kind") == "tool_call"
    ]


def _subagent_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        event
        for event in events
        if event.get("kind") == "subagent_call" and event.get("subagent_id")
    ]


def _event_names(events: list[dict[str, Any]], key: str) -> list[str]:
    names = []
    for event in events:
        name = str(event.get(key) or "").strip()
        if name:
            names.append(name)
    return names


def _message_trace_from_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    trace = []
    for event in events:
        if event.get("kind") not in {"subagent_call", "tool_call"}:
            continue
        name = str(event.get("subagent_id") or event.get("tool_id") or event.get("node_id") or "event")
        content = "\n".join(
            part
            for part in (
                str(event.get("message") or ""),
                f"input: {event.get('input_preview')}" if event.get("input_preview") else "",
                f"output: {event.get('output_preview')}" if event.get("output_preview") else "",
                f"error: {event.get('error')}" if event.get("error") else "",
            )
            if part
        )
        trace.append(
            {
                "role": "tool" if event.get("kind") == "tool_call" else "assistant",
                "name": name,
                "content_preview": content,
                "status": event.get("status") or event.get("outcome") or "",
            }
        )
    return trace[-16:]


def _error_events(state: AgentState, tool_events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    errors = [
        {
            "source": "agent",
            "message": error,
        }
        for error in state.errors
    ]
    errors.extend(
        {
            "source": "tool",
            "tool_id": event.get("tool_id") or "",
            "message": event.get("error") or str(event.get("status") or ""),
        }
        for event in tool_events
        if event.get("error") or str(event.get("status") or "").lower() in {"error", "failed", "failure"}
    )
    return errors


def _token_total(events: list[dict[str, Any]]) -> int:
    total = 0
    for event in events:
        try:
            total += int(event.get("token_count") or 0)
        except (TypeError, ValueError):
            continue
    return total


def _terminal_action(plan_steps: list[dict[str, Any]]) -> str:
    for step in plan_steps:
        action = str(step.get("action") or "")
        if action in {"ask_clarification", "reject_unrelated"}:
            return action
    return ""


def _asked_clarifying_question(text: str) -> bool:
    lowered = str(text or "").lower()
    return "?" in lowered and any(
        marker in lowered
        for marker in (
            "could you",
            "can you",
            "what",
            "which",
            "please provide",
            "clarify",
            "do you want",
        )
    )


def _decision_events(
    state: AgentState,
    decision: TriageDecision,
    quality_signals: dict[str, Any],
) -> list[dict[str, Any]]:
    actions = quality_signals.get("plan_actions") or []
    return [
        {
            "type": "triage",
            "decision": decision.path,
            "reason_summary": decision.reason,
            "status": decision.triage_class,
        },
        {
            "type": "planning",
            "decision": ", ".join(actions) if actions else "no_plan",
            "reason_summary": (
                "Planner selected retrieval/inventory actions before reasoning."
                if quality_signals.get("used_codegraph") or quality_signals.get("used_project_inventory")
                else "Planner did not select an external project evidence tool."
            ),
            "status": state.plan.metadata.get("parse_outcome") if state.plan is not None else "missing",
        },
        {
            "type": "critique",
            "decision": "complete" if state.critique_complete else "continue",
            "reason_summary": state.critique_missing or "Critic accepted available evidence.",
            "status": str(state.critique_confidence),
        },
        {
            "type": "final_answer",
            "decision": "answered" if quality_signals.get("has_final_output") else "empty",
            "reason_summary": "Composer produced the customer-facing response.",
            "status": "error" if quality_signals.get("has_errors") else "ok",
        },
    ]


def _reasoning_summary(state: AgentState, quality_signals: dict[str, Any]) -> str:
    actions = ", ".join(quality_signals.get("plan_actions") or [])
    parts = [
        f"Full LangGraph path handled triage_class={state.triage_class}.",
        f"Plan actions: {actions or 'none'}.",
        f"Artifacts: {quality_signals.get('artifact_count', 0)}.",
        f"Critique complete={state.critique_complete} confidence={state.critique_confidence}.",
    ]
    if quality_signals.get("used_codegraph"):
        parts.append("CodeGraph evidence was requested.")
    if quality_signals.get("used_project_inventory"):
        parts.append("Structural project inventory was requested.")
    if state.errors:
        parts.append(f"Errors: {'; '.join(state.errors)}.")
    return " ".join(parts)


def _turn_metrics(
    *,
    final_output: str,
    has_errors: bool,
    tool_calls_count: int,
    subagent_calls_count: int,
    node_metrics: dict[str, Any],
) -> dict[str, Any]:
    completed = bool(str(final_output or "").strip()) and not has_errors
    completion_score = 0.85 if completed else 0.35 if has_errors else 0.45
    return {
        "task_completion_rate": {
            "score": completion_score,
            "basis": "Chatbot proxy from final output presence and visible error signals.",
        },
        "behavioral_consistency": {
            "score": 0.55 if has_errors else 0.85,
            "basis": "Lower when the turn has visible agent/tool errors.",
        },
        "error_rate": {
            "score": 1.0 if has_errors else 0.0,
            "basis": "1.0 when state or tool telemetry contains an error.",
        },
        "user_satisfaction": {
            "score": 0.35 if has_errors else 0.7 if final_output else 0.45,
            "basis": "Proxy only; final output without errors is likely more satisfying.",
        },
        "debugging_time": {
            "score": tool_calls_count + subagent_calls_count,
            "basis": "Visible tool and subagent calls before final output.",
        },
        "node_metrics": node_metrics,
    }


def _runtime_context(settings: Settings) -> dict[str, Any]:
    return {
        "history_backend": settings.history_backend,
        "llm_provider": settings.llm_provider,
        "llm_model": settings.llm_model,
        "codegraph_enabled": settings.codegraph_enabled,
        "codegraph_database": settings.codegraph_database,
        "streaming_enabled": settings.chat_streaming_enabled,
        "planner_max_steps": settings.planner_max_steps,
        "executor_max_steps": settings.executor_max_steps,
        "critic_confidence_threshold": settings.critic_confidence_threshold,
    }


def _tool_definitions() -> list[dict[str, str]]:
    return [
        {
            "tool_id": "codegraph",
            "description": "Semantic CodeGraph retrieval for focused codebase questions.",
        },
        {
            "tool_id": "codegraph_project_inventory",
            "description": "Structural inventory for broad project overview questions.",
        },
    ]


def _append_error_turn_telemetry(
    user_id: str,
    session_id: str,
    text: str,
    started: float,
    exc: Exception,
) -> None:
    error = exc.__class__.__name__
    now = datetime.now(timezone.utc).isoformat()
    observability = {
        "graph_mode": "error",
        "event_trace": [
            {
                "timestamp": now,
                "kind": "graph_node",
                "node_id": "agent_error",
                "component": "orchestrator",
                "message": "Chat turn failed before a normal response was produced.",
                "status": "error",
                "error": error,
            }
        ],
        "graph_trace": [
            {
                "timestamp": now,
                "node": "agent_error",
                "node_id": "agent_error",
                "component": "orchestrator",
                "message": "Chat turn failed before a normal response was produced.",
                "outcome": "error",
                "error": error,
            }
        ],
        "decision_events": [
            {
                "type": "error",
                "decision": "failed",
                "reason_summary": "Exception interrupted the chat turn before normal completion.",
                "status": error,
            }
        ],
        "tool_events": [],
        "errors": [{"source": "agent", "message": error}],
        "intent_signals": _intent_signals(text, None),
        "reasoning_summary": f"Chat turn failed with {error}.",
    }
    try:
        _log_turn_if_enabled(
            user_input=text,
            final_output="",
            agent_id=FULL_PATH_AGENT_ID,
            node_id=FULL_PATH_NODE_ID,
            tool_ids=(),
            subagent_ids=(),
            target_model=os.environ.get("LLM_MODEL", ""),
            session_id=session_id,
            latency_ms=_elapsed_ms(started),
            error=error,
            observability=observability,
            quality_signals={
                "path": "error",
                "triage_class": "unknown",
                "graph_mode": "error",
                "has_final_output": False,
                "has_errors": True,
                "error_count": 1,
            },
            turn_metrics=_turn_metrics(
                final_output="",
                has_errors=True,
                tool_calls_count=0,
                subagent_calls_count=0,
                node_metrics={},
            ),
            extra={
                "user_id": user_id,
                "path": "error",
                "graph_mode": "error",
                "graph_nodes": ["agent_error"],
                "component_ids": [FULL_PATH_AGENT_ID, "agent_error"],
                "component_route": ["agent_error"],
                "component_definitions": [FULL_PATH_COMPONENT_DEFINITIONS[0]],
                "runtime_context": {"llm_model": os.environ.get("LLM_MODEL", "")},
                "intent_signals": observability["intent_signals"],
                "message_trace": [],
                "tool_events": [],
                "tool_call_names": [],
                "tool_call_unique_names": [],
                "tool_calls_count": 0,
                "subagent_call_names": [],
                "subagent_calls_count": 0,
                "token_usage": {"prompt": 0, "completion": 0, "total": 0},
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
            },
            sync_policies=True,
        )
        _schedule_judge_if_enabled(reason="chat_turn_error")
    except Exception as telemetry_exc:
        logger.warning(
            "turn_error_telemetry_failed",
            extra={
                "user_id": user_id,
                "session_id": session_id,
                "detail": telemetry_exc.__class__.__name__,
                "original_error": error,
                "outcome": "failed",
            },
        )

"""Ingest node for full-path requests."""

from __future__ import annotations

import logging

from chatbot.agent.state import AgentState, record_telemetry_event
from chatbot.history.protocol import ChatHistoryClient


logger = logging.getLogger(__name__)


def ingest_node(
    state: AgentState, history_client: ChatHistoryClient
) -> AgentState:
    # Normalize once at the full-path boundary so downstream planner/executor
    # nodes see a stable prompt and history stores the same canonical text.
    normalized_text = " ".join(state.user_text.strip().split())
    history_client.append_turn(
        state.user_id,
        state.session_id,
        "user",
        normalized_text,
        metadata={"path": state.path, "triage_class": state.triage_class},
    )
    state.user_text = normalized_text
    # The planner receives a bounded layered window, not direct access to the
    # full history store. Phase 0 only fills the verbatim portion.
    state.window = history_client.get_window(state.user_id, state.session_id)
    record_telemetry_event(
        state,
        kind="graph_node",
        node_id="ingest",
        message="Loaded bounded conversation window.",
        component="ingest",
        window_turn_count=len(state.window.verbatim),
        summary_present=state.window.summary is not None,
        pinned_fact_count=len(state.window.pinned_facts),
        outcome="ok",
    )
    logger.info(
        "agent_node_complete",
        extra={
            "phase": "ingest",
            "user_id": state.user_id,
            "session_id": state.session_id,
            "window_turn_count": len(state.window.verbatim),
            "summary_present": state.window.summary is not None,
            "pinned_fact_count": len(state.window.pinned_facts),
            "outcome": "ok",
        },
    )
    return state

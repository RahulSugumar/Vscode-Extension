"""Critique node for the LangGraph full path."""

from __future__ import annotations

import logging

from chatbot.agent.critic import CriticClient
from chatbot.agent.state import AgentState, record_telemetry_event


logger = logging.getLogger(__name__)


def critique_node(state: AgentState) -> AgentState:
    state = CriticClient().critique(state)
    record_telemetry_event(
        state,
        kind="graph_node",
        node_id="critic",
        message="Critic evaluated whether execution evidence is sufficient.",
        component="critic",
        complete=state.critique_complete,
        confidence=state.critique_confidence,
        missing=state.critique_missing,
        outcome="ok",
    )
    logger.info(
        "agent_node_complete",
        extra={
            "phase": "critique",
            "user_id": state.user_id,
            "session_id": state.session_id,
            "complete": state.critique_complete,
            "confidence": state.critique_confidence,
            "missing": state.critique_missing,
            "outcome": "ok",
        },
    )
    return state

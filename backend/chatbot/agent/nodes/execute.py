"""Executor node for the LangGraph full path."""

from __future__ import annotations

import logging

from chatbot.agent.executor import ExecutorClient
from chatbot.agent.state import AgentState, record_telemetry_event


logger = logging.getLogger(__name__)


def execute_node(state: AgentState) -> AgentState:
    before_count = len(state.scratchpad)
    state = ExecutorClient().execute(state)
    record_telemetry_event(
        state,
        kind="graph_node",
        node_id="executor",
        message="Executor completed one pass over ready plan steps.",
        component="executor",
        iteration_count=state.iteration_count,
        artifact_count=len(state.scratchpad),
        artifacts_added=len(state.scratchpad) - before_count,
        error_count=len(state.errors),
        outcome="ok",
    )
    logger.info(
        "agent_node_complete",
        extra={
            "phase": "execute",
            "user_id": state.user_id,
            "session_id": state.session_id,
            "iteration_count": state.iteration_count,
            "artifact_count": len(state.scratchpad),
            "error_count": len(state.errors),
            "outcome": "ok",
        },
    )
    return state

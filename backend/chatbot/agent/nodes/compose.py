"""Compose node for final full-path answers."""

from __future__ import annotations

import logging

from chatbot.agent.composer import ComposerClient
from chatbot.agent.state import AgentState, record_telemetry_event
from chatbot.history.protocol import ChatHistoryClient


logger = logging.getLogger(__name__)


def compose_node(
    state: AgentState, history_client: ChatHistoryClient
) -> AgentState:
    if state.response_md is None:
        state.response_md = ComposerClient().compose(state)

    state.done = True
    record_telemetry_event(
        state,
        kind="graph_node",
        node_id="composer",
        message="Composer produced final assistant response.",
        component="composer",
        output_chars=len(state.response_md or ""),
        artifact_count=len(state.scratchpad),
        outcome="ok",
    )
    # Assistant history is appended after the final answer is available, matching
    # the planned write path for the durable history client.
    history_client.append_turn(
        state.user_id,
        state.session_id,
        "assistant",
        state.response_md,
        metadata={
            "path": state.path,
            "triage_class": state.triage_class,
            "done": state.done,
            "artifact_count": len(state.scratchpad),
        },
    )
    logger.info(
        "agent_node_complete",
        extra={
            "phase": "compose",
            "user_id": state.user_id,
            "session_id": state.session_id,
            "artifact_count": len(state.scratchpad),
            "outcome": "ok",
        },
    )
    return state

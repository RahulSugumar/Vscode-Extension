"""Planner node for the LangGraph full path."""

from __future__ import annotations

import logging

from chatbot.agent.planner import PlannerClient
from chatbot.agent.state import AgentState, record_telemetry_event


logger = logging.getLogger(__name__)


def plan_node(state: AgentState) -> AgentState:
    state.plan = PlannerClient().create_plan(state)
    record_telemetry_event(
        state,
        kind="graph_node",
        node_id="planner",
        message="Planner produced executable steps.",
        component="planner",
        step_count=len(state.plan.steps),
        actions=[step.action for step in state.plan.steps],
        outcome="ok",
    )
    logger.info(
        "agent_node_complete",
        extra={
            "phase": "plan",
            "user_id": state.user_id,
            "session_id": state.session_id,
            "step_count": len(state.plan.steps),
            "actions": [step.action for step in state.plan.steps],
            "outcome": "ok",
        },
    )
    return state

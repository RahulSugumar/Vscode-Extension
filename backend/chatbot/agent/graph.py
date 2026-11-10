"""LangGraph assembly point for the full-path agent."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from langgraph.graph import END, StateGraph

from chatbot.agent.nodes.compose import compose_node
from chatbot.agent.nodes.critique import critique_node
from chatbot.agent.nodes.execute import execute_node
from chatbot.agent.nodes.ingest import ingest_node
from chatbot.agent.nodes.plan import plan_node
from chatbot.agent.state import AgentState
from chatbot.history.protocol import ChatHistoryClient


logger = logging.getLogger(__name__)

GRAPH_NODE_ORDER = (
    "ingest",
    "plan",
    "execute",
    "critique",
    "compose",
)


class LangGraphAgentRunner:
    """Full-path runner backed by a compiled LangGraph skeleton."""

    def __init__(self, history_client: ChatHistoryClient) -> None:
        self._history = history_client
        self._graph = self._build_graph()

    def run(self, state: AgentState) -> AgentState:
        logger.info(
            "graph_run_start",
            extra={
                "user_id": state.user_id,
                "session_id": state.session_id,
                "path": state.path,
                "triage_class": state.triage_class,
            },
        )
        final_state = _coerce_state(self._graph.invoke(state.model_dump()))
        logger.info(
            "graph_run_complete",
            extra={
                "user_id": final_state.user_id,
                "session_id": final_state.session_id,
                "done": final_state.done,
                "iteration_count": final_state.iteration_count,
                "artifact_count": len(final_state.scratchpad),
            },
        )
        return final_state

    def run_until_compose(self, state: AgentState) -> AgentState:
        """Run full-path cognition and stop before final answer composition."""

        logger.info(
            "graph_prepare_stream_start",
            extra={
                "user_id": state.user_id,
                "session_id": state.session_id,
                "path": state.path,
                "triage_class": state.triage_class,
            },
        )
        state = ingest_node(state, self._history)
        state = plan_node(state)
        while True:
            state = execute_node(state)
            state = critique_node(state)
            if _route_after_critique(state) != "execute":
                break
        logger.info(
            "graph_prepare_stream_complete",
            extra={
                "user_id": state.user_id,
                "session_id": state.session_id,
                "done": state.done,
                "iteration_count": state.iteration_count,
                "artifact_count": len(state.scratchpad),
            },
        )
        return state

    def _build_graph(self):
        graph = StateGraph(AgentState)
        # LangGraph passes state through as a mapping during execution. Each node
        # keeps the project-local Pydantic boundary by coercing the mapping back
        # into AgentState, then returning a plain dict for LangGraph to merge.
        graph.add_node(
            "ingest",
            lambda state: ingest_node(_coerce_state(state), self._history).model_dump(),
        )
        graph.add_node("plan", lambda state: plan_node(_coerce_state(state)).model_dump())
        graph.add_node(
            "execute", lambda state: execute_node(_coerce_state(state)).model_dump()
        )
        graph.add_node(
            "critique", lambda state: critique_node(_coerce_state(state)).model_dump()
        )
        graph.add_node(
            "compose",
            lambda state: compose_node(_coerce_state(state), self._history).model_dump(),
        )

        graph.set_entry_point("ingest")
        graph.add_edge("ingest", "plan")
        graph.add_edge("plan", "execute")
        graph.add_edge("execute", "critique")
        # Critique is the only loop gate. It can send the run back to execute
        # for another bounded pass, or forward to compose for the final answer.
        graph.add_conditional_edges(
            "critique",
            _route_after_critique,
            {
                "execute": "execute",
                "compose": "compose",
            },
        )
        graph.add_edge("compose", END)
        agent = graph.compile()
        # png_bytes = agent.get_graph().draw_mermaid_png()
        # graph_path = (
        #     Path(__file__).resolve().parents[2]
        #     / "docs"
        #     / "assets"
        #     / "agent_graph.png"
        # )
        # graph_path.parent.mkdir(parents=True, exist_ok=True)
        # with graph_path.open("wb") as f:
        #     f.write(png_bytes)
        return agent


def _coerce_state(state: AgentState | dict[str, Any]) -> AgentState:
    """Normalize LangGraph's runtime state into the agent's typed contract."""

    if isinstance(state, AgentState):
        return state
    return AgentState.model_validate(state)


def _route_after_critique(state: AgentState | dict[str, Any]) -> str:
    """Choose the next graph edge after critique without allowing an infinite loop."""

    agent_state = _coerce_state(state)
    if (
        not agent_state.critique_complete
        and not agent_state.done
        and agent_state.iteration_count < agent_state.max_iterations
    ):
        return "execute"
    return "compose"


def build_graph_runner(
    history_client: ChatHistoryClient,
) -> LangGraphAgentRunner:
    return LangGraphAgentRunner(history_client=history_client)

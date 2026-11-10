"""LLM-backed critique gate for Phase C."""

from __future__ import annotations

import hashlib
import json
import logging
import re
from typing import Any

import abkb
from pydantic import BaseModel, Field, ValidationError

from chatbot.agent.llm import LangChainLLMClient, LLMCallResult, load_prompt
from chatbot.agent.planner import is_project_overview_request
from chatbot.agent.state import AgentState, PlanStep, record_telemetry_event
from chatbot.config.settings import Settings, load_settings


logger = logging.getLogger(__name__)


class CritiqueResult(BaseModel):
    """Structured critique output expected from the critic prompt."""

    complete: bool
    confidence: float = Field(ge=0.0, le=1.0)
    missing: str | None = None
    follow_up_instruction: str | None = None


class CriticClient:
    """Decides whether execution evidence is sufficient to compose an answer."""

    def __init__(
        self,
        llm: LangChainLLMClient | None = None,
        settings: Settings | None = None,
    ) -> None:
        self._settings = settings or load_settings()
        self._llm = llm or LangChainLLMClient(self._settings)

    def critique(self, state: AgentState) -> AgentState:
        """Apply confidence, iteration, and no-progress gates to the graph."""

        scratchpad_hash = _scratchpad_hash(state)
        if state.done:
            record_telemetry_event(
                state,
                kind="subagent_call",
                node_id="critic",
                subagent_id="critic",
                message="Critic skipped because state was already done.",
                status="skipped",
            )
            return _mark_complete(state, 1.0, None, scratchpad_hash)
        if state.iteration_count >= state.max_iterations:
            record_telemetry_event(
                state,
                kind="subagent_call",
                node_id="critic",
                subagent_id="critic",
                message="Critic stopped at iteration cap.",
                status="skipped",
                iteration_count=state.iteration_count,
                max_iterations=state.max_iterations,
            )
            return _mark_complete(
                state,
                state.critique_confidence or 0.5,
                "Reached the iteration cap.",
                scratchpad_hash,
            )
        if state.last_scratchpad_hash == scratchpad_hash:
            record_telemetry_event(
                state,
                kind="subagent_call",
                node_id="critic",
                subagent_id="critic",
                message="Critic stopped because scratchpad did not change.",
                status="skipped",
                scratchpad_hash=scratchpad_hash,
            )
            return _mark_complete(
                state,
                state.critique_confidence or 0.5,
                "Stopped because the scratchpad did not change.",
                scratchpad_hash,
            )


        if _needs_project_inventory_recovery(state):
            _append_project_inventory_step(state)
            state.last_scratchpad_hash = scratchpad_hash
            state.critique_confidence = 0.35
            state.critique_missing = (
                "Broad project overview requires structural project inventory, "
                "not only semantic CodeGraph matches."
            )
            state.critique_complete = False
            record_telemetry_event(
                state,
                kind="subagent_call",
                node_id="critic",
                subagent_id="critic",
                message="Critic requested structural project inventory for broad overview.",
                status="continue",
                missing=state.critique_missing,
            )
            return state

        result = self._call_critic(state)
        state.last_scratchpad_hash = scratchpad_hash
        state.critique_confidence = result.confidence
        state.critique_missing = result.missing

        threshold_met = result.confidence >= self._settings.critic_confidence_threshold
        state.critique_complete = result.complete and threshold_met

        if not state.critique_complete and result.follow_up_instruction:
            _append_follow_up_step(state, result.follow_up_instruction)

        if state.iteration_count >= state.max_iterations:
            state.critique_complete = True

        logger.info(
            "critic_complete",
            extra={
                "phase": "critique",
                "user_id": state.user_id,
                "session_id": state.session_id,
                "outcome": "complete" if state.critique_complete else "continue",
            },
        )
        return state

    def _call_critic(self, state: AgentState) -> CritiqueResult:
        """Call the critic model and degrade to safe completion on bad JSON."""

        if not state.scratchpad:
            record_telemetry_event(
                state,
                kind="subagent_call",
                node_id="critic",
                subagent_id="critic",
                message="Critic skipped LLM because no execution artifacts were available.",
                status="skipped",
                error="No execution artifacts were produced.",
            )
            return CritiqueResult(
                complete=False,
                confidence=0.2,
                missing="No execution artifacts were produced.",
                follow_up_instruction="Produce one bounded reasoning artifact.",
            )
        prompt_input = _critic_input(state)
        system_prompt = abkb.compose_prompt(
            load_prompt("critic"),
            agent_id="critic",
            node_id="critic",
        )
        call = self._llm.invoke(
            "critic",
            prompt_input,
            system_prompt=system_prompt,
        )
        record_telemetry_event(
            state,
            kind="subagent_call",
            node_id="critic",
            subagent_id="critic",
            message="Critic LLM call completed.",
            prompt_name="critic",
            input_preview=_clip_text(prompt_input),
            output_preview=_clip_text(call.text),
            provider=call.provider,
            model=call.model,
            prompt_hash=call.prompt_hash,
            latency_ms=call.latency_ms,
            token_count=call.token_count,
            fallback_llm=call.fallback,
            status="success",
        )
        try:
            result = parse_critique_json(call.text)
        except (ValueError, ValidationError):
            result = CritiqueResult(
                complete=True,
                confidence=0.75,
                missing="Critique output was malformed; using safe completion.",
            )
        _store_metric(state, "critic", call)
        return result


def parse_critique_json(text: str) -> CritiqueResult:
    """Parse critic JSON from raw or fenced model output."""

    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*", "", stripped)
        stripped = re.sub(r"\s*```$", "", stripped)
    try:
        loaded = json.loads(stripped)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", stripped, re.DOTALL)
        if match is None:
            raise ValueError("no JSON object found") from None
        loaded = json.loads(match.group(0))
    if not isinstance(loaded, dict):
        raise ValueError("critique JSON is not an object")
    return CritiqueResult.model_validate(loaded)


def _mark_complete(
    state: AgentState, confidence: float, missing: str | None, scratchpad_hash: str
) -> AgentState:
    state.critique_complete = True
    state.critique_confidence = confidence
    state.critique_missing = missing
    state.last_scratchpad_hash = scratchpad_hash
    return state



def _needs_project_inventory_recovery(state: AgentState) -> bool:
    if not is_project_overview_request(state.user_text):
        return False
    if state.plan is not None and any(
        step.action == "query_project_inventory" for step in state.plan.steps
    ):
        return False
    has_semantic_codegraph = any(
        artifact.action == "query_codegraph" for artifact in state.scratchpad
    )
    has_inventory = any(
        artifact.action == "query_project_inventory"
        or artifact.metadata.get("tool") in {
            "codegraph_project_inventory",
            "codegraph_project_inventory_stub",
            "codegraph_project_inventory_legacy",
        }
        for artifact in state.scratchpad
    )
    return has_semantic_codegraph and not has_inventory


def _append_project_inventory_step(state: AgentState) -> None:
    if state.plan is None:
        return
    if any(step.metadata.get("critic_follow_up") for step in state.plan.steps):
        return
    next_index = len(state.plan.steps) + 1
    depends_on = [artifact.step_id for artifact in state.scratchpad[-2:]]
    state.plan.steps.append(
        PlanStep(
            id=f"step-{next_index}",
            action="query_project_inventory",
            instruction=(
                "Retrieve structural project inventory for the broad project "
                "overview request."
            ),
            depends_on=depends_on,
            metadata={
                "critic_follow_up": True,
                "planner_guard": "project_inventory_required",
            },
        )
    )
def _append_follow_up_step(state: AgentState, instruction: str) -> None:
    """Add at most one critic-requested reasoning step to avoid loops."""

    if state.plan is None:
        return
    if any(step.metadata.get("critic_follow_up") for step in state.plan.steps):
        return
    next_index = len(state.plan.steps) + 1
    depends_on = [artifact.step_id for artifact in state.scratchpad[-2:]]
    state.plan.steps.append(
        PlanStep(
            id=f"step-{next_index}",
            action="reason",
            instruction=instruction,
            depends_on=depends_on,
        )
    )
    state.plan.steps[-1].metadata = {"critic_follow_up": True}


def _critic_input(state: AgentState) -> str:
    payload: dict[str, Any] = {
        "user_request": state.user_text,
        "plan": state.plan.model_dump() if state.plan is not None else None,
        "artifacts": [artifact.model_dump() for artifact in state.scratchpad],
        "errors": state.errors,
    }
    return json.dumps(payload, ensure_ascii=True)


def _scratchpad_hash(state: AgentState) -> str:
    """Hash plan and artifacts so critique can detect no-progress loops."""

    payload = {
        "plan": state.plan.model_dump() if state.plan is not None else None,
        "scratchpad": [artifact.model_dump() for artifact in state.scratchpad],
    }
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:16]


def _store_metric(state: AgentState, name: str, result: LLMCallResult) -> None:
    state.metrics[name] = {
        "provider": result.provider,
        "model": result.model,
        "prompt_hash": result.prompt_hash,
        "latency_ms": result.latency_ms,
        "token_count": result.token_count,
        "fallback_llm": result.fallback,
    }


def _clip_text(text: Any, limit: int = 4000) -> str:
    rendered = "" if text is None else str(text)
    if len(rendered) <= limit:
        return rendered
    return rendered[:limit].rstrip() + f"\n[truncated {len(rendered) - limit} chars]"

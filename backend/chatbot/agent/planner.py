"""LLM-backed planner for Phase C full-path cognition."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

import abkb
from pydantic import ValidationError

from chatbot.agent.llm import LangChainLLMClient, LLMCallResult, load_prompt
from chatbot.agent.state import AgentState, Plan, PlanStep, record_telemetry_event
from chatbot.config.settings import Settings, load_settings


logger = logging.getLogger(__name__)

CODEGRAPH_HINTS = (
    "api",
    "architecture",
    "build",
    "called",
    "calls",
    "component",
    "controller",
    "database",
    "dependencies",
    "symbol",
    "dto",
    "endpoint",
    "entity",
    "file",
    "flow",
    "function",
    "how it works",
    "implementation",
    "logic",
    "model",
    "class",
    "definition",
    "defined",
    "method",
    "module",
    "package",
    "path",
    "project",
    "repository",
    "search",
    "find",
    "where",
    "call",
    "caller",
    "callee",
    "dependency",
    "handler",
    "import",
    "relation",
    "relations",
    "relationship",
    "relationships",
    "route",
    "code",
    "codebase",
    "service",
    "workflow",
)

FOLLOW_UP_HINTS = (
    "it",
    "that",
    "this",
    "they",
    "them",
    "those",
    "above",
    "same",
    "previous",
    "earlier",
)

SYMBOL_RE = re.compile(
    r"(?:"
    r"\b[_a-zA-Z][_a-zA-Z0-9]*\s*\("
    r"|"
    r"\b_[a-zA-Z0-9_]+\b"
    r"|"
    r"\b[a-z]+[A-Z][a-zA-Z0-9_]*\b"
    r")"
)

IMPLEMENTATION_QUESTION_RE = re.compile(
    r"\b(how|what|which|where|why)\b.{0,120}"
    r"\b(create|created|creation|build|built|needed|need|required|requires)\b",
    re.IGNORECASE,
)


PROJECT_SCOPE_HINTS = (
    "project",
    "codebase",
    "repo",
    "repository",
)

PROJECT_OVERVIEW_HINTS = (
    "all",
    "complete",
    "entire",
    "everything",
    "explain",
    "full",
    "inventory",
    "overview",
    "structure",
    "summarize",
    "summary",
    "whole",
)

PROJECT_INVENTORY_HINTS = (
    "class",
    "classes",
    "file",
    "files",
    "folder",
    "folders",
    "function",
    "functions",
    "interface",
    "interfaces",
    "method",
    "methods",
    "module",
    "modules",
)

class PlannerClient:
    """Builds and validates the execution plan for a full-path request."""

    def __init__(
        self,
        llm: LangChainLLMClient | None = None,
        settings: Settings | None = None,
    ) -> None:
        self._settings = settings or load_settings()
        self._llm = llm or LangChainLLMClient(self._settings)

    def create_plan(self, state: AgentState) -> Plan:
        """Ask the LLM for JSON, validate it, and fall back if parsing fails."""

        content = _planner_input(state)
        system_prompt = abkb.compose_prompt(
            load_prompt("planner", {"max_steps": self._settings.planner_max_steps}),
            agent_id="planner",
            node_id="planner",
        )
        result = self._llm.invoke(
            "planner",
            content,
            system_prompt=system_prompt,
        )
        record_telemetry_event(
            state,
            kind="subagent_call",
            node_id="planner",
            subagent_id="planner",
            message="Planner LLM call completed.",
            prompt_name="planner",
            input_preview=_clip_text(content),
            output_preview=_clip_text(result.text),
            provider=result.provider,
            model=result.model,
            prompt_hash=result.prompt_hash,
            latency_ms=result.latency_ms,
            token_count=result.token_count,
            fallback_llm=result.fallback,
            status="success",
        )
        try:
            plan = parse_plan_json(result.text)
            plan = ensure_codegraph_for_code_request(
                plan,
                state.user_text,
                window=state.window,
            )
            validate_plan(plan, self._settings.planner_max_steps)
            plan.metadata.update(_metadata(result, parse_outcome="ok"))
        except (ValueError, ValidationError) as exc:
            plan = fallback_plan(state.user_text)
            plan = ensure_codegraph_for_code_request(
                plan,
                state.user_text,
                window=state.window,
            )
            plan.metadata.update(_metadata(result, parse_outcome="fallback"))
            plan.metadata["parse_error"] = exc.__class__.__name__
        state.metrics["planner"] = {
            "provider": result.provider,
            "model": result.model,
            "prompt_hash": result.prompt_hash,
            "latency_ms": result.latency_ms,
            "token_count": result.token_count,
            "fallback_llm": result.fallback,
            "parse_outcome": plan.metadata.get("parse_outcome", "unknown"),
        }

        logger.info(
            "planner_complete",
            extra={
                "phase": "plan",
                "user_id": state.user_id,
                "session_id": state.session_id,
                "outcome": plan.metadata.get("parse_outcome", "unknown"),
            },
        )
        return plan


def parse_plan_json(text: str) -> Plan:
    """Extract planner JSON from plain text or fenced markdown."""

    payload = _extract_json_object(text)
    plan = Plan.model_validate(payload)
    return plan


def validate_plan(plan: Plan, max_steps: int) -> None:
    """Reject unsafe or impossible plans before executor work begins."""

    if not plan.steps:
        raise ValueError("plan has no steps")
    if len(plan.steps) > max_steps:
        raise ValueError("plan exceeds max steps")

    seen: set[str] = set()
    for step in plan.steps:
        if step.id in seen:
            raise ValueError(f"duplicate step id: {step.id}")
        for dependency in step.depends_on:
            if dependency not in seen:
                raise ValueError(
                    f"step {step.id} depends on missing or later step {dependency}"
                )
        seen.add(step.id)

    _ensure_acyclic(plan)


def ensure_codegraph_for_code_request(
    plan: Plan,
    user_text: str,
    *,
    window: Any | None = None,
) -> Plan:
    """Force codebase questions through the right evidence path.

    Focused questions use semantic CodeGraph retrieval. Broad project overview
    questions use a structural inventory so they are not limited to top-k matches.
    """

    if is_project_overview_request(user_text) and not is_architecture_report_request(user_text):
        return ensure_project_inventory_for_overview_request(plan, user_text)

    # A one-step rejection is a terminal planner decision. In particular, an
    # active judge policy may have required it. Do not silently discard that
    # decision merely because the request contains a word that resembles a
    # CodeGraph retrieval hint.
    if len(plan.steps) == 1 and plan.steps[0].action == "reject_unrelated":
        plan.metadata["terminal_rejection_preserved"] = True
        return plan

    codegraph_query = codegraph_query_for_request(user_text, window=window)
    if codegraph_query is None:
        return plan
    if any(step.action == "query_codegraph" for step in plan.steps):
        graph_steps = [step for step in plan.steps if step.action == "query_codegraph"]
        answer_steps = [
            step
            for step in plan.steps
            if step.action not in {"query_codegraph", "ask_clarification", "reject_unrelated"}
        ]
        graph_step_ids = [step.id for step in graph_steps]
        answer_step_ids = {step.id for step in answer_steps}
        for step in plan.steps:
            if step.action == "query_codegraph":
                _apply_retrieval_profile(step, user_text)
                _mark_current_graph_source(step)
                step.depends_on = []
                if _is_follow_up(user_text):
                    step.instruction = _merge_context_query(step.instruction, codegraph_query)
                    step.metadata.setdefault("contextualized_query", True)
                    plan.metadata["codegraph_query_contextualized"] = True
            elif step.action in {"reason", "summarize", "compare"}:
                for graph_step_id in graph_step_ids:
                    if graph_step_id not in step.depends_on:
                        step.depends_on = [graph_step_id, *step.depends_on]
                step.depends_on = [
                    dependency
                    for dependency in step.depends_on
                    if dependency in graph_step_ids or dependency in answer_step_ids
                ]
                step.metadata.setdefault("planner_guard", "codegraph_required")
                _mark_current_graph_source(step)
        plan.steps = [*graph_steps, *answer_steps]
        plan.metadata["codegraph_guard_applied"] = True
        plan.metadata["source_priority"] = "current_graph"
        plan.metadata["history_usage"] = "context_only"
        return plan

    existing_steps = [
        step
        for step in plan.steps
        if step.action not in {"ask_clarification", "reject_unrelated"}
    ]
    codegraph_step = PlanStep(
        id=_unique_step_id(plan, "step-codegraph"),
        action="query_codegraph",
        instruction=codegraph_query,
        metadata={
            "planner_guard": "codegraph_required",
            "retrieval_profile": retrieval_profile_for_request(user_text),
            "report_type": report_type_for_request(user_text),
            "source_priority": "current_graph",
            "history_usage": "context_only",
        },
    )
    if not existing_steps:
        existing_steps = [
            PlanStep(
                id=_unique_step_id(Plan(steps=[codegraph_step]), "step-reason"),
                action="reason",
                instruction="Answer from the retrieved CodeGraph evidence.",
                depends_on=[codegraph_step.id],
                metadata={
                    "planner_guard": "codegraph_required",
                    "source_priority": "current_graph",
                    "history_usage": "context_only",
                },
            )
        ]
    else:
        existing_ids = {step.id for step in existing_steps}
        for step in existing_steps:
            if step.id == codegraph_step.id:
                continue
            if (
                step.action in {"reason", "summarize", "compare"}
                and codegraph_step.id not in step.depends_on
            ):
                step.depends_on = [
                    codegraph_step.id,
                    *[
                        dependency
                        for dependency in step.depends_on
                        if dependency in existing_ids
                    ],
                ]
            step.metadata.setdefault("planner_guard", "codegraph_required")
            _mark_current_graph_source(step)

    plan.steps = [codegraph_step, *existing_steps]
    plan.metadata["codegraph_guard_applied"] = True
    plan.metadata["source_priority"] = "current_graph"
    plan.metadata["history_usage"] = "context_only"
    return plan


def ensure_project_inventory_for_overview_request(plan: Plan, user_text: str) -> Plan:
    """Force broad project-summary requests through structural inventory."""

    existing_inventory = next(
        (step for step in plan.steps if step.action == "query_project_inventory"),
        None,
    )
    if existing_inventory is not None:
        inventory_id = existing_inventory.id
        for step in plan.steps:
            if step.action == "query_project_inventory":
                step.instruction = _project_inventory_instruction(
                    user_text,
                    existing_instruction=step.instruction,
                )
                step.metadata.setdefault("planner_guard", "project_inventory_required")
                _mark_current_graph_source(step)
            elif (
                step.action in {"reason", "summarize", "compare"}
                and inventory_id not in step.depends_on
            ):
                step.depends_on = [inventory_id, *step.depends_on]
                step.metadata.setdefault("planner_guard", "project_inventory_required")
                _mark_current_graph_source(step)
        plan.metadata["project_inventory_guard_applied"] = True
        plan.metadata["source_priority"] = "current_graph"
        plan.metadata["history_usage"] = "context_only"
        return plan

    existing_steps = [
        step
        for step in plan.steps
        if step.action
        not in {"ask_clarification", "reject_unrelated", "query_codegraph"}
    ]
    inventory_step = PlanStep(
        id=_unique_step_id(plan, "step-project-inventory"),
        action="query_project_inventory",
        instruction=_project_inventory_instruction(user_text),
        metadata={
            "planner_guard": "project_inventory_required",
            "source_priority": "current_graph",
            "history_usage": "context_only",
        },
    )
    if not existing_steps:
        existing_steps = [
            PlanStep(
                id=_unique_step_id(Plan(steps=[inventory_step]), "step-summary"),
                action="summarize",
                instruction=(
                    "Summarize the structural inventory into a complete project "
                    "overview with files, classes, methods, functions, and key "
                    "relationships."
                ),
                depends_on=[inventory_step.id],
                metadata={
                    "planner_guard": "project_inventory_required",
                    "source_priority": "current_graph",
                    "history_usage": "context_only",
                },
            )
        ]
    else:
        existing_ids = {step.id for step in existing_steps}
        for step in existing_steps:
            if (
                step.action in {"reason", "summarize", "compare"}
                and inventory_step.id not in step.depends_on
            ):
                step.depends_on = [
                    inventory_step.id,
                    *[
                        dependency
                        for dependency in step.depends_on
                        if dependency in existing_ids
                    ],
                ]
            step.metadata.setdefault("planner_guard", "project_inventory_required")
            _mark_current_graph_source(step)

    plan.steps = [inventory_step, *existing_steps]
    plan.metadata["project_inventory_guard_applied"] = True
    plan.metadata["source_priority"] = "current_graph"
    plan.metadata["history_usage"] = "context_only"
    return plan

def codegraph_query_for_request(user_text: str, *, window: Any | None = None) -> str | None:
    """Return a concrete CodeGraph query, resolving follow-ups from history."""

    text = user_text.strip()
    if requires_codegraph(text):
        if _is_follow_up(text):
            previous_topic = _previous_codebase_user_turn(window, current_text=text)
            if previous_topic:
                return _contextualized_query(text, previous_topic)
            if not _has_self_contained_code_target(text):
                return None
        return text or "Retrieve relevant codebase context."

    if not _is_follow_up(text):
        return None

    previous_topic = _previous_codebase_user_turn(window, current_text=text)
    if previous_topic is None:
        return None
    return _contextualized_query(text, previous_topic)


def requires_codegraph(user_text: str) -> bool:
    if is_project_overview_request(user_text) and not is_architecture_report_request(user_text):
        return False
    lowered = user_text.lower()
    if any(_contains_phrase(lowered, hint) for hint in CODEGRAPH_HINTS):
        return True
    if IMPLEMENTATION_QUESTION_RE.search(user_text):
        return True
    return bool(SYMBOL_RE.search(user_text))


def is_project_overview_request(user_text: str) -> bool:
    """Return True for broad requests that need structural inventory."""

    normalized = _normalize_request_text(user_text)
    if not normalized:
        return False
    has_scope = any(scope in normalized for scope in PROJECT_SCOPE_HINTS)
    if not has_scope:
        return False
    if any(hint in normalized for hint in PROJECT_OVERVIEW_HINTS):
        return True
    if re.search(r"\bwhat\b.{0,80}\b(done|built|created|implemented|have)\b", normalized):
        return True
    inventory_hint_count = sum(
        1 for hint in PROJECT_INVENTORY_HINTS if re.search(rf"\b{hint}\b", normalized)
    )
    return inventory_hint_count >= 2


def is_architecture_report_request(user_text: str) -> bool:
    normalized = _normalize_request_text(user_text)
    return any(
        term in normalized
        for term in (
            "architecture",
            "architectural",
            "system design",
            "module map",
            "full flow map",
        )
    )

def retrieval_profile_for_request(user_text: str) -> str:
    """Classify CodeGraph searches into retrieval profiles."""

    normalized = _normalize_request_text(user_text)
    if any(term in normalized for term in ("compare", "difference", "different")):
        return "compare"
    if re.search(
        r"\b(where|what|which)\b.{0,100}\b(defined|definition|declared|declaration|reference|references|used|used by|caller|callers|callee|callees)\b",
        normalized,
    ):
        return "focused"
    if any(
        term in normalized
        for term in (
            "architecture",
            "dependency",
            "dependencies",
            "module",
            "modules",
            "package",
            "packages",
        )
    ):
        return "architecture"
    if any(
        term in normalized
        for term in (
            "created",
            "flow",
            "how",
            "implementation",
            "logic",
            "process",
            "workflow",
            "works",
            "request",
            "endpoint",
            "route",
        )
    ):
        return "workflow"
    return "focused"

def report_type_for_request(user_text: str) -> str:
    """Classify CodeGraph questions into deterministic report types."""

    normalized = _normalize_request_text(user_text)
    if any(term in normalized for term in ("compare", "difference", "different")):
        return "compare_report"
    if re.search(
        r"\b(where|what|which)\b.{0,100}\b(defined|definition|declared|declaration|reference|references|used|used by|caller|callers|callee|callees)\b",
        normalized,
    ):
        return "focused_symbol_report"
    if any(
        term in normalized
        for term in (
            "flow",
            "how",
            "implementation",
            "logic",
            "process",
            "relationship",
            "relationships",
            "request",
            "workflow",
            "works",
        )
    ):
        return "workflow_relationship_report"
    if any(
        term in normalized
        for term in (
            "architecture",
            "architectural",
            "dependency",
            "dependencies",
            "module",
            "modules",
            "package",
            "packages",
        )
    ):
        return "architecture_report"
    return "focused_symbol_report"

def _is_follow_up(user_text: str) -> bool:
    lowered = user_text.lower()
    return any(re.search(rf"\b{re.escape(hint)}\b", lowered) for hint in FOLLOW_UP_HINTS)


def _has_self_contained_code_target(user_text: str) -> bool:
    if SYMBOL_RE.search(user_text):
        return True
    lowered = user_text.lower()
    target_hints = (
        "api",
        "controller",
        "dto",
        "entity",
        "file",
        "function",
        "method",
        "module",
        "repository",
        "service",
        "workflow",
    )
    return any(_contains_phrase(lowered, hint) for hint in target_hints)


def _previous_codebase_user_turn(window: Any | None, *, current_text: str) -> str | None:
    if window is None:
        return None

    current_normalized = _normalize_text(current_text)
    for turn in reversed(getattr(window, "verbatim", [])[:-1]):
        if getattr(turn, "role", None) != "user":
            continue
        content = getattr(turn, "content", "").strip()
        if not content or _normalize_text(content) == current_normalized:
            continue
        if requires_codegraph(content):
            return content
    return None


def _contextualized_query(user_text: str, previous_topic: str) -> str:
    return (
        "Previous codebase topic: "
        f"{previous_topic}\nCurrent follow-up question: {user_text.strip()}"
    )


def _merge_context_query(existing_instruction: str, contextualized_query: str) -> str:
    existing = existing_instruction.strip()
    if not existing:
        return contextualized_query
    if contextualized_query in existing:
        return existing
    return f"{contextualized_query}\nPlanner instruction: {existing}"


def _apply_retrieval_profile(step: PlanStep, user_text: str) -> None:
    step.metadata.setdefault("retrieval_profile", retrieval_profile_for_request(user_text))
    step.metadata.setdefault("report_type", report_type_for_request(user_text))


def _mark_current_graph_source(step: PlanStep) -> None:
    step.metadata.setdefault("source_priority", "current_graph")
    step.metadata.setdefault("history_usage", "context_only")


def _project_inventory_instruction(
    user_text: str,
    *,
    existing_instruction: str | None = None,
) -> str:
    text = user_text.strip() or "Provide a complete project overview."
    instruction = (
        "Build a structural project inventory for this request. Include files, "
        "classes, methods, functions, interfaces, modules, and important "
        f"relationships where available. User request: {text}"
    )
    if existing_instruction and existing_instruction.strip() not in instruction:
        instruction = f"{instruction}\nPlanner instruction: {existing_instruction.strip()}"
    return instruction


def _normalize_request_text(text: str) -> str:
    normalized = _normalize_text(text)
    typo_map = {
        "projetc": "project",
        "proect": "project",
        "projec": "project",
        "retriving": "retrieving",
    }
    for typo, replacement in typo_map.items():
        normalized = normalized.replace(typo, replacement)
    return normalized


def _normalize_text(text: str) -> str:
    return " ".join(text.lower().split())


def _contains_phrase(text: str, phrase: str) -> bool:
    """Match retrieval hints as complete words or phrases, not substrings."""

    return bool(
        re.search(
            rf"(?<!\w){re.escape(phrase.lower())}(?!\w)",
            text.lower(),
        )
    )


def _unique_step_id(plan: Plan, preferred: str) -> str:
    existing = {step.id for step in plan.steps}
    if preferred not in existing:
        return preferred
    index = 1
    while f"{preferred}-{index}" in existing:
        index += 1
    return f"{preferred}-{index}"


def fallback_plan(user_text: str) -> Plan:
    """Create a deterministic plan when the live planner is unavailable."""

    text = user_text.strip()
    lowered = text.lower()
    if not text:
        return Plan(
            steps=[
                PlanStep(
                    id="step-1",
                    action="ask_clarification",
                    instruction=(
                        "Ask the user for the codebase question they want answered."
                    ),
                )
            ],
            metadata={"fallback": True},
        )
    if is_project_overview_request(text) and not is_architecture_report_request(text):
        return Plan(
            steps=[
                PlanStep(
                    id="step-1",
                    action="query_project_inventory",
                    instruction=_project_inventory_instruction(text),
                ),
                PlanStep(
                    id="step-2",
                    action="summarize",
                    instruction=(
                        "Summarize the structural inventory into a complete project "
                        "overview."
                    ),
                    depends_on=["step-1"],
                ),
            ],
            metadata={"fallback": True},
        )
    if requires_codegraph(text):
        return Plan(
            steps=[
                PlanStep(
                    id="step-1",
                    action="query_codegraph",
                    instruction=text,
                    metadata={
                        "retrieval_profile": retrieval_profile_for_request(text),
                        "report_type": report_type_for_request(text),
                    },
                ),
                PlanStep(
                    id="step-2",
                    action="reason",
                    instruction="Reason from the CodeGraph result.",
                    depends_on=["step-1"],
                ),
            ],
            metadata={"fallback": True},
        )
    if "compare" in lowered or "difference" in lowered:
        action = "compare"
    elif "summarize" in lowered or "summary" in lowered:
        action = "summarize"
    else:
        action = "reason"
    return Plan(
        steps=[
            PlanStep(
                id="step-1",
                action=action,
                instruction=f"Provide a bounded answer for: {text}",
            )
        ],
        metadata={"fallback": True},
    )


def _planner_input(state: AgentState) -> str:
    """Serialize only bounded context into the planner prompt payload."""

    window = state.window
    verbatim = []
    if window is not None:
        verbatim = [
            {"role": turn.role, "content": turn.content}
            for turn in window.verbatim[-8:]
        ]
    payload: dict[str, Any] = {
        "user_request": state.user_text,
        "layered_window": {
            "summary": window.summary if window is not None else None,
            "pinned_facts": window.pinned_facts if window is not None else [],
            "verbatim": verbatim,
        },
    }
    return json.dumps(payload, ensure_ascii=True)


def _extract_json_object(text: str) -> dict[str, Any]:
    """Recover the first JSON object from common LLM response shapes."""

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
        raise ValueError("planner JSON is not an object")
    return loaded


def _ensure_acyclic(plan: Plan) -> None:
    graph = {step.id: set(step.depends_on) for step in plan.steps}
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(step_id: str) -> None:
        if step_id in visiting:
            raise ValueError(f"cyclic dependency at {step_id}")
        if step_id in visited:
            return
        visiting.add(step_id)
        for dependency in graph.get(step_id, set()):
            visit(dependency)
        visiting.remove(step_id)
        visited.add(step_id)

    for step_id in graph:
        visit(step_id)


def _metadata(result: LLMCallResult, parse_outcome: str) -> dict[str, Any]:
    return {
        "provider": result.provider,
        "model": result.model,
        "prompt_hash": result.prompt_hash,
        "latency_ms": result.latency_ms,
        "token_count": result.token_count,
        "fallback_llm": result.fallback,
        "parse_outcome": parse_outcome,
    }


def _clip_text(text: str, limit: int = 4000) -> str:
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + f"\n[truncated {len(text) - limit} chars]"

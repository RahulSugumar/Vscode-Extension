"""Bounded executor for plan steps."""

from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from typing import Any, Protocol

import abkb

from chatbot.agent.llm import LangChainLLMClient, LLMCallResult, load_prompt
from chatbot.agent.state import AgentState, Plan, PlanStep, StepArtifact, record_telemetry_event
from chatbot.agent.tools.codegraph import CodeGraphToolResult, build_codegraph_tool
from chatbot.agent.tools.codegraph_stub import CodeGraphStub
from chatbot.config.settings import Settings, load_settings
from graphrag_agent.services.retrieval_profiles import (
    build_profile_request,
    csv_filter,
)


logger = logging.getLogger(__name__)

PROMPT_BY_ACTION = {
    "reason": "executor_reason",
    "summarize": "executor_summarize",
    "compare": "executor_compare",
}




class CodeGraphQueryTool(Protocol):
    """Tool shape used by the executor for real and stub CodeGraph clients."""

    def query(self, query_text: str) -> CodeGraphToolResult | str:
        ...



    def retrieve(
        self,
        query: str,
        top_k: int | None = None,
        max_neighbors: int | None = None,
        database: str | None = None,
        profile: str | None = None,
        candidate_k: int | None = None,
        final_k: int | None = None,
        node_types: str | None = None,
        relationship_types: str | None = None,
    ) -> CodeGraphToolResult | str:
        ...

    def project_inventory(self) -> CodeGraphToolResult | str:
        ...

    def architecture_report(
        self,
        query: str = "",
        database: str | None = None,
        max_files: int = 400,
        max_symbols: int = 3000,
        max_relationship_samples: int = 300,
    ) -> CodeGraphToolResult | str:
        ...

    def workflow_report(
        self,
        query: str,
        database: str | None = None,
        seed_k: int | None = None,
        max_depth: int = 4,
        limit: int = 160,
    ) -> CodeGraphToolResult | str:
        ...

    def focused_report(
        self,
        query: str,
        database: str | None = None,
        seed_k: int | None = None,
        limit: int = 120,
    ) -> CodeGraphToolResult | str:
        ...

    def compare_report(
        self,
        query: str,
        database: str | None = None,
        seed_k: int | None = None,
        max_depth: int = 3,
        limit: int = 120,
    ) -> CodeGraphToolResult | str:
        ...


class ExecutorClient:
    """Runs planner steps with bounded time, dependency, and step-count guards."""

    def __init__(
        self,
        llm: LangChainLLMClient | None = None,
        settings: Settings | None = None,
        codegraph: CodeGraphQueryTool | None = None,
    ) -> None:
        self._settings = settings or load_settings()
        self._llm = llm or LangChainLLMClient(self._settings)
        self._codegraph = codegraph or _build_default_codegraph(self._settings)

    def execute(self, state: AgentState) -> AgentState:
        """Execute all ready plan steps and append artifacts to state."""

        if state.plan is None:
            state.errors.append("No plan available for execution.")
            record_telemetry_event(
                state,
                kind="subagent_call",
                node_id="executor",
                subagent_id="executor",
                message="Executor skipped because no plan was available.",
                status="error",
                error="No plan available for execution.",
            )
            return state

        dependency_error = validate_execution_dependencies(state.plan)
        if dependency_error is not None:
            state.errors.append(dependency_error)
            state.scratchpad.append(
                StepArtifact(
                    step_id="plan-validation",
                    action="reason",
                    output=dependency_error,
                    error=dependency_error,
                )
            )
            record_telemetry_event(
                state,
                kind="subagent_call",
                node_id="executor",
                subagent_id="executor",
                message="Executor rejected invalid plan dependencies.",
                status="error",
                error=dependency_error,
            )
            state.iteration_count += 1
            return state

        completed_step_ids = {artifact.step_id for artifact in state.scratchpad}
        executed_this_pass = 0

        for step in state.plan.steps:
            if executed_this_pass >= self._settings.executor_max_steps:
                state.errors.append("Executor step cap reached.")
                break
            if step.id in completed_step_ids:
                continue

            record_telemetry_event(
                state,
                kind="subagent_call",
                node_id="executor",
                subagent_id="executor",
                message="Executor started plan step.",
                step_id=step.id,
                action=step.action,
                instruction=step.instruction,
                status="started",
            )

            missing = [
                dependency
                for dependency in step.depends_on
                if dependency not in completed_step_ids
            ]
            if missing:
                error = (
                    f"Step {step.id} skipped; missing dependencies: "
                    f"{', '.join(missing)}"
                )
                state.errors.append(error)
                record_telemetry_event(
                    state,
                    kind="subagent_call",
                    node_id="executor",
                    subagent_id="executor",
                    message="Executor skipped plan step because dependencies were missing.",
                    step_id=step.id,
                    action=step.action,
                    missing_dependencies=missing,
                    status="skipped",
                    error=error,
                )
                continue

            artifact = self._execute_step(step, state)
            state.scratchpad.append(artifact)
            record_telemetry_event(
                state,
                kind="subagent_call",
                node_id="executor",
                subagent_id="executor",
                message="Executor completed plan step.",
                step_id=step.id,
                action=step.action,
                status="error" if artifact.error else "success",
                error=artifact.error or "",
                output_preview=_clip_text(artifact.output),
                metadata=artifact.metadata,
            )
            completed_step_ids.add(step.id)
            executed_this_pass += 1
            if step.action in {"ask_clarification", "reject_unrelated"}:
                state.response_md = artifact.output
                state.done = True
                break

            logger.info(
                "agent_step_complete",
                extra={
                    "phase": "execute",
                    "user_id": state.user_id,
                    "session_id": state.session_id,
                    "step_id": step.id,
                    "action": step.action,
                    "outcome": "error" if artifact.error else "ok",
                },
            )

        state.iteration_count += 1
        return state

    def _execute_step(self, step: PlanStep, state: AgentState) -> StepArtifact:
        """Dispatch one plan step to the correct tool or prompt."""

        if step.action in {"ask_clarification", "reject_unrelated"}:
            output = step.instruction.strip()
            if not output:
                output = "Please provide a codebase question I can help with."
            return StepArtifact(
                step_id=step.id,
                action=step.action,
                output=output,
            )

        if step.action == "query_codegraph":
            return self._query_codegraph(step, state)

        if step.action == "query_project_inventory":
            return self._query_project_inventory(step, state)

        prompt_name = PROMPT_BY_ACTION.get(step.action)
        if prompt_name is None:
            return StepArtifact(
                step_id=step.id,
                action=step.action,
                output=f"Unsupported action: {step.action}",
                error="unsupported_action",
            )

        try:
            system_prompt = abkb.compose_prompt(
                load_prompt(prompt_name),
                agent_id="executor",
                node_id="executor",
                tool_ids=("codegraph",),
            )
            result = _with_timeout(
                self._settings.executor_step_timeout_seconds,
                lambda: self._llm.invoke(
                    prompt_name,
                    _step_input(step, state),
                    system_prompt=system_prompt,
                ),
            )
        except FutureTimeout:
            record_telemetry_event(
                state,
                kind="subagent_call",
                node_id="executor",
                subagent_id="executor",
                message="Executor LLM step timed out.",
                step_id=step.id,
                action=step.action,
                status="error",
                error="timeout",
            )
            return StepArtifact(
                step_id=step.id,
                action=step.action,
                output="The step timed out and was skipped safely.",
                error="timeout",
            )

        record_telemetry_event(
            state,
            kind="subagent_call",
            node_id="executor",
            subagent_id="executor",
            message="Executor LLM call completed.",
            step_id=step.id,
            action=step.action,
            prompt_name=prompt_name,
            input_preview=_clip_text(_step_input(step, state)),
            output_preview=_clip_text(result.text),
            provider=result.provider,
            model=result.model,
            prompt_hash=result.prompt_hash,
            latency_ms=result.latency_ms,
            token_count=result.token_count,
            fallback_llm=result.fallback,
            status="success",
        )
        return StepArtifact(
            step_id=step.id,
            action=step.action,
            output=result.text,
            metadata=_metadata(result),
        )

    def _query_codegraph(self, step: PlanStep, state: AgentState) -> StepArtifact:
        """Call CodeGraph and normalize tool failures into graph artifacts."""

        retrieval_request = _retrieval_request_for_step(step)
        profile = retrieval_request["profile"]
        metadata = step.metadata or {}
        report_type = str(metadata.get("report_type") or "").strip().lower()
        try:
            if report_type == "architecture_report" and hasattr(self._codegraph, "architecture_report"):
                result = self._codegraph.architecture_report(
                    step.instruction,
                    database=metadata.get("database"),
                    max_files=_metadata_int(metadata, "max_files", 400),
                    max_symbols=_metadata_int(metadata, "max_symbols", 3000),
                    max_relationship_samples=_metadata_int(
                        metadata,
                        "max_relationship_samples",
                        300,
                    ),
                )
            elif report_type == "workflow_relationship_report" and hasattr(self._codegraph, "workflow_report"):
                result = self._codegraph.workflow_report(
                    step.instruction,
                    database=metadata.get("database"),
                    seed_k=retrieval_request["final_k"],
                    max_depth=_metadata_int(metadata, "max_depth", 4),
                    limit=_metadata_int(metadata, "report_limit", 160),
                )
            elif report_type == "focused_symbol_report" and hasattr(self._codegraph, "focused_report"):
                result = self._codegraph.focused_report(
                    step.instruction,
                    database=metadata.get("database"),
                    seed_k=retrieval_request["final_k"],
                    limit=_metadata_int(metadata, "report_limit", 120),
                )
            elif report_type == "compare_report" and hasattr(self._codegraph, "compare_report"):
                result = self._codegraph.compare_report(
                    step.instruction,
                    database=metadata.get("database"),
                    seed_k=retrieval_request["final_k"],
                    max_depth=_metadata_int(metadata, "max_depth", 3),
                    limit=_metadata_int(metadata, "report_limit", 120),
                )
            elif hasattr(self._codegraph, "retrieve"):
                result = self._codegraph.retrieve(
                    step.instruction,
                    top_k=retrieval_request["final_k"],
                    max_neighbors=retrieval_request["max_neighbors"],
                    profile=profile,
                    candidate_k=retrieval_request["candidate_k"],
                    final_k=retrieval_request["final_k"],
                    node_types=csv_filter(retrieval_request["node_types"]),
                    relationship_types=csv_filter(
                        retrieval_request["expanded_relationship_types"]
                    ),
                )
            else:
                result = self._codegraph.query(step.instruction)
        except Exception as exc:
            record_telemetry_event(
                state,
                kind="tool_call",
                node_id="executor",
                tool_id="codegraph",
                message="CodeGraph tool call failed.",
                tool_call_id=step.id,
                category="tool",
                input_preview=_clip_text(step.instruction),
                output_preview="",
                status="error",
                error=exc.__class__.__name__,
            )
            return StepArtifact(
                step_id=step.id,
                action=step.action,
                output=f"CodeGraph failed: {exc.__class__.__name__}",
                error=exc.__class__.__name__,
                metadata={
                    "tool": "codegraph",
                    "available": False,
                    **_retrieval_metadata(retrieval_request),
                    "report_type": report_type or None,
                },
            )

        if isinstance(result, str):
            record_telemetry_event(
                state,
                kind="tool_call",
                node_id="executor",
                tool_id="codegraph_legacy",
                message="Legacy CodeGraph tool call completed.",
                tool_call_id=step.id,
                category="tool",
                input_preview=_clip_text(step.instruction),
                output_preview=_clip_text(result),
                status="success",
                error="",
            )
            return StepArtifact(
                step_id=step.id,
                action=step.action,
                output=result,
                truncated="truncated=True" in result,
                metadata={
                    "tool": "codegraph_legacy",
                    "available": True,
                    **_retrieval_metadata(retrieval_request),
                    "report_type": report_type or None,
                },
            )

        record_telemetry_event(
            state,
            kind="tool_call",
            node_id="executor",
            tool_id=result.metadata.get("tool", "codegraph"),
            message="CodeGraph tool call completed.",
            tool_call_id=step.id,
            category="tool",
            input_preview=_clip_text(step.instruction),
            output_preview=_clip_text(result.output),
            status=result.status,
            error=result.error or "",
            truncated=result.truncated,
            available=result.available,
            metadata=result.metadata,
        )
        return StepArtifact(
            step_id=step.id,
            action=step.action,
            output=result.output,
            error=result.error,
            truncated=result.truncated,
            metadata={
                **result.metadata,
                **_retrieval_metadata(retrieval_request),
                "report_type": report_type or result.metadata.get("report_type"),
                "status": result.status,
                "available": result.available,
            },
        )



    def _query_project_inventory(self, step: PlanStep, state: AgentState) -> StepArtifact:
        """Call CodeGraph structural inventory and normalize failures."""

        try:
            if hasattr(self._codegraph, "project_inventory"):
                result = self._codegraph.project_inventory()
            else:
                result = self._codegraph.query(step.instruction)
        except Exception as exc:
            record_telemetry_event(
                state,
                kind="tool_call",
                node_id="executor",
                tool_id="codegraph_project_inventory",
                message="CodeGraph project inventory tool call failed.",
                tool_call_id=step.id,
                category="tool",
                input_preview=_clip_text(step.instruction),
                output_preview="",
                status="error",
                error=exc.__class__.__name__,
            )
            return StepArtifact(
                step_id=step.id,
                action=step.action,
                output=f"CodeGraph project inventory failed: {exc.__class__.__name__}",
                error=exc.__class__.__name__,
                metadata={"tool": "codegraph_project_inventory", "available": False},
            )

        if isinstance(result, str):
            record_telemetry_event(
                state,
                kind="tool_call",
                node_id="executor",
                tool_id="codegraph_project_inventory_legacy",
                message="Legacy CodeGraph project inventory tool call completed.",
                tool_call_id=step.id,
                category="tool",
                input_preview=_clip_text(step.instruction),
                output_preview=_clip_text(result),
                status="success",
                error="",
            )
            return StepArtifact(
                step_id=step.id,
                action=step.action,
                output=result,
                truncated="truncated=True" in result,
                metadata={"tool": "codegraph_project_inventory_legacy", "available": True},
            )

        record_telemetry_event(
            state,
            kind="tool_call",
            node_id="executor",
            tool_id=result.metadata.get("tool", "codegraph_project_inventory"),
            message="CodeGraph project inventory tool call completed.",
            tool_call_id=step.id,
            category="tool",
            input_preview=_clip_text(step.instruction),
            output_preview=_clip_text(result.output),
            status=result.status,
            error=result.error or "",
            truncated=result.truncated,
            available=result.available,
            metadata=result.metadata,
        )
        return StepArtifact(
            step_id=step.id,
            action=step.action,
            output=result.output,
            error=result.error,
            truncated=result.truncated,
            metadata={
                **result.metadata,
                "status": result.status,
                "available": result.available,
            },
        )


def validate_execution_dependencies(plan: Plan) -> str | None:
    """Return an error string when step dependencies cannot be executed."""

    step_ids = {step.id for step in plan.steps}
    for step in plan.steps:
        unknown = [dependency for dependency in step.depends_on if dependency not in step_ids]
        if unknown:
            return f"Step {step.id} has unknown dependencies: {', '.join(unknown)}"

    graph = {step.id: set(step.depends_on) for step in plan.steps}
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(step_id: str) -> str | None:
        if step_id in visiting:
            return f"Cyclic dependency detected at {step_id}."
        if step_id in visited:
            return None
        visiting.add(step_id)
        for dependency in graph.get(step_id, set()):
            error = visit(dependency)
            if error:
                return error
        visiting.remove(step_id)
        visited.add(step_id)
        return None

    for step_id in graph:
        error = visit(step_id)
        if error:
            return error
    return None


def _step_input(step: PlanStep, state: AgentState) -> str:
    """Serialize current state into the prompt payload for one executor step."""

    window = state.window
    payload: dict[str, Any] = {
        "user_request": state.user_text,
        "step": step.model_dump(),
        "layered_window": {
            "summary": window.summary if window is not None else None,
            "pinned_facts": window.pinned_facts if window is not None else [],
            "verbatim": [
                {"role": turn.role, "content": turn.content}
                for turn in (window.verbatim[-8:] if window is not None else [])
            ],
        },
        "artifacts": [artifact.model_dump() for artifact in state.scratchpad],
    }
    return json.dumps(payload, ensure_ascii=True)


def _with_timeout(timeout_seconds: float | None, callback):
    """Run blocking model/tool work with an optional per-step timeout."""

    if timeout_seconds is None or timeout_seconds <= 0:
        return callback()

    executor = ThreadPoolExecutor(max_workers=1)
    future = executor.submit(callback)
    try:
        return future.result(timeout=timeout_seconds)
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


def _metadata(result: LLMCallResult) -> dict[str, Any]:
    return {
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




def _retrieval_request_for_step(step: PlanStep) -> dict[str, Any]:
    metadata = step.metadata or {}
    profile = str(metadata.get("retrieval_profile") or "focused").strip().lower()
    return build_profile_request(
        profile,
        requested_candidate_k=metadata.get("candidate_k")
        or metadata.get("requested_candidate_k"),
        requested_final_k=metadata.get("final_k"),
        requested_top_k=metadata.get("top_k") or metadata.get("requested_top_k"),
        requested_max_neighbors=metadata.get("max_neighbors")
        or metadata.get("requested_max_neighbors"),
        node_types=metadata.get("node_types"),
        relationship_types=metadata.get("relationship_types"),
    )


def _metadata_int(metadata: dict[str, Any], key: str, default: int) -> int:
    try:
        return int(metadata.get(key, default))
    except (TypeError, ValueError):
        return default

def _retrieval_metadata(retrieval_request: dict[str, Any]) -> dict[str, Any]:
    return {
        "retrieval_profile": retrieval_request["profile"],
        "top_k": retrieval_request["final_k"],
        "candidate_k": retrieval_request["candidate_k"],
        "final_k": retrieval_request["final_k"],
        "max_neighbors": retrieval_request["max_neighbors"],
        "node_types": retrieval_request["node_types"],
        "relationship_types": retrieval_request["expanded_relationship_types"],
    }


def _build_default_codegraph(settings: Settings) -> CodeGraphQueryTool:
    """Use the real CodeGraph tool when enabled, otherwise deterministic stub."""

    if settings.codegraph_enabled:
        return build_codegraph_tool(settings)
    return CodeGraphStub()

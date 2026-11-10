"""Final answer composer."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import abkb

from chatbot.agent.llm import LangChainLLMClient, load_prompt
from chatbot.agent.state import AgentState, record_telemetry_event
from chatbot.config.settings import Settings, load_settings


class ComposerClient:
    """Turns graph artifacts into the final markdown answer."""

    def __init__(
        self,
        llm: LangChainLLMClient | None = None,
        settings: Settings | None = None,
    ) -> None:
        self._settings = settings or load_settings()
        self._llm = llm or LangChainLLMClient(self._settings)

    def compose(self, state: AgentState) -> str:
        """Prefer early clarification responses, otherwise call the composer."""

        if state.response_md:
            record_telemetry_event(
                state,
                kind="subagent_call",
                node_id="composer",
                subagent_id="composer",
                message="Composer reused existing response.",
                status="skipped",
                output_preview=_clip_text(state.response_md),
            )
            return state.response_md

        prompt_input = _composer_input(state)
        system_prompt = abkb.compose_prompt(
            load_prompt("composer"),
            agent_id="composer",
            node_id="composer",
            tool_ids=("codegraph",),
        )
        result = self._llm.invoke(
            "composer",
            prompt_input,
            system_prompt=system_prompt,
        )
        record_telemetry_event(
            state,
            kind="subagent_call",
            node_id="composer",
            subagent_id="composer",
            message="Composer LLM call completed.",
            prompt_name="composer",
            input_preview=_clip_text(prompt_input),
            output_preview=_clip_text(result.text),
            provider=result.provider,
            model=result.model,
            prompt_hash=result.prompt_hash,
            latency_ms=result.latency_ms,
            token_count=result.token_count,
            fallback_llm=result.fallback,
            status="success",
        )
        state.metrics["composer"] = {
            "provider": result.provider,
            "model": result.model,
            "prompt_hash": result.prompt_hash,
            "latency_ms": result.latency_ms,
            "token_count": result.token_count,
            "fallback_llm": result.fallback,
        }
        answer = result.text.strip()
        if not answer:
            answer = _fallback_answer(state)
        answer = _apply_codegraph_note(state, answer)
        return answer

    def stream(self, state: AgentState) -> Iterator[str]:
        """Yield final-answer text deltas and preserve compose fallback behavior."""

        if state.response_md:
            record_telemetry_event(
                state,
                kind="subagent_call",
                node_id="composer",
                subagent_id="composer",
                message="Composer stream reused existing response.",
                status="skipped",
                output_preview=_clip_text(state.response_md),
            )
            yield state.response_md
            return

        answer_parts: list[str] = []
        emitted_text = False
        prompt_input = _composer_input(state)
        system_prompt = abkb.compose_prompt(
            load_prompt("composer"),
            agent_id="composer",
            node_id="composer",
            tool_ids=("codegraph",),
        )
        for chunk in self._llm.stream(
            "composer",
            prompt_input,
            system_prompt=system_prompt,
        ):
            if not chunk:
                continue
            answer_parts.append(chunk)
            emitted_text = emitted_text or bool(chunk.strip())

        answer = "".join(answer_parts).strip()
        fallback_used = (not emitted_text) or _looks_like_llm_local_fallback(answer)
        if fallback_used:
            answer = _fallback_answer(state)
            emitted_text = bool(answer.strip())

        record_telemetry_event(
            state,
            kind="subagent_call",
            node_id="composer",
            subagent_id="composer",
            message="Composer streaming LLM call completed.",
            prompt_name="composer",
            input_preview=_clip_text(prompt_input),
            output_preview=_clip_text(answer),
            status="fallback" if fallback_used else "success",
        )
        if not emitted_text:
            yield _apply_codegraph_note(state, _fallback_answer(state))
            return

        yield _apply_codegraph_note(state, answer)


def _composer_input(state: AgentState) -> str:
    """Serialize bounded history, plan, artifacts, critique, and errors."""

    window = state.window
    payload: dict[str, Any] = {
        "user_request": state.user_text,
        "layered_window": {
            "summary": window.summary if window is not None else None,
            "pinned_facts": window.pinned_facts if window is not None else [],
            "verbatim": [
                {"role": turn.role, "content": turn.content}
                for turn in (window.verbatim[-8:] if window is not None else [])
            ],
        },
        "plan": state.plan.model_dump() if state.plan is not None else None,
        "artifacts": [artifact.model_dump() for artifact in state.scratchpad],
        "critique": {
            "complete": state.critique_complete,
            "confidence": state.critique_confidence,
            "missing": state.critique_missing,
        },
        "errors": state.errors,
    }
    return json.dumps(payload, ensure_ascii=True)


def _fallback_answer(state: AgentState) -> str:
    """Build a readable answer when the composer cannot use the live LLM."""

    preferred_artifacts = [
        artifact
        for artifact in state.scratchpad
        if artifact.action in {"query_codegraph", "query_project_inventory"}
        and not artifact.error
        and str(artifact.output or "").strip()
    ]
    if preferred_artifacts:
        sections = [
            "The final answer LLM timed out, so I am returning the collected CodeGraph evidence directly.",
        ]
        for artifact in preferred_artifacts[:3]:
            tool = artifact.metadata.get("tool") or artifact.action
            report_type = artifact.metadata.get("report_type")
            title_parts = [str(tool)]
            if report_type:
                title_parts.append(str(report_type))
            sections.append(f"**Evidence From {' / '.join(title_parts)}**")
            sections.append(_bounded_artifact_output(artifact.output))
        return "\n\n".join(sections)

    artifact_text = "\n".join(
        f"- `{artifact.action}` ({artifact.step_id}): {artifact.output}"
        for artifact in state.scratchpad
    )
    critique = (
        f"Critique confidence: {state.critique_confidence}"
        if state.critique_confidence is not None
        else "Critique confidence: unavailable"
    )
    return (
        f"{critique}\n\n"
        "I used the available layered history and execution artifacts to answer "
        "within the current workflow limits.\n\n"
        f"{artifact_text or 'No execution artifacts were available.'}"
    )


def _looks_like_llm_local_fallback(answer: str) -> bool:
    normalized = " ".join(str(answer or "").strip().lower().split())
    return normalized.startswith(
        "i processed this through the cognition path using the available layered window"
    )


def _bounded_artifact_output(output: str, limit: int = 30000) -> str:
    rendered = str(output or "").strip()
    if len(rendered) <= limit:
        return rendered
    return rendered[:limit].rstrip() + f"\n[Artifact output truncated by fallback at {limit} characters]"

def _uses_codegraph(state: AgentState) -> bool:
    """Return whether the plan attempted code retrieval."""

    if state.plan is None:
        return False
    return any(step.action == "query_codegraph" for step in state.plan.steps)


def _apply_codegraph_note(state: AgentState, answer: str) -> str:
    """Add retrieval caveats when CodeGraph was stubbed or unavailable."""

    note = _codegraph_note(state, answer)
    if note:
        return f"{answer}{note}"
    return answer


def _codegraph_note(state: AgentState, answer: str) -> str:
    """Return a retrieval caveat suffix for answers that need one."""

    if not _uses_codegraph(state):
        return ""

    codegraph_artifacts = [
        artifact
        for artifact in state.scratchpad
        if artifact.action == "query_codegraph"
    ]
    if not codegraph_artifacts:
        return (
            "\n\n"
            "Note: No CodeGraph retrieval artifact was available for this answer."
        )

    if any(artifact.metadata.get("tool") == "codegraph_stub" for artifact in codegraph_artifacts):
        if "codegraph stub" in answer.lower():
            return ""
        return (
            "\n\n"
            "Note: CodeGraph is running in stub mode, so code location details "
            "should be treated as provisional."
        )

    unavailable = [
        artifact
        for artifact in codegraph_artifacts
        if artifact.metadata.get("available") is False or artifact.error
    ]
    if unavailable and "codegraph" not in answer.lower():
        return (
            "\n\n"
            "Note: CodeGraph retrieval was unavailable or incomplete for this "
            "answer."
        )
    return ""


def _clip_text(text: Any, limit: int = 4000) -> str:
    rendered = "" if text is None else str(text)
    if len(rendered) <= limit:
        return rendered
    return rendered[:limit].rstrip() + f"\n[truncated {len(rendered) - limit} chars]"

"""Fast-path answer composer for cheap non-task turns."""

from __future__ import annotations

import json
from collections.abc import Iterator

import abkb

from chatbot.agent.llm import LangChainLLMClient, load_prompt
from chatbot.agent.state import TriageDecision
from chatbot.config.settings import Settings, load_settings


class FastPathComposer:
    """Single-call LangChain composer for smalltalk/meta/clarification turns.

    Cache hits are intentionally not sent back through the model; they replay the
    previous assistant answer so a cache hit remains exact and cheap.
    """

    def __init__(
        self,
        llm: LangChainLLMClient | None = None,
        settings: Settings | None = None,
    ) -> None:
        self._settings = settings or load_settings()
        self._llm = llm or LangChainLLMClient(self._settings)

    def compose(self, user_text: str, decision: TriageDecision) -> str:
        if decision.triage_class == "cache_hit" and decision.cached_answer:
            return f"From the recent conversation: {decision.cached_answer}"

        system_prompt = abkb.compose_prompt(
            load_prompt("fast_path"),
            agent_id="fast_path",
            node_id="fast_path",
        )
        result = self._llm.invoke(
            "fast_path",
            json.dumps(
                {
                    "user_text": user_text,
                    "triage_class": decision.triage_class,
                    "triage_reason": decision.reason,
                },
                ensure_ascii=True,
            ),
            system_prompt=system_prompt,
        )
        answer = result.text.strip()
        if answer:
            return answer

        if decision.triage_class == "meta":
            return (
                "I am the local codebase chatbot. I can help explain project "
                "structure, summarize files, and route deeper code questions "
                "through the agent workflow as it is added."
            )

        if decision.triage_class == "clarification":
            return (
                "I can clarify, but I need the specific previous point you want "
                "to revisit. Please mention the file, function, or answer section."
            )

        return "Hi. Ask me about this codebase whenever you are ready."

    def stream(self, user_text: str, decision: TriageDecision) -> Iterator[str]:
        if decision.triage_class == "cache_hit" and decision.cached_answer:
            yield f"From the recent conversation: {decision.cached_answer}"
            return

        payload = json.dumps(
            {
                "user_text": user_text,
                "triage_class": decision.triage_class,
                "triage_reason": decision.reason,
            },
            ensure_ascii=True,
        )
        emitted_text = False
        system_prompt = abkb.compose_prompt(
            load_prompt("fast_path"),
            agent_id="fast_path",
            node_id="fast_path",
        )
        for chunk in self._llm.stream(
            "fast_path",
            payload,
            system_prompt=system_prompt,
        ):
            if not chunk:
                continue
            emitted_text = emitted_text or bool(chunk.strip())
            yield chunk
        if not emitted_text:
            yield self.compose(user_text, decision)

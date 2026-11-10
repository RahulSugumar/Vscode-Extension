"""Rules-first triage boundary for cheap path selection."""

from __future__ import annotations

import re
from typing import Protocol

from chatbot.agent.state import TriageDecision
from chatbot.history.protocol import ChatHistoryClient
from chatbot.history.utils import normalize_for_match


class LightClassifier(Protocol):
    """Optional LangChain-backed classifier boundary for later phases."""

    def classify(self, text: str) -> str:
        ...


SMALLTALK_RE = re.compile(
    r"^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|cool|great)[.! ]*$",
    re.IGNORECASE,
)
META_RE = re.compile(
    r"\b(who are you|what can you do|help me|your capabilities|about yourself)\b",
    re.IGNORECASE,
)
CLARIFICATION_RE = re.compile(
    r"\b(explain that|what do you mean|can you clarify|say more|elaborate)\b",
    re.IGNORECASE,
)
TASK_CUE_RE = re.compile(
    r"\b("
    r"summarize|repository|repo|code|file|function|class|api|fastapi|"
    r"langgraph|streamlit|bug|implement|build|explain|where|how|why|"
    r"module|service|controller|endpoint|route|handler|workflow|flow|"
    r"dependency|dependencies|relation|relations|relationship|relationships"
    r")\b",
    re.IGNORECASE,
)
CURRENT_GRAPH_CUE_RE = re.compile(
    r"\b("
    r"project|codebase|repository|repo|code|file|function|class|method|api|"
    r"module|service|controller|endpoint|route|handler|workflow|flow|"
    r"dependency|dependencies|relation|relations|relationship|relationships|"
    r"caller|callee|callers|callees|import|imports|implementation|logic|"
    r"architecture|model|database|symbol"
    r")\b",
    re.IGNORECASE,
)


class TriageEngine:
    """Classifies each request before any expensive agent work begins."""

    def __init__(
        self,
        history_client: ChatHistoryClient,
        classifier: LightClassifier | None = None,
    ) -> None:
        self._history = history_client
        self._classifier = classifier

    def decide(self, user_id: str, session_id: str, text: str) -> TriageDecision:
        """Return the cheapest safe path for the current user turn."""

        normalized = normalize_for_match(text)
        # Cache hits are only safe for non-project turns. Code/project answers
        # can go stale after graph updates, so they must use the full path.
        if not needs_current_graph_evidence(normalized):
            try:
                cached_answer = self._history.find_cache_hit(user_id, session_id, normalized)
            except Exception:
                cached_answer = None
            if cached_answer is not None:
                return TriageDecision(
                    triage_class="cache_hit",
                    path="fast",
                    cached_answer=cached_answer,
                    reason="recent identical prompt",
                )

        # Short code questions like "where is API?" are common, so task cues get
        # first chance before explicit smalltalk handling.
        if TASK_CUE_RE.search(normalized):
            return TriageDecision(triage_class="task", path="full", reason="task cue")

        if SMALLTALK_RE.match(normalized):
            return TriageDecision(
                triage_class="smalltalk",
                path="fast",
                reason="smalltalk rule",
            )

        if META_RE.search(normalized):
            return TriageDecision(
                triage_class="meta",
                path="fast",
                reason="meta rule",
            )

        if CLARIFICATION_RE.search(normalized):
            return TriageDecision(
                triage_class="clarification",
                path="fast",
                reason="clarification rule",
            )

        if self._classifier is not None:
            try:
                triage_class = self._classifier.classify(text)
            except TimeoutError:
                # The base design says uncertainty or timeout must escalate to
                # the full path rather than guessing a cheap response.
                triage_class = "task"
            if triage_class in {"smalltalk", "meta", "clarification"}:
                return TriageDecision(
                    triage_class=triage_class,
                    path="fast",
                    reason="classifier",
                )

        return TriageDecision(triage_class="task", path="full", reason="default")


def needs_current_graph_evidence(text: str) -> bool:
    """Return True when a turn should not be answered from a cached response."""

    return bool(CURRENT_GRAPH_CUE_RE.search(text))

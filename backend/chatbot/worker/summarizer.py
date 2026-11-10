"""Background rolling-summary refresh for Phase C."""

from __future__ import annotations

import json
import logging
import re
from collections import deque
from threading import Lock, Thread
from typing import Any

import abkb
from pydantic import BaseModel, Field, ValidationError

from chatbot.agent.llm import LangChainLLMClient, load_prompt
from chatbot.config.settings import Settings, load_settings
from chatbot.history.protocol import ChatHistoryClient


logger = logging.getLogger(__name__)


class SummaryRefresh(BaseModel):
    """LLM-produced memory update for one chat session."""

    summary: str
    pinned_facts: list[str] = Field(default_factory=list)


class SummaryRefreshQueue:
    """Small in-process queue; production can replace this boundary later."""

    def __init__(
        self,
        history_client: ChatHistoryClient,
        llm: LangChainLLMClient | None = None,
        settings: Settings | None = None,
        auto_start: bool = True,
    ) -> None:
        self._history = history_client
        self._settings = settings or load_settings()
        self._llm = llm or LangChainLLMClient(self._settings)
        self._auto_start = auto_start
        self._queue: deque[tuple[str, str]] = deque()
        self._lock = Lock()
        self._running = False
        self.counters: dict[str, int] = {
            "enqueued": 0,
            "completed": 0,
            "failed": 0,
        }

    def enqueue_summary_refresh(self, user_id: str, session_id: str) -> None:
        """Queue a summary refresh without blocking the chat response path."""

        if not self._settings.summarizer_enabled:
            return
        with self._lock:
            self._queue.append((user_id, session_id))
            self.counters["enqueued"] += 1
            should_start = self._auto_start and not self._running
            if should_start:
                self._running = True
        if should_start:
            thread = Thread(target=self._drain_background, daemon=True)
            thread.start()

    def drain_once(self) -> bool:
        """Process one queued session; tests call this for deterministic runs."""

        with self._lock:
            if not self._queue:
                return False
            user_id, session_id = self._queue.popleft()
        try:
            refresh = self._summarize(user_id, session_id)
            self._history.update_summary(
                user_id,
                session_id,
                refresh.summary,
                metadata={"source": "phase_c_summarizer"},
            )
            current_facts = set(
                self._history.get_window(user_id, session_id).pinned_facts
            )
            for fact in refresh.pinned_facts:
                clean_fact = fact.strip()
                if clean_fact and clean_fact not in current_facts:
                    self._history.pin_fact(
                        user_id,
                        session_id,
                        clean_fact,
                        metadata={"source": "phase_c_summarizer"},
                    )
                    current_facts.add(clean_fact)
            self.counters["completed"] += 1
            logger.info(
                "summarizer_complete",
                extra={
                    "phase": "summarizer",
                    "user_id": user_id,
                    "session_id": session_id,
                    "outcome": "ok",
                },
            )
            return True
        except Exception as exc:
            self.counters["failed"] += 1
            logger.warning(
                "summarizer_failed",
                extra={
                    "phase": "summarizer",
                    "user_id": user_id,
                    "session_id": session_id,
                    "detail": exc.__class__.__name__,
                    "outcome": "failed",
                },
            )
            return False

    def _drain_background(self) -> None:
        """Drain queued work on a daemon thread and restart if new work arrived."""

        try:
            while self.drain_once():
                pass
        finally:
            with self._lock:
                self._running = False
                should_restart = bool(self._queue)
                if should_restart:
                    self._running = True
            if should_restart:
                Thread(target=self._drain_background, daemon=True).start()

    def _summarize(self, user_id: str, session_id: str) -> SummaryRefresh:
        """Ask the summarizer prompt to compress recent turns into memory."""

        window = self._history.get_window(user_id, session_id)
        payload: dict[str, Any] = {
            "summary": window.summary,
            "pinned_facts": window.pinned_facts,
            "verbatim": [
                {"role": turn.role, "content": turn.content}
                for turn in window.verbatim[-10:]
            ],
        }
        system_prompt = abkb.compose_prompt(
            load_prompt("summarizer"),
            agent_id="summarizer",
            node_id="summarizer",
        )
        result = self._llm.invoke(
            "summarizer",
            json.dumps(payload, ensure_ascii=True),
            system_prompt=system_prompt,
        )
        try:
            return parse_summary_json(result.text)
        except (ValueError, ValidationError):
            return SummaryRefresh(
                summary=_fallback_summary(window.verbatim),
                pinned_facts=[],
            )


def parse_summary_json(text: str) -> SummaryRefresh:
    """Parse summarizer JSON from raw or fenced model output."""

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
        raise ValueError("summary JSON is not an object")
    return SummaryRefresh.model_validate(loaded)


def _fallback_summary(turns) -> str:
    """Keep memory useful even when summarizer JSON is malformed."""

    recent = [turn.content for turn in turns[-4:]]
    if not recent:
        return "No durable session details have been summarized yet."
    return "Recent session context: " + " | ".join(recent)[:400]

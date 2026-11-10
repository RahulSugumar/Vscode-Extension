"""LangChain chat-model boundary for Phase C cognition."""

from __future__ import annotations

import hashlib
import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from collections.abc import Iterator
from typing import Any, Protocol

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage

from chatbot.config.settings import Settings, load_settings


logger = logging.getLogger(__name__)


class ChatModel(Protocol):
    """Small subset of LangChain chat models used by this project."""

    def invoke(self, messages: list[BaseMessage]) -> Any:
        ...

    def stream(self, messages: list[BaseMessage]) -> Iterator[Any]:
        ...


@dataclass(frozen=True)
class LLMCallResult:
    """Normalized model response plus operational metadata for logs/tests."""

    text: str
    provider: str
    model: str
    prompt_hash: str
    latency_ms: int
    token_count: int | None = None
    fallback: bool = False


class LangChainLLMClient:
    """Provider-neutral wrapper used by all Phase C cognition modules.

    The rest of the agent depends on LangChain-style chat models through this
    class, not on OpenAI SDK types. Today `_build_model` wires OpenAI because the
    configured runtime key is OpenAI, but adding another provider should stay
    contained to this file.
    """

    def __init__(
        self,
        settings: Settings | None = None,
        chat_model: ChatModel | None = None,
    ) -> None:
        self._settings = settings or load_settings()
        self._chat_model = chat_model if chat_model is not None else self._build_model()

    @property
    def provider(self) -> str:
        return self._settings.llm_provider

    @property
    def model(self) -> str:
        return self._settings.llm_model

    def invoke(
        self,
        prompt_name: str,
        user_content: str,
        variables: dict[str, Any] | None = None,
        system_prompt: str | None = None,
    ) -> LLMCallResult:
        system_prompt = system_prompt or load_prompt(prompt_name, variables or {})
        prompt_hash = _hash_text(system_prompt)
        started = time.perf_counter()

        # Missing provider packages, missing credentials, test runs, and
        # intentionally local development all converge here. The caller still
        # receives a typed result, so planner/executor/critic/composer fallback
        # behavior is exercised without a network dependency.
        if self._chat_model is None:
            text = _local_response(prompt_name, user_content)
            return LLMCallResult(
                text=text,
                provider="local",
                model="local-deterministic",
                prompt_hash=prompt_hash,
                latency_ms=_elapsed_ms(started),
                fallback=True,
            )

        messages = [
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_content),
        ]
        try:
            response = self._chat_model.invoke(messages)
        except Exception as exc:
            # A model outage should degrade a single chat turn, not crash the
            # FastAPI request or poison the graph state.
            logger.warning(
                "llm_call_failed",
                extra={
                    "phase": prompt_name,
                    "backend": self._settings.llm_provider,
                    "detail": exc.__class__.__name__,
                    "outcome": "fallback",
                },
            )
            text = _local_response(prompt_name, user_content)
            return LLMCallResult(
                text=text,
                provider="local",
                model="local-deterministic",
                prompt_hash=prompt_hash,
                latency_ms=_elapsed_ms(started),
                fallback=True,
            )

        text = _response_text(response)
        token_count = _token_count(response)
        return LLMCallResult(
            text=text,
            provider=self._settings.llm_provider,
            model=self._settings.llm_model,
            prompt_hash=prompt_hash,
            latency_ms=_elapsed_ms(started),
            token_count=token_count,
        )

    def stream(
        self,
        prompt_name: str,
        user_content: str,
        variables: dict[str, Any] | None = None,
        system_prompt: str | None = None,
    ) -> Iterator[str]:
        """Yield text deltas from the configured chat model when available."""

        system_prompt = system_prompt or load_prompt(prompt_name, variables or {})
        messages = [
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_content),
        ]

        if self._chat_model is None or not hasattr(self._chat_model, "stream"):
            yield from _chunk_text(_local_response(prompt_name, user_content))
            return

        try:
            for chunk in self._chat_model.stream(messages):
                text = _stream_chunk_text(chunk)
                if text:
                    yield text
        except Exception as exc:
            logger.warning(
                "llm_stream_failed",
                extra={
                    "phase": prompt_name,
                    "backend": self._settings.llm_provider,
                    "detail": exc.__class__.__name__,
                    "outcome": "fallback",
                },
            )
            yield from _chunk_text(_local_response(prompt_name, user_content))

    def _build_model(self) -> ChatModel | None:
        # `local` is a first-class dev/test mode. It avoids noisy warnings and
        # keeps unit tests independent of credentials.
        if self._settings.llm_provider == "local":
            return None
        if self._settings.llm_provider != "openai":
            logger.warning(
                "llm_provider_unsupported",
                extra={"backend": self._settings.llm_provider, "outcome": "fallback"},
            )
            return None
        if (
            not self._settings.openai_api_key
            or not self._settings.llm_model
            or self._settings.llm_model == "local-deterministic"
        ):
            logger.warning(
                "llm_openai_not_configured",
                extra={"backend": "openai", "outcome": "fallback"},
            )
            return None

        try:
            # Keep provider-specific dependencies lazy so the app can still
            # import and run deterministic tests when optional packages are not
            # installed.
            from langchain_openai import ChatOpenAI
        except ImportError:
            logger.warning(
                "llm_openai_package_missing",
                extra={"backend": "openai", "outcome": "fallback"},
            )
            return None

        kwargs: dict[str, Any] = {
            "model": self._settings.llm_model,
            "temperature": self._settings.llm_temperature,
        }
        if self._settings.llm_timeout_seconds is not None:
            kwargs["timeout"] = self._settings.llm_timeout_seconds
        return ChatOpenAI(**kwargs)


def load_prompt(prompt_name: str, variables: dict[str, Any] | None = None) -> str:
    """Load a prompt asset and apply simple placeholder substitution."""

    prompt_path = Path(__file__).resolve().parent.parent / "prompts" / f"{prompt_name}.md"
    prompt = prompt_path.read_text(encoding="utf-8")
    for key, value in (variables or {}).items():
        prompt = prompt.replace("{" + key + "}", str(value))
    return prompt


def _response_text(response: Any) -> str:
    """Normalize LangChain message/content variants into plain text."""

    content = getattr(response, "content", response)
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(parts).strip()
    return str(content).strip()


def _stream_chunk_text(response: Any) -> str:
    """Normalize streamed message chunks without trimming meaningful spaces."""

    content = getattr(response, "content", response)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
            elif isinstance(item, str):
                parts.append(item)
        return "".join(parts)
    return str(content)


def _token_count(response: Any) -> int | None:
    """Best-effort token usage extraction across LangChain provider metadata."""

    usage = getattr(response, "usage_metadata", None)
    if not isinstance(usage, dict):
        metadata = getattr(response, "response_metadata", None)
        usage = metadata.get("token_usage") if isinstance(metadata, dict) else None
    if not isinstance(usage, dict):
        return None
    values = [
        usage.get("total_tokens"),
        usage.get("input_tokens"),
        usage.get("output_tokens"),
        usage.get("prompt_tokens"),
        usage.get("completion_tokens"),
    ]
    numeric = [value for value in values if isinstance(value, int)]
    return max(numeric) if numeric else None


def _hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _elapsed_ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


def _chunk_text(text: str, chunk_size: int = 48) -> Iterator[str]:
    size = max(1, chunk_size)
    for index in range(0, len(text), size):
        chunk = text[index : index + size]
        if chunk:
            yield chunk


def _local_response(prompt_name: str, user_content: str) -> str:
    """Deterministic fallback responses used when no live model is available."""

    if prompt_name == "planner":
        return json.dumps(
            {
                "steps": [
                    {
                        "id": "step-1",
                        "action": "reason",
                        "instruction": "Provide a bounded answer from available context.",
                        "depends_on": [],
                    }
                ]
            }
        )
    if prompt_name == "critic":
        return json.dumps(
            {
                "complete": True,
                "confidence": 0.82,
                "missing": None,
                "follow_up_instruction": None,
            }
        )
    if prompt_name == "summarizer":
        return json.dumps(
            {
                "summary": "Recent conversation involved the codebase chatbot workflow.",
                "pinned_facts": [],
            }
        )
    if prompt_name == "fast_path":
        return (
            "Hi. I can help with this codebase. Ask me a quick question or give "
            "me a task to route through the deeper workflow."
        )
    if prompt_name == "composer":
        return (
            "I processed this through the cognition path using the available "
            "layered window and execution artifacts. CodeGraph evidence may be "
            "incomplete if retrieval was unavailable or returned limited context."
        )
    return (
        "The available context supports a bounded answer, but evidence may be "
        "incomplete because real CodeGraph integration is planned for Phase D."
    )

"""Request-level hardening helpers for API routes."""

from __future__ import annotations

from pydantic import BaseModel


class GuardrailDecision(BaseModel):
    """Structured result for a request guardrail check."""

    allowed: bool
    reason: str | None = None
    actual_chars: int = 0
    max_chars: int = 0


def validate_request_size(text: str, max_chars: int) -> GuardrailDecision:
    # Clamp invalid env values to one character so the guard always has a real
    # enforcement boundary and never silently disables itself.
    limit = max(1, max_chars)
    actual = len(text)
    if actual > limit:
        return GuardrailDecision(
            allowed=False,
            reason="request_text_too_large",
            actual_chars=actual,
            max_chars=limit,
        )
    return GuardrailDecision(
        allowed=True,
        actual_chars=actual,
        max_chars=limit,
    )


def oversized_request_detail(decision: GuardrailDecision) -> dict[str, int | str | None]:
    """Return a stable HTTP 400 body for clients and tests."""

    return {
        "error": decision.reason,
        "actual_chars": decision.actual_chars,
        "max_chars": decision.max_chars,
    }

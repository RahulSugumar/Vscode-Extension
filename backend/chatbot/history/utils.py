"""Small shared helpers for history implementations."""

from __future__ import annotations


def normalize_for_match(text: str) -> str:
    """Canonicalize prompts for simple recent-cache comparisons."""

    return " ".join(text.strip().lower().split())

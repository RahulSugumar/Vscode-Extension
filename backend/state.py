"""
Shared in-process state for the Agent Improvement Plane backend.

Currently just the suggestion cache:
- Written by /judge/suggestions when suggestions are generated
- Read by /abkb/accept to resolve a suggestion id -> full PolicyPayload
"""
from __future__ import annotations
from typing import Dict

from models import PolicyPayload

SUGGESTION_CACHE: Dict[str, PolicyPayload] = {}
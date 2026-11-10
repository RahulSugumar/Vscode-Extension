"""
Pydantic schemas for the Agent Improvement Plane.

The `PolicyPayload` model matches the exact contract:
    {
        "workflow_id": ...,
        "policy": "...",
        "scope_type": "global" | "agent" | "tool",
        "scope_id": ... (required unless scope_type == "global"),
        "metadata": {...}   (optional)
    }
"""
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional, Union
from pydantic import BaseModel, Field, field_validator, model_validator
import uuid


ScopeType = Literal["global", "agent", "tool"]
PolicyOrigin = Literal["judge_suggestion", "user_custom"]


# ---------------------------------------------------------------------------
# Core policy payload — matches the shape you specified
# ---------------------------------------------------------------------------

class PolicyPayload(BaseModel):
    workflow_id: str
    policy: str  # single-line policy text (BRD FR-9)
    scope_type: ScopeType
    # scope_id is a string for agent/tool, or a list of strings for multi-tool
    scope_id: Optional[Union[str, List[str]]] = None
    metadata: Optional[Dict[str, Any]] = None

    @field_validator("policy")
    @classmethod
    def _single_line(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Policy text cannot be empty.")
        if "\n" in v:
            # BRD FR-9: v1 supports single-line policies only
            v = v.replace("\n", " ").strip()
        return v

    @model_validator(mode="after")
    def _scope_id_required_for_non_global(self) -> "PolicyPayload":
        if self.scope_type in ("agent", "tool") and not self.scope_id:
            raise ValueError(
                f"scope_id is required when scope_type is '{self.scope_type}'."
            )
        if self.scope_type == "global" and self.scope_id is not None:
            # Silently drop scope_id for global policies
            self.scope_id = None
        return self


class StoredPolicy(PolicyPayload):
    """A policy after it's been stored in ABKB. Adds metadata."""
    id: str = Field(default_factory=lambda: f"pol_{uuid.uuid4().hex[:12]}")
    origin: PolicyOrigin
    source_suggestion_id: Optional[str] = None
    timestamp: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    reviewer: Optional[str] = "local-user"
    active: bool = True


# ---------------------------------------------------------------------------
# ABKB file shape (what gets written to .abkb/policies.json)
# ---------------------------------------------------------------------------

class ABKBFile(BaseModel):
    version: str = "1.0"
    workflow_id: str = "vscode-codegraph-chatbot"
    policies: List[StoredPolicy] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Judge suggestion shape (what the frontend receives)
# ---------------------------------------------------------------------------

class Suggestion(BaseModel):
    """One suggestion returned to the frontend. Includes the exact
    policy_payload that will be persisted if the user clicks Accept."""
    id: str = Field(default_factory=lambda: f"sug_{uuid.uuid4().hex[:12]}")
    title: str
    description: str
    steps: List[str] = Field(default_factory=list)
    policy_payload: PolicyPayload


# ---------------------------------------------------------------------------
# HTTP request / response bodies
# ---------------------------------------------------------------------------

class SuggestionsRequest(BaseModel):
    sessionId: Optional[str] = None
    workflow_id: Optional[str] = None
    workflow_input: Optional[str] = None
    telemetry: Optional[Dict[str, Any]] = None
    workflow_output: Optional[str] = None


class SuggestionsResponse(BaseModel):
    suggestions: List[Suggestion]


class AcceptPolicyRequest(BaseModel):
    """Frontend sends only `policyId` (which is actually a suggestion id).
    The backend resolves it to the full policy_payload from the cache."""
    policyId: str
    reviewer: Optional[str] = "local-user"


class CustomPolicyRequest(BaseModel):
    """Full policy_payload authored by the user."""
    payload: PolicyPayload
    reviewer: Optional[str] = "local-user"


class PolicyOpResponse(BaseModel):
    ok: bool
    policy: Optional[StoredPolicy] = None


class ListPoliciesResponse(BaseModel):
    policies: List[StoredPolicy]

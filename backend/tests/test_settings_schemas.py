from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from chatbot.api.guards import oversized_request_detail, validate_request_size
from chatbot.api.schemas import ChatRequest as ApiChatRequest
from chatbot.api.sse import error_event, format_sse, iter_answer_events
from chatbot.agent.state import AgentResult
from chatbot.config import settings
from graphrag_agent.schemas.patch_schemas import (
    DeltaBatchPayload,
    DeltaBatchTotals,
    GraphDeltaPayload,
    GraphEdgePayload,
    GraphNodePayload,
    PatchApplyStats,
    PatchResponse,
    SourceRangePayload,
)
from graphrag_agent.schemas.requests import ChatRequest, SeedRequest
from graphrag_agent.schemas.responses import RetrievalResponse


def test_settings_helpers_parse_valid_and_invalid_environment(monkeypatch) -> None:
    monkeypatch.setenv("COUNT", "12")
    monkeypatch.setenv("BAD_COUNT", "abc")
    monkeypatch.setenv("TIMEOUT", "2.5")
    monkeypatch.setenv("ZERO", "0")
    monkeypatch.setenv("FLOAT", "0.25")
    monkeypatch.setenv("BOOL", "YeS")
    monkeypatch.setenv("EMPTY", "   ")
    assert settings._int_env("COUNT", 3) == 12
    assert settings._int_env("BAD_COUNT", 3) == 3
    assert settings._int_env("MISSING", 3) == 3
    assert settings._optional_positive_float_env("TIMEOUT") == 2.5
    assert settings._optional_positive_float_env("ZERO") is None
    assert settings._optional_positive_float_env("BAD_COUNT") is None
    assert settings._float_env("FLOAT", 1.0) == 0.25
    assert settings._float_env("BAD_COUNT", 1.0) == 1.0
    assert settings._bool_env("BOOL", False) is True
    assert settings._bool_env("MISSING", True) is True
    assert settings._optional_env("EMPTY") is None


def test_dotenv_loader_preserves_existing_values(monkeypatch, tmp_path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text(
        "# comment\nEXISTING=from-file\nNEW_VALUE='hello world'\nINVALID\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("EXISTING", "from-process")
    monkeypatch.delenv("NEW_VALUE", raising=False)
    settings._load_dotenv(str(env_file))
    assert settings.os.environ["EXISTING"] == "from-process"
    assert settings.os.environ["NEW_VALUE"] == "hello world"
    assert settings._dotenv_candidates(str(env_file)) == [env_file]


def test_load_settings_builds_typed_configuration(monkeypatch) -> None:
    monkeypatch.setattr(settings, "_load_dotenv", lambda: None)
    monkeypatch.setenv("HISTORY_BACKEND", " SQLITE ")
    monkeypatch.setenv("LLM_PROVIDER", " OPENAI ")
    monkeypatch.setenv("LLM_MODEL", " ")
    monkeypatch.setenv("OPENAI_API_KEY", "  secret ")
    monkeypatch.setenv("CHAT_STREAMING_ENABLED", "off")
    monkeypatch.setenv("CODEGRAPH_TOP_K", "9")
    loaded = settings.load_settings()
    assert loaded.history_backend == "sqlite"
    assert loaded.llm_provider == "openai"
    assert loaded.llm_model == "local-deterministic"
    assert loaded.openai_api_key == "secret"
    assert loaded.chat_streaming_enabled is False
    assert loaded.codegraph_top_k == 9


def test_guardrails_clamp_limits_and_report_details() -> None:
    allowed = validate_request_size("abc", 3)
    rejected = validate_request_size("ab", 0)
    assert allowed.allowed is True
    assert allowed.max_chars == 3
    assert rejected.allowed is False
    assert oversized_request_detail(rejected) == {
        "error": "request_text_too_large",
        "actual_chars": 2,
        "max_chars": 1,
    }


def test_sse_helpers_emit_start_chunks_done_and_error() -> None:
    result = AgentResult(answer="abcde", path="full", triage_class="task")
    frames = list(iter_answer_events(result, chunk_size=2))
    assert [frame.splitlines()[0] for frame in frames] == [
        "event: start",
        "event: chunk",
        "event: chunk",
        "event: chunk",
        "event: done",
    ]
    assert '"text": "ab"' in frames[1]
    assert list(iter_answer_events(result, chunk_size=0, include_start=False))[0].startswith("event: chunk")
    assert error_event("boom") == format_sse("error", {"error": "boom"})
    payload = json.loads(format_sse("event", {"snowman": "☃"}).split("data: ", 1)[1])
    assert payload == {"snowman": "☃"}


def test_api_and_graph_schemas_validate_and_default() -> None:
    assert ApiChatRequest(text="hello").user_id == "local-user"
    with pytest.raises(ValidationError):
        ApiChatRequest(text="")

    assert SeedRequest().embedding_model == "all-MiniLM-L6-v2"
    assert ChatRequest(message="hello").top_k == 5
    response = RetrievalResponse(query="q", database="neo4j", results=[])
    assert response.metadata == {}

    source_range = SourceRangePayload(
        startLine=1, startColumn=0, endLine=1, endColumn=4
    )
    node = GraphNodePayload(
        id="n1", label="Node", type="Class", sourceRange=source_range
    )
    edge = GraphEdgePayload(
        id="e1", source="n1", target="n2", relationshipType="CALLS"
    )
    delta = GraphDeltaPayload(
        filePath="src/a.py", op="modified", nodesToAdd=[node], edgesToAdd=[edge]
    )
    batch = DeltaBatchPayload(
        deltas=[delta],
        totals=DeltaBatchTotals(
            filesProcessed=1,
            nodesAdded=1,
            nodesRemoved=0,
            edgesAdded=1,
            edgesRemoved=0,
        ),
    )
    assert batch.deltas[0].nodesToRemove == []
    patch = PatchResponse(status="ok", message="done", stats=PatchApplyStats())
    assert patch.stats.durationMs == 0

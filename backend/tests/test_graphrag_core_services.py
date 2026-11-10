from __future__ import annotations

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from graphrag_agent.api import chat_router, patch_router
from graphrag_agent.schemas.patch_schemas import (
    DeltaBatchPayload,
    DeltaBatchTotals,
    GraphDeltaPayload,
    GraphEdgePayload,
    GraphNodePayload,
    PatchApplyStats,
    SourceRangePayload,
)
from graphrag_agent.schemas.requests import ChatRequest
from graphrag_agent.services import (
    codegraph_patch,
    embedding_service,
    llm_service,
    neo4j_service,
    retrieval_profiles,
)


def test_retrieval_profiles_normalize_filters_dependencies_and_limits() -> None:
    assert retrieval_profiles.normalize_profile(" WORKFLOW ") == "workflow"
    assert retrieval_profiles.normalize_profile("unknown") == "focused"
    assert "Function" in retrieval_profiles.profile_node_types("focused")
    assert "CALLS" in retrieval_profiles.profile_relationship_types("compare")
    assert retrieval_profiles.parse_csv_filter("CALLS, CALLS, CONTAINS") == [
        "CALLS",
        "CONTAINS",
    ]
    assert retrieval_profiles.parse_csv_filter(["A", None, "B"]) == ["A", "B"]
    assert retrieval_profiles.csv_filter([]) is None
    assert retrieval_profiles.csv_filter(["A", "B"]) == "A,B"
    expanded = retrieval_profiles.expand_relationship_dependencies(["FLOWS_TO"])
    assert expanded[0] == "FLOWS_TO"
    assert {"READS", "WRITES", "REACHING_DEF", "CONTAINS"}.issubset(expanded)

    limits = retrieval_profiles.calculate_profile_limits(
        "workflow",
        10_000,
        requested_candidate_k="9999",
        requested_final_k="1",
        requested_max_neighbors="100",
    )
    assert limits == {"candidate_k": 400, "final_k": 15, "max_neighbors": 50}
    assert retrieval_profiles.calculate_profile_limits(
        "focused", 0, requested_candidate_k="bad"
    )["candidate_k"] == 40

    request = retrieval_profiles.build_profile_request(
        "architecture",
        total_nodes=100,
        node_types="File,Folder",
        relationship_types="ROUTES_TO",
    )
    assert request["profile"] == "architecture"
    assert request["node_types"] == ["File", "Folder"]
    assert {"ROUTES_TO", "CONTAINS", "HANDLES"}.issubset(
        request["expanded_relationship_types"]
    )
    assert retrieval_profiles._percent_limit(0, 0.5, 4, 10) == 4
    assert retrieval_profiles._percent_limit(100, 0.5, 4, 10) == 10


def test_sentence_transformer_embedder_is_singleton(monkeypatch) -> None:
    class Vector:
        def __init__(self, values):
            self.values = values

        def astype(self, _kind):
            return self

        def tolist(self):
            return self.values

    class FakeModel:
        def __init__(self, name, device=None):
            self.name = name
            self.device = device

        def encode(self, value, **_kwargs):
            if isinstance(value, list):
                return [Vector([float(index), 1.0]) for index, _ in enumerate(value)]
            return Vector([1.0, 2.0])

        def get_embedding_dimension(self):
            return 2

    monkeypatch.setattr(embedding_service, "SentenceTransformer", FakeModel)
    embedding_service.SentenceTransformerEmbedder._instance = None
    embedding_service.SentenceTransformerEmbedder._model = None
    first = embedding_service.SentenceTransformerEmbedder("fake", device="cpu")
    second = embedding_service.get_embedder()
    assert first is second
    assert first.embed_query("text") == [1.0, 2.0]
    assert first.embed_documents(["a", "b"]) == [[0.0, 1.0], [1.0, 1.0]]
    assert first.dimension == 2
    assert first.get_model_name() == "fake"

    monkeypatch.delattr(FakeModel, "get_embedding_dimension")
    first._model.get_sentence_embedding_dimension = lambda: 3
    assert first.dimension == 3


@pytest.mark.asyncio
async def test_llm_service_local_openai_and_errors(monkeypatch) -> None:
    llm_service.reset_openai_client()
    monkeypatch.setenv("LLM_PROVIDER", "local")
    answer = await llm_service.generate_chat_response("question", [])
    assert "Local fallback mode" in answer

    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    with pytest.raises(ValueError, match="does not use OpenAI"):
        llm_service.get_openai_client()
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(ValueError, match="missing"):
        llm_service.get_openai_client()

    create = AsyncMock(
        return_value=SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="Generated"))]
        )
    )
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    monkeypatch.setattr(llm_service, "get_openai_client", lambda: client)
    context = [
        {
            "seedNode": {
                "name": "Auth",
                "filePath": "auth.py",
                "lineNumber": 2,
                "ragText": "auth service",
            },
            "graphContext": {
                "neighbors": [
                    {
                        "direction": "OUTGOING",
                        "relationshipType": "CALLS",
                        "node": {"name": "DB", "filePath": "db.py"},
                    }
                ]
            },
        }
    ]
    assert await llm_service.generate_chat_response("question", context) == "Generated"
    call = create.await_args.kwargs
    assert call["messages"][1] == {"role": "user", "content": "question"}
    assert "Auth" in call["messages"][0]["content"]
    create.side_effect = RuntimeError("openai down")
    with pytest.raises(RuntimeError, match="openai down"):
        await llm_service.generate_chat_response("question", [])


class FakeSession:
    def __init__(self, fail_create=False):
        self.fail_create = fail_create
        self.queries: list[tuple[str, dict]] = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def run(self, query, **params):
        self.queries.append((query, params))
        if self.fail_create and "CREATE DATABASE" in query:
            raise RuntimeError("unsupported")
        return SimpleNamespace(consume=lambda: None)


class FakeDriver:
    def __init__(self, session=None):
        self.fake_session = session or FakeSession()
        self.databases: list[str] = []
        self.closed = False
        self.verified = False

    def verify_connectivity(self):
        self.verified = True

    def session(self, database):
        self.databases.append(database)
        return self.fake_session

    def close(self):
        self.closed = True


def test_neo4j_service_driver_and_schema_operations(monkeypatch) -> None:
    neo4j_service.close_driver()
    monkeypatch.delenv("NEO4J_PASSWORD", raising=False)
    with pytest.raises(ValueError, match="NEO4J_PASSWORD"):
        neo4j_service.get_driver()

    driver = FakeDriver()
    factory = MagicMock(return_value=driver)
    monkeypatch.setattr(neo4j_service.GraphDatabase, "driver", factory)
    monkeypatch.setenv("NEO4J_PASSWORD", "secret")
    monkeypatch.setenv("NEO4J_URI", "bolt://test")
    monkeypatch.setenv("NEO4J_USER", "tester")
    assert neo4j_service.get_driver() is driver
    assert neo4j_service.get_driver() is driver
    factory.assert_called_once_with("bolt://test", auth=("tester", "secret"))
    assert driver.verified is True

    neo4j_service.ensure_database("graph")
    neo4j_service.wipe_database("graph")
    neo4j_service.create_constraints("graph")
    neo4j_service.ensure_indexes("graph", "vec", "text", 3)
    query_text = "\n".join(query for query, _ in driver.fake_session.queries)
    assert "CREATE DATABASE `graph`" in query_text
    assert "DETACH DELETE" in query_text
    assert "CREATE CONSTRAINT" in query_text
    assert "CREATE VECTOR INDEX vec" in query_text
    neo4j_service.close_driver()
    assert driver.closed is True

    failing = FakeDriver(FakeSession(fail_create=True))
    monkeypatch.setattr(neo4j_service, "get_driver", lambda: failing)
    neo4j_service.ensure_database("unsupported")


def make_delta(unsafe_relationship: str | None = None) -> GraphDeltaPayload:
    source_range = SourceRangePayload(
        startLine=1, startColumn=2, endLine=3, endColumn=4, startByte=5
    )
    node = GraphNodePayload(
        id="n1",
        label="Node One",
        type="Class",
        filePath="src/a.py",
        lineNumber=1,
        sourceRange=source_range,
        properties={
            "simple": 1,
            "nested": {"x": 1},
            "ragText": "must not overwrite",
            "none": None,
        },
    )
    target = GraphNodePayload(id="n2", label="Node Two", type="Function")
    edge = GraphEdgePayload(
        id="e1",
        source="n1",
        target="n2",
        relationshipType=unsafe_relationship or "CALLS",
        sourceRange=source_range,
    )
    return GraphDeltaPayload(
        filePath="src/a.py",
        op="modified",
        nodesToAdd=[node, target],
        nodesToRemove=["old-node"],
        edgesToAdd=[edge],
        edgesToRemove=["old-edge"],
    )


def test_codegraph_patch_prepares_rows_and_applies_transaction(monkeypatch) -> None:
    embedder = SimpleNamespace(
        embed_documents=lambda texts: [[float(index), 1.0] for index, _ in enumerate(texts)],
        get_model_name=lambda: "fake-model",
    )
    monkeypatch.setattr(codegraph_patch, "get_embedder", lambda: embedder)
    delta = make_delta()
    node_rows = codegraph_patch._prepare_node_rows(delta.nodesToAdd)
    edge_rows = codegraph_patch._prepare_edge_rows(delta.edgesToAdd, delta.nodesToAdd)
    assert node_rows[0]["props"]["simple"] == 1
    assert node_rows[0]["props"]["nested"] == '{"x": 1}'
    assert node_rows[0]["props"]["ragText"].startswith("type: Class")
    assert node_rows[0]["props"]["sourceStartLine"] == 1
    assert edge_rows[0]["props"]["ragText"] == (
        "relationship: CALLS | sourceName: Node One | targetName: Node Two"
    )

    class Result:
        def __init__(self, count):
            self.count = count

        def single(self):
            return {"removed": self.count, "merged": self.count}

    class Tx:
        def run(self, query, **params):
            return Result(len(params.get("ids", params.get("rows", []))))

    class Session:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute_write(self, callback, *args):
            return callback(Tx(), *args)

    driver = SimpleNamespace(session=lambda database: Session())
    stats = codegraph_patch.apply_delta_batch(driver, "neo4j", [delta])
    assert stats.nodesDeleted == 1
    assert stats.edgesDeleted == 1
    assert stats.nodesMerged == 2
    assert stats.edgesMerged == 1
    assert stats.embeddingsRefreshed == 2


def test_codegraph_patch_validation_and_helpers(monkeypatch) -> None:
    with pytest.raises(ValueError, match="safe Cypher label"):
        codegraph_patch.apply_delta_batch(
            SimpleNamespace(), "neo4j", [make_delta("CALLS`) DELETE n")]
        )
    monkeypatch.setattr(
        codegraph_patch,
        "get_embedder",
        lambda: SimpleNamespace(embed_documents=MagicMock(side_effect=RuntimeError("no model"))),
    )
    assert codegraph_patch._embed_texts(["a", "b"]) == [[], []]
    assert codegraph_patch._embed_texts([]) == []
    assert codegraph_patch._clean_props(None) == {}
    assert codegraph_patch._clean_props({"list": [1, "x"], "object": object()})["list"] == [1, "x"]
    assert codegraph_patch._drop_none({"x": None, "y": 1}) == {"y": 1}
    assert codegraph_patch._sanitize_label("not safe!") == "Unknown"
    with pytest.raises(ValueError):
        codegraph_patch._sanitize_relationship_type("not safe!")
    assert codegraph_patch._source_range_props(None) == {}
    assert dict(codegraph_patch._group_by_type([{"type": "A"}, {"type": "A"}]))["A"]
    assert list(codegraph_patch._chunked([{"x": 1}, {"x": 2}], 1)) == [
        [{"x": 1}],
        [{"x": 2}],
    ]
    assert codegraph_patch._is_safe_label("_GOOD2") is True
    assert codegraph_patch._is_safe_label("2BAD") is False


def make_batch(deltas: list[GraphDeltaPayload], database: str | None = None):
    return DeltaBatchPayload(
        database=database,
        deltas=deltas,
        totals=DeltaBatchTotals(
            filesProcessed=len(deltas),
            nodesAdded=0,
            nodesRemoved=0,
            edgesAdded=0,
            edgesRemoved=0,
        ),
    )


def test_patch_router_empty_success_and_failures(monkeypatch) -> None:
    empty = patch_router.patch_graph(make_batch([]))
    assert empty.status == "ok"
    assert "nothing" in empty.message

    monkeypatch.setattr(patch_router, "get_driver", MagicMock(side_effect=RuntimeError("down")))
    with pytest.raises(HTTPException) as exc:
        patch_router.patch_graph(make_batch([make_delta()]))
    assert exc.value.status_code == 503

    monkeypatch.setattr(patch_router, "get_driver", lambda: object())
    monkeypatch.setattr(
        patch_router,
        "apply_delta_batch",
        lambda driver, database, deltas: PatchApplyStats(
            nodesMerged=2, nodesDeleted=1, edgesMerged=3, edgesDeleted=1
        ),
    )
    response = patch_router.patch_graph(make_batch([make_delta()], "custom"))
    assert "+2 nodes" in response.message

    monkeypatch.setattr(patch_router, "apply_delta_batch", MagicMock(side_effect=ValueError("unsafe")))
    with pytest.raises(HTTPException) as exc:
        patch_router.patch_graph(make_batch([make_delta()]))
    assert exc.value.status_code == 400
    monkeypatch.setattr(patch_router, "apply_delta_batch", MagicMock(side_effect=RuntimeError("db")))
    with pytest.raises(HTTPException) as exc:
        patch_router.patch_graph(make_batch([make_delta()]))
    assert exc.value.status_code == 500


@pytest.mark.asyncio
async def test_graphrag_chat_router_composes_retrieval_and_llm(monkeypatch) -> None:
    retrieve = AsyncMock(return_value={"results": [{"seedNode": {"name": "A"}}]})
    generate = AsyncMock(return_value="Answer")
    monkeypatch.setattr(chat_router, "retrieve_context", retrieve)
    monkeypatch.setattr(chat_router, "generate_chat_response", generate)
    monkeypatch.setenv("CODEGRAPH_DATABASE", "graph")
    response = await chat_router.chat(
        ChatRequest(message="Question", top_k=3, max_neighbors=4)
    )
    assert response.answer == "Answer"
    assert response.context_used[0]["seedNode"]["name"] == "A"
    retrieve.assert_awaited_once_with(
        query="Question", top_k=3, max_neighbors=4, database="graph"
    )
    generate.assert_awaited_once_with("Question", response.context_used)

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from graphrag_agent.api import retrieve_router
from graphrag_agent.services import graph_report_service, rag_service


class Session:
    def __init__(self, responder):
        self.responder = responder
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def run(self, query, **params):
        self.calls.append((query, params))
        return self.responder(query, params)


class Driver:
    def __init__(self, session):
        self.value = session

    def session(self, database):
        self.database = database
        return self.value


def test_rag_record_helpers_group_files_and_ranges() -> None:
    record = {
        "id": "n1",
        "name": "Thing",
        "filePath": "src/a.py",
        "lineNumber": 4,
        "labels": ["CodeNode", "Method"],
        "ragText": "text",
        "sourceStartLine": 4,
    }
    node = rag_service._node_record(record)
    assert node["type"] == "Method"
    assert node["sourceRange"]["startLine"] == 4
    assert rag_service._source_range_from_record({}) is None
    assert rag_service._primary_type(["CodeNode", "Custom"]) == "Custom"
    assert rag_service._primary_type(["CodeNode"]) == "Unknown"

    files = rag_service._group_symbols_by_file(
        [{"id": "f", "name": "a.py", "filePath": "src/a.py"}],
        [
            {"id": "late", "name": "late", "filePath": "src/a.py", "lineNumber": 10},
            {"id": "early", "name": "early", "filePath": "src/a.py", "lineNumber": 2},
            {"id": "synthetic", "name": "new", "filePath": "src/new.py", "lineNumber": None},
            {"id": "unfiled", "name": "none", "filePath": ""},
        ],
    )
    assert [item["filePath"] for item in files] == ["src/a.py", "src/new.py"]
    assert files[0]["symbols"][0]["id"] == "early"
    assert files[1]["synthetic"] is True
    endpoint = rag_service._compact_endpoint(
        {"sourceId": "s", "sourceLabels": ["CodeNode", "Class"]}, "source"
    )
    assert endpoint["type"] == "Class"


def test_rag_graph_context_count_direct_and_paths(monkeypatch) -> None:
    def responder(query, params):
        if "count(n) AS count" in query:
            return SimpleNamespace(single=lambda: {"count": 9})
        if "AS context" in query:
            return [
                {
                    "seedId": "n1",
                    "context": {"neighbors": [{"node": {"id": "a"}}, {"node": {"id": "b"}}]},
                }
            ]
        if "relationshipType" in query and "AS node" in query:
            return [{"relationshipType": "CALLS", "node": {"id": "n2"}}]
        return [{"nodes": [{"id": "n1"}], "relationships": ["CALLS"]}]

    session = Session(responder)
    monkeypatch.setattr(rag_service, "get_driver", lambda: Driver(session))
    assert rag_service.fetch_graph_context("db", [], 2) == {}
    context = rag_service.fetch_graph_context("db", ["n1"], 1, ["REF_CALL"])
    assert len(context["n1"]["neighbors"]) == 1
    assert rag_service.fetch_total_code_node_count("db") == 9

    callers = rag_service.fetch_symbol_callers("db", "n1", limit=999)
    assert callers["direction"] == "incoming"
    assert callers["truncated"] is False
    callees = rag_service.fetch_symbol_callees("db", "n1", limit=1)
    assert callees["direction"] == "outgoing"
    assert callees["truncated"] is True
    assert rag_service.fetch_impact_paths("db", "n1", max_depth=99, limit=0)["maxDepth"] == 6
    assert rag_service.fetch_affected_routes("db", "n1")["paths"]
    assert rag_service.fetch_affected_tests("db", "n1")["paths"]


def test_project_inventory_builds_structural_report(monkeypatch) -> None:
    def responder(query, params):
        if "RETURN nodeType" in query:
            return [
                {"nodeType": "File", "count": 1},
                {"nodeType": "Class", "count": 1},
                {"nodeType": "Folder", "count": 1},
            ]
        if "RETURN type(r) AS relationshipType, count" in query:
            return [{"relationshipType": "CONTAINS", "count": 2}]
        if "label = 'Folder'" in query:
            return [
                {"id": "folder", "name": "src", "filePath": "src", "labels": ["CodeNode", "Folder"]}
            ]
        if "label = 'File'" in query:
            return [
                {"id": "file", "name": "a.py", "filePath": "src/a.py", "labels": ["CodeNode", "File"]}
            ]
        if "symbolTypes" in params:
            return [
                {"id": "class", "name": "A", "filePath": "src/a.py", "labels": ["CodeNode", "Class"]}
            ]
        return [
            {
                "relationshipType": "CONTAINS",
                "sourceId": "folder",
                "sourceName": "src",
                "sourceLabels": ["Folder"],
                "targetId": "file",
                "targetName": "a.py",
                "targetLabels": ["File"],
            }
        ]

    monkeypatch.setattr(rag_service, "get_driver", lambda: Driver(Session(responder)))
    inventory = rag_service.fetch_project_inventory(
        "db", max_files=999, max_symbols=9999, max_relationship_samples=-1
    )
    assert inventory["totals"]["nodes"] == 3
    assert inventory["totals"]["relationships"] == 2
    assert inventory["files"][0]["symbols"][0]["name"] == "A"
    assert inventory["limits"] == {
        "maxFiles": 500,
        "maxSymbols": 5000,
        "maxRelationshipSamples": 0,
    }


def test_hybrid_retriever_construction_search_retry_and_sanitization(monkeypatch) -> None:
    captured = {}

    class Retriever:
        def __init__(self, *, database=None, **kwargs):
            captured.update(kwargs)
            captured["database"] = database

        def search(self, query_text, top_k, database=None):
            return {"query": query_text, "top_k": top_k, "database": database}

    monkeypatch.setattr(rag_service, "HybridRetriever", Retriever)
    monkeypatch.setattr(rag_service, "get_driver", lambda: "driver")
    monkeypatch.setattr(rag_service, "get_embedder", lambda: "embedder")
    retriever = rag_service.get_hybrid_retriever("db")
    assert captured["driver"] == "driver"
    assert captured["database"] == "db"
    result = rag_service.search_hybrid_retriever(
        retriever, query_text="A AND (B)?", top_k=3, database="db"
    )
    assert result["query"] == "A and B"

    failing = MagicMock()
    failing.search.side_effect = [
        RuntimeError("Could not parse the given fulltext search query"),
        {"ok": True},
    ]
    assert rag_service.search_hybrid_retriever(
        failing,
        query_text=" ".join(f"term{i}" for i in range(20)),
        top_k=2,
        database="db",
    ) == {"ok": True}
    assert len(failing.search.call_args.kwargs["query_text"].split()) == 12
    failing.search.side_effect = RuntimeError("network")
    with pytest.raises(RuntimeError, match="network"):
        rag_service.search_hybrid_retriever(
            failing, query_text="q", top_k=1, database="db"
        )
    assert rag_service.sanitize_fulltext_query_text("!!!") == "code"
    assert rag_service._minimal_fulltext_query_text("") == "code"
    assert rag_service._is_fulltext_parse_error(RuntimeError("TokenMgrError")) is True
    assert rag_service._database_kwargs(lambda database=None: None, "db") == {"database": "db"}
    assert rag_service._database_kwargs(len, "db") == {}


def test_graph_report_helpers_and_compare(monkeypatch) -> None:
    assert graph_report_service.split_compare_targets("Compare ServiceA vs ServiceB") == (
        "ServiceA",
        "ServiceB",
    )
    assert graph_report_service.split_compare_targets("single") == ("single", "single")
    assert graph_report_service._clean_seed_ids([" a ", "", "a", "b"]) == ["a", "b"]
    nodes = [
        {"id": "1", "filePath": "a.py", "name": "A", "type": "Class", "lineNumber": 1},
        {"id": "1", "filePath": "a.py"},
        {"id": "2", "filePath": "b.py", "name": "B"},
    ]
    assert len(graph_report_service._unique_nodes(nodes)) == 2
    assert [item["filePath"] for item in graph_report_service._files_from_nodes(nodes)] == [
        "a.py",
        "b.py",
    ]
    rel = {"relationshipType": "CALLS", "source": {"id": "1"}, "target": {"id": "2"}}
    assert graph_report_service._unique_relationships([rel, rel]) == [rel]
    assert graph_report_service._group_nodes_by_type([{"type": "B"}, {"type": "A"}]) == {
        "A": [{"type": "A"}],
        "B": [{"type": "B"}],
    }
    assert graph_report_service._bounded_int("bad", 4, 1, 6) == 4

    def fake_workflow(_database, query, _seeds, **_kwargs):
        return {
            "files": [{"filePath": "shared.py"}, {"filePath": f"{query}.py"}],
            "completeness": {"truncated": query == "left"},
        }

    monkeypatch.setattr(graph_report_service, "fetch_workflow_report", fake_workflow)
    report = graph_report_service.fetch_compare_report(
        "db", "compare", "left", "right", ["1"], ["2"], limit=5
    )
    assert report["sharedFiles"] == ["shared.py"]
    assert report["leftOnlyFiles"] == ["left.py"]
    assert report["completeness"]["truncated"] is True


def test_graph_path_focused_architecture_and_database_reports(monkeypatch) -> None:
    monkeypatch.setattr(
        graph_report_service,
        "_fetch_nodes_by_id",
        lambda database, ids: [
            {"id": node_id, "name": node_id, "type": "Class", "filePath": "a.py"}
            for node_id in ids
        ],
    )

    relationship_record = {
        "relationshipType": "CALLS",
        "direction": "OUT",
        "sourceId": "a",
        "sourceName": "A",
        "sourceFilePath": "a.py",
        "sourceLabels": ["CodeNode", "Class"],
        "targetId": "b",
        "targetName": "B",
        "targetFilePath": "b.py",
        "targetLabels": ["CodeNode", "Method"],
    }
    path_record = {
        "nodes": [{"id": "a", "name": "A", "type": "Class", "filePath": "a.py"}],
        "relationships": [
            {"relationshipType": "CALLS", "source": {"id": "a"}, "target": {"id": "b"}}
        ],
    }

    def responder(query, params):
        if "MATCH path" in query:
            return [path_record]
        if "seed:CodeNode" in query:
            return [relationship_record]
        if "Dependency" in query and "ragText" in query:
            return [
                {
                    "nodeId": "db",
                    "nodeName": "postgres client",
                    "nodeFilePath": "config.py",
                    "nodeLabels": ["Dependency"],
                    "ragText": "postgresql",
                }
            ]
        return []

    monkeypatch.setattr(graph_report_service, "get_driver", lambda: Driver(Session(responder)))
    empty = graph_report_service.fetch_workflow_report("db", "q", [], max_depth=0, limit=0)
    assert empty["reportType"] == "workflow_relationship_report"
    assert empty["paths"] == []
    workflow = graph_report_service.fetch_workflow_report("db", "q", ["a"])
    assert workflow["nodes"][0]["id"] == "a"
    focused = graph_report_service.fetch_focused_symbol_report("db", "q", ["a"])
    assert focused["relationships"][0]["relationshipType"] == "CALLS"
    databases = graph_report_service.detect_application_databases("db")
    assert databases[0]["name"] == "PostgreSQL"

    monkeypatch.setattr(graph_report_service, "fetch_project_inventory", lambda *a, **k: {"truncated": {}})
    monkeypatch.setattr(graph_report_service, "detect_application_databases", lambda db: [])
    architecture = graph_report_service.fetch_architecture_report("db", max_files=1, max_symbols=1)
    assert architecture["reportType"] == "architecture_report"
    assert architecture["applicationDatabases"] == []


def test_retrieve_router_helpers_and_rank_scoring(monkeypatch) -> None:
    assert retrieve_router.parse_result_content({"id": "1"}) == {"id": "1"}
    assert retrieve_router.parse_result_content("{'id': '2'}") == {"id": "2"}
    assert retrieve_router.parse_result_content("not-data") == {}
    assert retrieve_router.source_range_from_props({}) is None
    assert retrieve_router.source_range_from_props({"sourceStartLine": 1})["startLine"] == 1
    assert retrieve_router._retriever_items({"items": [1]}) == [1]
    assert retrieve_router._retriever_items({"items": lambda: []}) == []
    assert retrieve_router._retriever_items(SimpleNamespace(items=(1, 2))) == [1, 2]
    assert retrieve_router._retriever_items(None) == []
    assert retrieve_router._retriever_item_content({"text": "x"}) == "x"
    assert retrieve_router._candidate_type({"ragText": "type: Method | name: x"}) == "Method"
    assert retrieve_router._candidate_type({}) == "CodeNode"
    clean = retrieve_router._candidate_score("Auth auth.py", {"name": "Auth", "filePath": "auth.py", "type": "Class"}, 1)
    noisy = retrieve_router._candidate_score("x", {"name": "x", "type": "Argument"}, 1)
    assert clean > noisy
    assert retrieve_router._seed_ids_from_retrieval_payload(
        {"results": [{"seedNode": {"id": "1"}}, "bad"]}
    ) == ["1"]
    summary = retrieve_router._retrieval_summary(
        {"query": "q", "database": "db", "results": [{"seedNode": {"id": "1"}}]}
    )
    assert summary["resultCount"] == 1
    monkeypatch.setenv("CODEGRAPH_DATABASE", " env-db ")
    assert retrieve_router.resolve_retrieval_database() == "env-db"
    assert retrieve_router.resolve_retrieval_database(" explicit ") == "explicit"


@pytest.mark.asyncio
async def test_retrieve_context_filters_scores_and_falls_back(monkeypatch) -> None:
    monkeypatch.setattr(retrieve_router, "fetch_total_code_node_count", lambda db: 100)
    monkeypatch.setattr(retrieve_router, "get_hybrid_retriever", lambda db: object())
    monkeypatch.setattr(
        retrieve_router,
        "search_hybrid_retriever",
        lambda *a, **k: {
            "items": [
                {"content": {"id": "1", "name": "Auth", "type": "Class", "filePath": "auth.py"}},
                {"content": {"id": "2", "name": "noise", "type": "Argument"}},
                {"content": {"name": "missing id"}},
            ]
        },
    )
    monkeypatch.setattr(
        retrieve_router,
        "fetch_graph_context",
        lambda db, ids, max_neighbors, relationship_types=None: {
            node_id: {"neighbors": []} for node_id in ids
        },
    )
    payload = await retrieve_router.retrieve_context(
        "Auth", database="db", profile="focused", final_k=5
    )
    assert payload["results"][0]["seedNode"]["id"] == "1"
    assert payload["metadata"]["raw_candidate_count"] == 2

    monkeypatch.setattr(
        retrieve_router,
        "build_profile_request",
        lambda *a, **k: {
            "profile": "focused",
            "candidate_k": 5,
            "final_k": 5,
            "max_neighbors": 2,
            "node_types": ["File"],
            "relationship_types": [],
            "expanded_relationship_types": [],
        },
    )
    fallback = await retrieve_router.retrieve_context("Auth", database="db")
    assert fallback["metadata"]["filter_fallback"] is True

    monkeypatch.setattr(
        retrieve_router, "search_hybrid_retriever", MagicMock(side_effect=RuntimeError("search down"))
    )
    with pytest.raises(HTTPException) as exc:
        await retrieve_router.retrieve_context("q", database="db")
    assert exc.value.status_code == 500


@pytest.mark.asyncio
async def test_retrieve_report_and_impact_endpoints(monkeypatch) -> None:
    retrieval = {
        "query": "q",
        "database": "db",
        "results": [{"seedNode": {"id": "1"}}],
        "metadata": {"profile": "focused"},
    }
    monkeypatch.setattr(retrieve_router, "retrieve_context", AsyncMock(return_value=retrieval))
    monkeypatch.setattr(retrieve_router, "fetch_architecture_report", lambda *a, **k: {"kind": "arch"})
    monkeypatch.setattr(retrieve_router, "fetch_workflow_report", lambda *a, **k: {"kind": "flow"})
    monkeypatch.setattr(retrieve_router, "fetch_focused_symbol_report", lambda *a, **k: {"kind": "focus"})
    monkeypatch.setattr(retrieve_router, "fetch_compare_report", lambda *a, **k: {"kind": "compare"})
    monkeypatch.setattr(retrieve_router, "fetch_project_inventory", lambda *a, **k: {"kind": "inventory"})
    monkeypatch.setattr(retrieve_router, "fetch_symbol_callers", lambda *a, **k: {"kind": "callers"})
    monkeypatch.setattr(retrieve_router, "fetch_symbol_callees", lambda *a, **k: {"kind": "callees"})
    monkeypatch.setattr(retrieve_router, "fetch_impact_paths", lambda *a, **k: {"kind": "impact"})
    monkeypatch.setattr(retrieve_router, "fetch_affected_tests", lambda *a, **k: {"kind": "tests"})
    monkeypatch.setattr(retrieve_router, "fetch_affected_routes", lambda *a, **k: {"kind": "routes"})

    assert (await retrieve_router.architecture_report_context("q"))["query"] == "q"
    assert (await retrieve_router.workflow_report_context("q"))["retrieval"]["seedIds"] == ["1"]
    assert (await retrieve_router.focused_report_context("q"))["kind"] == "focus"
    assert (await retrieve_router.compare_report_context("compare A and B"))["kind"] == "compare"
    assert (await retrieve_router.project_inventory_context())["kind"] == "inventory"
    assert (await retrieve_router.symbol_callers("1"))["kind"] == "callers"
    assert (await retrieve_router.symbol_callees("1"))["kind"] == "callees"
    assert (await retrieve_router.impact_context("1"))["kind"] == "impact"
    assert (await retrieve_router.affected_tests_context("1"))["kind"] == "tests"
    assert (await retrieve_router.affected_routes_context("1"))["kind"] == "routes"

    monkeypatch.setattr(
        retrieve_router, "fetch_project_inventory", MagicMock(side_effect=RuntimeError("inventory down"))
    )
    with pytest.raises(HTTPException) as exc:
        await retrieve_router.project_inventory_context()
    assert exc.value.status_code == 500

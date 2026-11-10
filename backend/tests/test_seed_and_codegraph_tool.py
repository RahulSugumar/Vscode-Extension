from __future__ import annotations

import io
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException, UploadFile

from chatbot.agent.tools import codegraph
from chatbot.agent.tools.codegraph_stub import CodeGraphStub
from chatbot.config.settings import Settings
from graphrag_agent.api import seed_router


def upload(payload: object) -> UploadFile:
    return UploadFile(filename="graph.json", file=io.BytesIO(json.dumps(payload).encode()))


class Session:
    def __init__(self):
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def run(self, query, **kwargs):
        self.calls.append((query, kwargs))


@pytest.mark.asyncio
async def test_seed_graph_validates_embeds_and_writes(monkeypatch) -> None:
    session = Session()
    driver = SimpleNamespace(session=lambda database: session)
    embedder = SimpleNamespace(
        embed_documents=lambda texts: [[1.0, 2.0] for _ in texts],
        get_model_name=lambda: "fake",
        dimension=2,
    )
    wipe = MagicMock()
    constraints = MagicMock()
    indexes = MagicMock()
    monkeypatch.setattr(seed_router, "get_driver", lambda: driver)
    monkeypatch.setattr(seed_router, "get_embedder", lambda: embedder)
    monkeypatch.setattr(seed_router, "wipe_database", wipe)
    monkeypatch.setattr(seed_router, "create_constraints", constraints)
    monkeypatch.setattr(seed_router, "ensure_indexes", indexes)
    payload = {
        "nodes": [
            {
                "id": "n1",
                "label": "One",
                "type": "Class",
                "filePath": "a.py",
                "sourceRange": {"startLine": 1, "startColumn": 0},
                "properties": {"nested": {"x": 1}, "ragText": "reserved"},
            },
            {"id": "n2", "label": "Two", "type": "unsafe label"},
        ],
        "edges": [
            {"source": "n1", "target": "n2", "relationshipType": "calls"}
        ],
    }
    result = await seed_router.seed_graph(upload(payload), database=" custom ", wipe=True)
    assert result == {
        "message": "Success",
        "nodes_upserted": 2,
        "edges_upserted": 1,
        "database": "custom",
    }
    wipe.assert_called_once_with("custom")
    constraints.assert_called_once_with("custom")
    indexes.assert_called_once_with(
        "custom",
        "codegraph_codenode_ragEmbedding",
        "codegraph_codenode_ragText",
        2,
    )
    queries = "\n".join(item[0] for item in session.calls)
    assert ":`Class`" in queries
    assert ":`Unknown`" in queries
    assert ":`CALLS`" in queries


@pytest.mark.asyncio
async def test_seed_graph_rejects_invalid_files() -> None:
    with pytest.raises(HTTPException) as exc:
        await seed_router.seed_graph(
            UploadFile(filename="bad", file=io.BytesIO(b"not json"))
        )
    assert exc.value.status_code == 400
    with pytest.raises(HTTPException, match="nodes"):
        await seed_router.seed_graph(upload({"nodes": []}))
    with pytest.raises(HTTPException, match="arrays"):
        await seed_router.seed_graph(upload({"nodes": {}, "edges": []}))


def test_seed_helpers_and_database_resolution(monkeypatch) -> None:
    assert seed_router.sanitize_label("Good_2") == "Good_2"
    assert seed_router.sanitize_label("2 bad") == "Unknown"
    assert seed_router.clean_props({"x": 1, "list": [1, "a"], "obj": {"a": 1}, "vector": [1]}) == {
        "x": 1,
        "list": [1, "a"],
        "obj": '{"a": 1}',
    }
    assert seed_router.source_range_props(None) == {}
    node = {
        "id": "n",
        "type": "Class",
        "label": "A",
        "filePath": "a.py",
        "sourceRange": {"startLine": 1, "startColumn": 2, "endLine": 3, "endColumn": 4},
        "properties": {"x": 1},
    }
    assert "sourceRange: 1:2-3:4" in seed_router.build_node_rag_text(node)
    assert seed_router.build_edge_rag_text(
        {"source": "n", "target": "m", "relationshipType": "calls"},
        {"n": node, "m": {"label": "B"}},
    ) == "relationship: CALLS | sourceName: A | targetName: B"
    assert list(seed_router.chunked([1, 2, 3], 2)) == [[1, 2], [3]]
    monkeypatch.setenv("CODEGRAPH_DATABASE", "env-db")
    assert seed_router.resolve_seed_database() == "env-db"
    assert seed_router.resolve_seed_database("explicit") == "explicit"


def retrieval_payload(results=None):
    return {
        "query": "Auth",
        "top_k": 2,
        "database": "db",
        "results": results
        if results is not None
        else [
            {
                "rank": 1,
                "seedNode": {
                    "id": "n1",
                    "name": "Auth",
                    "type": "Class",
                    "filePath": "auth.py",
                    "lineNumber": 4,
                    "ragText": "evidence",
                },
                "graphContext": {
                    "neighbors": [
                        {
                            "direction": "OUT",
                            "relationshipType": "CALLS",
                            "node": {"name": "DB", "type": "Service"},
                        }
                    ]
                },
            }
        ],
        "metadata": {"profile": "focused", "candidate_k": 20, "final_k": 2},
    }


def test_codegraph_tool_health_retrieve_success_empty_and_failures(monkeypatch) -> None:
    enabled = Settings(codegraph_enabled=True, codegraph_max_result_chars=1000)
    disabled = codegraph.CodeGraphTool(Settings(codegraph_enabled=False))
    assert disabled.health().status == "disabled"
    assert disabled.retrieve("q").available is False
    tool = codegraph.CodeGraphTool(enabled)
    assert tool.health().status == "ok"

    monkeypatch.setattr(codegraph, "retrieve_context", AsyncMock(return_value=retrieval_payload()))
    result = tool.retrieve("Auth", top_k=2, database="db")
    assert result.status == "ok"
    assert "Class Auth" in result.output
    assert "UNTRUSTED_CODEGRAPH_EVIDENCE" in result.output
    assert result.metadata["seed_nodes"][0]["filePath"] == "auth.py"
    assert tool.query("Auth").status == "ok"

    monkeypatch.setattr(codegraph, "retrieve_context", AsyncMock(return_value=retrieval_payload([])))
    assert tool.retrieve("none").status == "empty"
    monkeypatch.setattr(codegraph, "retrieve_context", AsyncMock(return_value={"bad": True}))
    assert tool.retrieve("bad").status == "invalid_response"
    monkeypatch.setattr(codegraph, "retrieve_context", AsyncMock(side_effect=RuntimeError("down")))
    assert tool.retrieve("error").status == "connection_error"
    monkeypatch.setattr(codegraph, "retrieve_context", None)
    assert tool.retrieve("missing").status == "dependency_unavailable"


def test_codegraph_inventory_report_and_node_queries(monkeypatch) -> None:
    tool = codegraph.CodeGraphTool(Settings(codegraph_enabled=True, codegraph_max_result_chars=1000))
    inventory = {
        "database": "db",
        "totals": {"files": 1, "classes": 1, "methods": 1, "functions": 0, "relationships": 2},
        "files": [
            {
                "filePath": "a.py",
                "symbols": [{"id": "c", "name": "A", "type": "Class", "lineNumber": 1}],
            }
        ],
        "truncated": {"files": False},
    }
    monkeypatch.setattr(codegraph, "project_inventory_context", AsyncMock(return_value=inventory))
    result = tool.project_inventory(database="db")
    assert result.status == "ok"
    assert result.metadata["file_count"] == 1
    monkeypatch.setattr(codegraph, "project_inventory_context", AsyncMock(return_value=[]))
    assert tool.project_inventory().status == "invalid_response"
    monkeypatch.setattr(codegraph, "project_inventory_context", AsyncMock(side_effect=RuntimeError()))
    assert tool.project_inventory().status == "connection_error"

    report_payload = {
        "reportType": "workflow_relationship_report",
        "codegraphDatabase": "db",
        "query": "q",
        "files": [{"filePath": "a.py", "nodes": []}],
        "nodes": [{"id": "n", "name": "N", "type": "Class", "filePath": "a.py"}],
        "relationships": [],
        "paths": [],
        "completeness": {"truncated": False},
    }
    monkeypatch.setattr(codegraph, "workflow_report_context", AsyncMock(return_value=report_payload))
    report = tool.workflow_report("q")
    assert report.status == "ok"
    assert report.metadata["report_type"] == "workflow_relationship_report"

    async def node_callback(**_params):
        return {
            "database": "db",
            "nodeId": "n",
            "results": [{"relationshipType": "CALLS", "node": {"id": "x", "name": "X"}}],
            "truncated": True,
        }

    monkeypatch.setattr(codegraph, "symbol_callers", node_callback)
    callers = tool.callers("n")
    assert callers.status == "ok"
    assert "Result was truncated" in callers.output
    assert "Direct relationships" in callers.output

    monkeypatch.setattr(codegraph, "symbol_callers", AsyncMock(return_value=[]))
    assert tool.callers("n").status == "invalid_response"
    monkeypatch.setattr(codegraph, "symbol_callers", AsyncMock(side_effect=RuntimeError("down")))
    assert tool.callers("n").status == "connection_error"


def test_codegraph_report_failure_uses_fallback_and_format_helpers(monkeypatch) -> None:
    tool = codegraph.CodeGraphTool(Settings(codegraph_enabled=True, codegraph_max_result_chars=500))
    tool.retrieve = MagicMock(
        return_value=codegraph.CodeGraphToolResult(
            output="fallback",
            available=True,
            status="ok",
            metadata={"tool": "codegraph"},
        )
    )

    async def broken(**_kwargs):
        raise TypeError("report down")

    result = tool._graph_report_query(
        tool="codegraph_workflow_report",
        title="Workflow",
        callback=broken,
        params={"query": "q", "database": "db", "seed_k": 2, "limit": 3, "max_depth": 2},
    )
    assert result.status == "fallback"
    assert result.metadata["original_tool"] == "codegraph_workflow_report"
    assert tool._fallback_profile_for_report_tool("unknown") == "focused"
    assert tool._report_type_for_tool("codegraph_compare_report") == "compare_report"

    assert codegraph._format_filter_list(list(range(20)), limit=2).endswith("18 more")
    assert codegraph._format_neighbor(
        {"direction": "IN", "relationshipType": "CALLS", "node": {"name": "A"}}
    ).startswith("<- CALLS")
    assert codegraph._format_inventory_symbol({"type": "Class", "name": "A", "filePath": "a.py", "lineNumber": 2}) == "Class A (a.py:2)"
    assert codegraph._format_inventory_endpoint({"id": "n"}) == "Node n"
    assert codegraph._format_location("a.py", None) == "a.py"
    assert codegraph._format_location(None, 2) == ""
    assert codegraph._short_json({"long": "x" * 20}, 10).endswith("...")
    assert codegraph._safe_json(SimpleNamespace(json=lambda: {"ok": True})) == {"ok": True}
    assert codegraph._safe_json(SimpleNamespace(json=MagicMock(side_effect=ValueError()))) is None
    assert tool._url("/api") .endswith("/api")
    monkeypatch.setenv("CODEGRAPH_DATABASE", "env")
    assert tool._database_name() == "env"
    assert codegraph.build_codegraph_tool(Settings())._settings.codegraph_enabled is True


def test_codegraph_rich_report_formatters_and_remaining_wrappers(monkeypatch) -> None:
    tool = codegraph.CodeGraphTool(
        Settings(codegraph_enabled=True, codegraph_max_result_chars=2000)
    )
    endpoint = {"id": "n", "name": "Node", "type": "Class", "filePath": "a.py", "lineNumber": 1}
    relationship = {
        "relationshipType": "CALLS",
        "source": endpoint,
        "target": {**endpoint, "id": "m", "name": "Method"},
    }
    workflow = {
        "reportType": "workflow_relationship_report",
        "codegraphDatabase": "db",
        "query": "flow",
        "retrieval": {"resultCount": 1},
        "seedNodes": [endpoint],
        "files": [{"filePath": "a.py", "nodeCount": 1}],
        "paths": [{"nodes": [endpoint], "relationships": [relationship]}],
        "relationships": [relationship],
        "completeness": {"truncated": False, "limits": {"max": 1}},
    }
    output, truncated = tool._format_report_payload(workflow)
    assert "Evidence paths" in output
    assert "Relationship table" in output
    assert truncated is False

    architecture = {
        "reportType": "architecture_report",
        "codegraphDatabase": "db",
        "query": "architecture",
        "inventory": {
            "database": "db",
            "totals": {"nodes": 2, "relationships": 1, "files": 1},
            "nodeTypeCounts": {"Class": 1},
            "relationshipTypeCounts": {"CALLS": 1},
        },
        "applicationDatabases": [{"name": "SQLite", "evidence": [endpoint]}],
        "routerFiles": [endpoint],
        "endpoints": [{"endpoint": endpoint, "targets": [{"relationshipType": "CALLS", "node": endpoint}]}],
        "layerNodes": {"Class": [endpoint]},
        "relationshipSamples": [relationship],
        "completeness": {"truncated": False},
    }
    assert "Application database evidence" in tool._format_report_payload(architecture)[0]

    compare = {
        "reportType": "compare_report",
        "codegraphDatabase": "db",
        "query": "compare",
        "left": {"query": "A", "files": [{"filePath": "a.py"}], "relationships": [relationship]},
        "right": {"query": "B", "files": [], "relationships": []},
        "sharedFiles": [],
        "leftOnlyFiles": ["a.py"],
        "rightOnlyFiles": [],
        "completeness": {"truncated": True},
    }
    assert "Left-only files: a.py" in tool._format_report_payload(compare)[0]
    assert "CodeGraph report result" in tool._format_report_payload({"reportType": "unknown"})[0]

    inventory = {
        "database": "db",
        "totals": {"nodes": 2, "relationships": 1, "files": 1},
        "nodeTypeCounts": {"Class": 1},
        "relationshipTypeCounts": {"CALLS": 1},
        "folders": [{"name": "src"}],
        "files": [{"filePath": "a.py", "symbols": [endpoint]}],
        "unfiledSymbols": [endpoint],
        "relationshipSamples": [relationship],
        "truncated": {"files": True},
    }
    inventory_output, _ = tool._format_project_inventory(inventory)
    assert "Folders/modules" in inventory_output
    assert "Relationship samples" in inventory_output
    assert "Inventory limits reached" in inventory_output

    async def node_result(**params):
        return {"database": params["database"], "nodeId": params["node_id"], "paths": []}

    monkeypatch.setattr(codegraph, "symbol_callees", node_result)
    monkeypatch.setattr(codegraph, "impact_context", node_result)
    monkeypatch.setattr(codegraph, "affected_routes_context", node_result)
    monkeypatch.setattr(codegraph, "affected_tests_context", node_result)
    assert tool.callees("n").status == "ok"
    assert tool.impact("n").status == "ok"
    assert tool.affected_routes("n").status == "ok"
    assert tool.affected_tests("n").status == "ok"

    disabled = codegraph.CodeGraphTool(Settings(codegraph_enabled=False))
    assert disabled.architecture_report().status == "disabled"
    assert disabled.callers("n").status == "disabled"


@pytest.mark.parametrize(
    ("query", "operation"),
    [
        ("find symbol", "find_symbol"),
        ("show callers", "neighbors"),
        ("search file", "search_text"),
        ("anything", "generic_lookup"),
    ],
)
def test_codegraph_stub_covers_all_operations(query, operation) -> None:
    stub = CodeGraphStub()
    assert stub.query(query).metadata["operation"] == operation
    assert stub.retrieve(query, top_k=2, profile="focused").metadata["top_k"] == 2
    assert stub.callers("n").metadata["tool"] == "codegraph_callers_stub"
    assert stub.callees("n").metadata["tool"] == "codegraph_callees_stub"
    assert stub.impact("n").metadata["max_depth"] == 4
    assert stub.affected_routes("n").status == "stub"
    assert stub.affected_tests("n").status == "stub"
    assert stub.architecture_report().metadata["report_type"] == "architecture_report"
    assert stub.workflow_report("q").metadata["report_type"] == "workflow_relationship_report"
    assert stub.focused_report("q").metadata["report_type"] == "focused_symbol_report"
    assert stub.compare_report("q").metadata["report_type"] == "compare_report"
    assert stub.project_inventory().metadata["file_count"] == 1

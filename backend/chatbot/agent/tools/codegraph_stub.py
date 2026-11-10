"""Read-only CodeGraph stub for deterministic tests and disabled local mode."""

from __future__ import annotations

from chatbot.agent.tools.codegraph import CodeGraphToolResult


class CodeGraphStub:
    """Deterministic CodeGraph replacement for tests and disabled local mode."""

    def query(self, query_text: str) -> CodeGraphToolResult:
        """Return a stable synthetic retrieval artifact."""

        lowered = query_text.lower()
        if "symbol" in lowered or "find" in lowered:
            operation = "find_symbol"
        elif "caller" in lowered or "callee" in lowered or "call" in lowered:
            operation = "neighbors"
        elif "search" in lowered or "file" in lowered:
            operation = "search_text"
        else:
            operation = "generic_lookup"

        return CodeGraphToolResult(
            output=(
                "CodeGraph stub result "
                f"(operation={operation}, truncated=False): received read-only "
                f"query '{query_text}'."
            ),
            available=True,
            status="stub",
            metadata={
                "tool": "codegraph_stub",
                "available": True,
                "operation": operation,
                "result_count": 1,
            },
        )
    def retrieve(
        self,
        query: str,
        top_k: int | None = None,
        max_neighbors: int | None = None,
        database: str | None = None,
        profile: str | None = None,
        candidate_k: int | None = None,
        final_k: int | None = None,
        node_types: str | None = None,
        relationship_types: str | None = None,
    ) -> CodeGraphToolResult:
        """Return a stub retrieval artifact with requested bounds recorded."""

        result = self.query(query)
        result.metadata.update(
            {
                "top_k": top_k,
                "candidate_k": candidate_k,
                "final_k": final_k,
                "max_neighbors": max_neighbors,
                "database": database,
                "retrieval_profile": profile,
                "node_types": node_types,
                "relationship_types": relationship_types,
            }
        )
        return result

    def callers(
        self,
        node_id: str,
        database: str | None = None,
        limit: int = 50,
    ) -> CodeGraphToolResult:
        return self._node_stub("codegraph_callers_stub", node_id, database, limit)

    def callees(
        self,
        node_id: str,
        database: str | None = None,
        limit: int = 50,
    ) -> CodeGraphToolResult:
        return self._node_stub("codegraph_callees_stub", node_id, database, limit)

    def impact(
        self,
        node_id: str,
        database: str | None = None,
        max_depth: int = 4,
        limit: int = 80,
    ) -> CodeGraphToolResult:
        return self._node_stub("codegraph_impact_stub", node_id, database, limit, max_depth)

    def affected_routes(
        self,
        node_id: str,
        database: str | None = None,
        max_depth: int = 5,
        limit: int = 80,
    ) -> CodeGraphToolResult:
        return self._node_stub("codegraph_affected_routes_stub", node_id, database, limit, max_depth)

    def affected_tests(
        self,
        node_id: str,
        database: str | None = None,
        max_depth: int = 5,
        limit: int = 80,
    ) -> CodeGraphToolResult:
        return self._node_stub("codegraph_affected_tests_stub", node_id, database, limit, max_depth)

    def architecture_report(
        self,
        query: str = "",
        database: str | None = None,
        max_files: int = 400,
        max_symbols: int = 3000,
        max_relationship_samples: int = 300,
    ) -> CodeGraphToolResult:
        return self._report_stub("codegraph_architecture_report_stub", "architecture_report", query, database)

    def workflow_report(
        self,
        query: str,
        database: str | None = None,
        seed_k: int | None = None,
        max_depth: int = 4,
        limit: int = 160,
    ) -> CodeGraphToolResult:
        return self._report_stub("codegraph_workflow_report_stub", "workflow_relationship_report", query, database)

    def focused_report(
        self,
        query: str,
        database: str | None = None,
        seed_k: int | None = None,
        limit: int = 120,
    ) -> CodeGraphToolResult:
        return self._report_stub("codegraph_focused_report_stub", "focused_symbol_report", query, database)

    def compare_report(
        self,
        query: str,
        database: str | None = None,
        seed_k: int | None = None,
        max_depth: int = 3,
        limit: int = 120,
    ) -> CodeGraphToolResult:
        return self._report_stub("codegraph_compare_report_stub", "compare_report", query, database)

    def _report_stub(
        self,
        tool: str,
        report_type: str,
        query: str,
        database: str | None,
    ) -> CodeGraphToolResult:
        return CodeGraphToolResult(
            output=(
                f"CodeGraph report stub result: report_type={report_type}, "
                f"query='{query}'."
            ),
            available=True,
            status="stub",
            metadata={
                "tool": tool,
                "available": True,
                "report_type": report_type,
                "database": database,
            },
        )
    def _node_stub(
        self,
        tool: str,
        node_id: str,
        database: str | None,
        limit: int,
        max_depth: int | None = None,
    ) -> CodeGraphToolResult:
        return CodeGraphToolResult(
            output=(
                f"CodeGraph node query stub result: tool={tool}, "
                f"node_id={node_id}, limit={limit}, max_depth={max_depth}."
            ),
            available=True,
            status="stub",
            metadata={
                "tool": tool,
                "available": True,
                "node_id": node_id,
                "database": database,
                "limit": limit,
                "max_depth": max_depth,
            },
        )
    def project_inventory(self) -> CodeGraphToolResult:
        """Return a stable synthetic structural inventory artifact."""

        return CodeGraphToolResult(
            output=(
                "CodeGraph project inventory stub result: files=1, classes=1, "
                "methods=1, functions=1, relationships=1. Files and symbols: "
                "stub.py contains class StubClass, method run, function helper."
            ),
            available=True,
            status="stub",
            metadata={
                "tool": "codegraph_project_inventory_stub",
                "available": True,
                "file_count": 1,
                "class_count": 1,
                "method_count": 1,
                "function_count": 1,
                "relationship_count": 1,
            },
        )

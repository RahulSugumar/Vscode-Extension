"""Read-only CodeGraph HTTP client and tool boundary."""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Protocol

import requests
import asyncio
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from chatbot.config.settings import Settings, load_settings


logger = logging.getLogger(__name__)

try:
    from graphrag_agent.api.retrieve_router import (
        affected_routes_context,
        affected_tests_context,
        architecture_report_context,
        compare_report_context,
        focused_report_context,
        impact_context,
        project_inventory_context,
        retrieve_context,
        symbol_callees,
        symbol_callers,
        workflow_report_context,
    )
except ImportError:
    affected_routes_context = None
    affected_tests_context = None
    architecture_report_context = None
    compare_report_context = None
    focused_report_context = None
    impact_context = None
    project_inventory_context = None
    retrieve_context = None
    symbol_callees = None
    symbol_callers = None
    workflow_report_context = None


class HttpClient(Protocol):
    def get(
        self,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> Any:
        ...


class CodeGraphSourceRange(BaseModel):
    """Exact source span returned by CodeGraph when available."""

    startLine: int | None = None
    startColumn: int | None = None
    endLine: int | None = None
    endColumn: int | None = None
    startByte: int | None = None
    endByte: int | None = None

class CodeGraphSeedNode(BaseModel):
    """Seed node shape returned by the external CodeGraph service."""

    id: str | None = None
    name: str | None = None
    filePath: str | None = None
    lineNumber: int | None = None
    sourceRange: CodeGraphSourceRange | None = None
    ragText: str | None = None
    type: str | None = None


class CodeGraphContext(BaseModel):
    """Neighbor context returned around a seed node."""

    id: str | None = None
    neighbors: list[dict[str, Any]] = Field(default_factory=list)


class CodeGraphResult(BaseModel):
    """One ranked retrieval result from CodeGraph."""

    model_config = ConfigDict(populate_by_name=True)

    rank: int | None = None
    seed_node: CodeGraphSeedNode = Field(alias="seedNode")
    graph_context: CodeGraphContext = Field(
        default_factory=CodeGraphContext, alias="graphContext"
    )


class CodeGraphRetrieveResponse(BaseModel):
    """Validated response body for `GET /api/retrieve`."""

    query: str
    top_k: int | None = None
    database: str | None = None
    results: list[CodeGraphResult] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class CodeGraphToolResult(BaseModel):
    """Normalized tool output consumed by the executor."""

    output: str
    available: bool
    status: str
    error: str | None = None
    truncated: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)


class CodeGraphTool:
    """Small read-only wrapper around the CodeGraph retrieval service."""

    def __init__(
        self,
        settings: Settings | None = None,
        http_client: HttpClient | None = None,
    ) -> None:
        self._settings = settings or load_settings()
        self._http = http_client or requests

    def health(self) -> CodeGraphToolResult:
        """Check whether the external CodeGraph service is reachable."""

        if not self._settings.codegraph_enabled:
            return self._unavailable("disabled", "CodeGraph is disabled.")
        
        return CodeGraphToolResult(
            output="CodeGraph service is reachable (internal).",
            available=True,
            status="ok",
            metadata={
                "tool": "codegraph",
                "codegraph_base_url": "internal",
                "health_payload": {"message": "CodeGraph service is reachable (internal)."},
            },
        )

    def query(self, query_text: str) -> CodeGraphToolResult:
        return self.retrieve(query_text)

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
        """Retrieve read-only code context and normalize service failures."""

        if not self._settings.codegraph_enabled:
            return self._unavailable("disabled", "CodeGraph is disabled.")

        params = {
            "query": query,
            "top_k": top_k,
            "max_neighbors": max_neighbors,
            "database": self._database_name(database),
            "profile": profile or "focused",
            "candidate_k": candidate_k,
            "final_k": final_k,
            "node_types": node_types,
            "relationship_types": relationship_types,
        }

        if retrieve_context is None:
            return self._unavailable(
                "dependency_unavailable",
                "CodeGraph retrieval dependency is unavailable.",
                params=params,
            )
        
        try:
            # retrieve_context is an async function in the merged backend
            payload = asyncio.run(
                retrieve_context(
                    query=params["query"],
                    top_k=params["top_k"],
                    max_neighbors=params["max_neighbors"],
                    database=params["database"],
                    profile=params["profile"],
                    candidate_k=params["candidate_k"],
                    final_k=params["final_k"],
                    node_types=params["node_types"],
                    relationship_types=params["relationship_types"],
                )
            )
        except Exception as exc:
            logger.exception("codegraph_retrieve_failed")
            return self._unavailable(
                "connection_error",
                f"CodeGraph retrieval failed: {exc.__class__.__name__}: {exc}",
                params=params,
                extra={
                    "exception_type": exc.__class__.__name__,
                    "exception_detail": str(exc),
                },
            )

        try:
            parsed = CodeGraphRetrieveResponse.model_validate(payload)
        except ValidationError as exc:
            return self._unavailable(
                "invalid_response",
                "CodeGraph retrieval response did not match the expected shape.",
                params=params,
                extra={"validation_error": exc.__class__.__name__},
            )

        if not parsed.results:
            return CodeGraphToolResult(
                output="CodeGraph returned no matching graph context.",
                available=True,
                status="empty",
                error="empty_results",
                metadata=self._metadata(params, result_count=0, extra=parsed.metadata),
            )

        output, truncated = self._format_results(parsed)
        return CodeGraphToolResult(
            output=output,
            available=True,
            status="ok",
            truncated=truncated,
            metadata=self._metadata(
                params,
                result_count=len(parsed.results),
                extra=parsed.metadata,
                seed_nodes=[
                    {
                        "id": result.seed_node.id,
                        "name": result.seed_node.name,
                        "filePath": result.seed_node.filePath,
                        "lineNumber": result.seed_node.lineNumber,
                        "sourceRange": result.seed_node.sourceRange.model_dump() if result.seed_node.sourceRange else None,
                        "type": result.seed_node.type,
                    }
                    for result in parsed.results
                ],
            ),
        )


    def project_inventory(
        self,
        database: str | None = None,
        max_files: int = 200,
        max_symbols: int = 1200,
        max_relationship_samples: int = 100,
    ) -> CodeGraphToolResult:
        """Retrieve a structural project inventory without semantic top-k search."""

        if not self._settings.codegraph_enabled:
            return self._unavailable(
                "disabled",
                "CodeGraph is disabled.",
                extra={"tool": "codegraph_project_inventory"},
            )

        params = {
            "database": self._database_name(database),
            "max_files": max_files,
            "max_symbols": max_symbols,
            "max_relationship_samples": max_relationship_samples,
        }
        if project_inventory_context is None:
            return self._unavailable(
                "dependency_unavailable",
                "CodeGraph project inventory dependency is unavailable.",
                params=params,
                extra={"tool": "codegraph_project_inventory"},
            )

        try:
            payload = asyncio.run(
                project_inventory_context(
                    database=params["database"],
                    max_files=params["max_files"],
                    max_symbols=params["max_symbols"],
                    max_relationship_samples=params["max_relationship_samples"],
                )
            )
        except Exception as exc:
            return self._unavailable(
                "connection_error",
                f"CodeGraph project inventory failed: {exc.__class__.__name__}",
                params=params,
                extra={"tool": "codegraph_project_inventory"},
            )

        if not isinstance(payload, dict):
            return self._unavailable(
                "invalid_response",
                "CodeGraph project inventory response did not match the expected shape.",
                params=params,
                extra={"tool": "codegraph_project_inventory"},
            )

        output, truncated = self._format_project_inventory(payload)
        totals = payload.get("totals") if isinstance(payload.get("totals"), dict) else {}
        return CodeGraphToolResult(
            output=output,
            available=True,
            status="ok",
            truncated=truncated,
            metadata={
                "tool": "codegraph_project_inventory",
                "codegraph_base_url": self._settings.codegraph_base_url,
                "available": True,
                "database": params["database"],
                "file_count": totals.get("files"),
                "class_count": totals.get("classes"),
                "method_count": totals.get("methods"),
                "function_count": totals.get("functions"),
                "relationship_count": totals.get("relationships"),
                "inventory_truncated": payload.get("truncated", {}),
            },
        )



    def architecture_report(
        self,
        query: str = "",
        database: str | None = None,
        max_files: int = 400,
        max_symbols: int = 3000,
        max_relationship_samples: int = 300,
    ) -> CodeGraphToolResult:
        return self._graph_report_query(
            tool="codegraph_architecture_report",
            title="CodeGraph architecture report",
            callback=architecture_report_context,
            params={
                "query": query,
                "database": self._database_name(database),
                "max_files": max_files,
                "max_symbols": max_symbols,
                "max_relationship_samples": max_relationship_samples,
            },
        )

    def workflow_report(
        self,
        query: str,
        database: str | None = None,
        seed_k: int | None = None,
        max_depth: int = 4,
        limit: int = 160,
    ) -> CodeGraphToolResult:
        return self._graph_report_query(
            tool="codegraph_workflow_report",
            title="CodeGraph workflow report",
            callback=workflow_report_context,
            params={
                "query": query,
                "database": self._database_name(database),
                "seed_k": seed_k,
                "max_depth": max_depth,
                "limit": limit,
            },
        )

    def focused_report(
        self,
        query: str,
        database: str | None = None,
        seed_k: int | None = None,
        limit: int = 120,
    ) -> CodeGraphToolResult:
        return self._graph_report_query(
            tool="codegraph_focused_report",
            title="CodeGraph focused symbol report",
            callback=focused_report_context,
            params={
                "query": query,
                "database": self._database_name(database),
                "seed_k": seed_k,
                "limit": limit,
            },
        )

    def compare_report(
        self,
        query: str,
        database: str | None = None,
        seed_k: int | None = None,
        max_depth: int = 3,
        limit: int = 120,
    ) -> CodeGraphToolResult:
        return self._graph_report_query(
            tool="codegraph_compare_report",
            title="CodeGraph compare report",
            callback=compare_report_context,
            params={
                "query": query,
                "database": self._database_name(database),
                "seed_k": seed_k,
                "max_depth": max_depth,
                "limit": limit,
            },
        )

    def _graph_report_query(
        self,
        *,
        tool: str,
        title: str,
        callback: Any,
        params: dict[str, Any],
    ) -> CodeGraphToolResult:
        if not self._settings.codegraph_enabled:
            return self._unavailable("disabled", "CodeGraph is disabled.", extra={"tool": tool})
        if callback is None:
            return self._unavailable(
                "dependency_unavailable",
                f"{title} dependency is unavailable.",
                params=params,
                extra={"tool": tool},
            )

        try:
            payload = asyncio.run(callback(**params))
        except Exception as exc:
            logger.exception(
                "codegraph_report_failed",
                extra={
                    "tool": tool,
                    "exception_type": exc.__class__.__name__,
                    "exception_detail": str(exc),
                },
            )
            return self._fallback_report_result(
                tool=tool,
                title=title,
                params=params,
                exc=exc,
            )

        if not isinstance(payload, dict):
            return self._unavailable(
                "invalid_response",
                f"{title} response did not match the expected shape.",
                params=params,
                extra={"tool": tool},
            )

        output, truncated = self._format_report_payload(payload)
        completeness = payload.get("completeness") if isinstance(payload.get("completeness"), dict) else {}
        return CodeGraphToolResult(
            output=output,
            available=True,
            status="ok",
            truncated=truncated,
            metadata={
                "tool": tool,
                "codegraph_base_url": self._settings.codegraph_base_url,
                "available": True,
                "database": params.get("database"),
                "report_type": payload.get("reportType"),
                "query": params.get("query"),
                "file_count": len(payload.get("files", [])) if isinstance(payload.get("files"), list) else None,
                "relationship_count": len(payload.get("relationships", [])) if isinstance(payload.get("relationships"), list) else None,
                "report_truncated": completeness.get("truncated"),
            },
        )

    def _fallback_report_result(
        self,
        *,
        tool: str,
        title: str,
        params: dict[str, Any],
        exc: Exception,
    ) -> CodeGraphToolResult:
        """Use a narrower CodeGraph path when a richer report endpoint fails."""

        report_error = f"{exc.__class__.__name__}: {exc}"
        fallback_label = "normal retrieval fallback"
        try:
            if tool == "codegraph_architecture_report":
                fallback_label = "project inventory fallback"
                inventory_kwargs: dict[str, Any] = {"database": params.get("database")}
                for key in ("max_files", "max_symbols", "max_relationship_samples"):
                    if isinstance(params.get(key), int):
                        inventory_kwargs[key] = params[key]
                fallback = self.project_inventory(**inventory_kwargs)
            else:
                fallback = self.retrieve(
                    query=str(params.get("query") or ""),
                    database=params.get("database"),
                    profile=self._fallback_profile_for_report_tool(tool),
                    candidate_k=params.get("seed_k"),
                    final_k=params.get("limit"),
                    max_neighbors=params.get("max_depth"),
                )
        except Exception as fallback_exc:
            logger.exception(
                "codegraph_report_fallback_failed",
                extra={
                    "tool": tool,
                    "exception_type": fallback_exc.__class__.__name__,
                    "exception_detail": str(fallback_exc),
                },
            )
            return self._unavailable(
                "connection_error",
                (
                    f"{title} failed: {report_error}\n"
                    f"Fallback also failed: {fallback_exc.__class__.__name__}: {fallback_exc}"
                ),
                params=params,
                extra={
                    "tool": tool,
                    "report_error": "connection_error",
                    "exception_type": exc.__class__.__name__,
                    "exception_detail": str(exc),
                    "fallback_exception_type": fallback_exc.__class__.__name__,
                    "fallback_exception_detail": str(fallback_exc),
                },
            )

        fallback_metadata = dict(fallback.metadata)
        fallback_tool = fallback_metadata.get("tool") or "codegraph"
        if fallback.available:
            fallback_metadata.update(
                {
                    "tool": f"{tool}_fallback",
                    "original_tool": tool,
                    "fallback_tool": fallback_tool,
                    "fallback_label": fallback_label,
                    "available": True,
                    "report_type": self._report_type_for_tool(tool),
                    "report_error": "connection_error",
                    "exception_type": exc.__class__.__name__,
                    "exception_detail": str(exc),
                }
            )
            return CodeGraphToolResult(
                output=(
                    f"{title} failed, so CodeGraph used the {fallback_label}.\n"
                    f"Report error: {report_error}\n\n"
                    f"{fallback.output}"
                ),
                available=True,
                status="fallback",
                truncated=fallback.truncated,
                metadata=fallback_metadata,
            )

        return self._unavailable(
            "connection_error",
            (
                f"{title} failed: {report_error}\n"
                f"Fallback also failed ({fallback.status}): {fallback.output}"
            ),
            params=params,
            extra={
                "tool": tool,
                "report_type": self._report_type_for_tool(tool),
                "report_error": "connection_error",
                "exception_type": exc.__class__.__name__,
                "exception_detail": str(exc),
                "fallback_tool": fallback_tool,
                "fallback_status": fallback.status,
                "fallback_error": fallback.error,
                "fallback_available": fallback.available,
            },
        )

    def _fallback_profile_for_report_tool(self, tool: str) -> str:
        return {
            "codegraph_architecture_report": "architecture",
            "codegraph_workflow_report": "workflow",
            "codegraph_focused_report": "focused",
            "codegraph_compare_report": "compare",
        }.get(tool, "focused")

    def _report_type_for_tool(self, tool: str) -> str | None:
        return {
            "codegraph_architecture_report": "architecture_report",
            "codegraph_workflow_report": "workflow_relationship_report",
            "codegraph_focused_report": "focused_symbol_report",
            "codegraph_compare_report": "compare_report",
        }.get(tool)

    def callers(
        self,
        node_id: str,
        database: str | None = None,
        limit: int = 50,
    ) -> CodeGraphToolResult:
        """Return direct CodeGraph callers for a node id."""

        return self._node_graph_query(
            tool="codegraph_callers",
            title="CodeGraph callers result",
            callback=symbol_callers,
            node_id=node_id,
            database=database,
            limit=limit,
        )

    def callees(
        self,
        node_id: str,
        database: str | None = None,
        limit: int = 50,
    ) -> CodeGraphToolResult:
        """Return direct CodeGraph callees for a node id."""

        return self._node_graph_query(
            tool="codegraph_callees",
            title="CodeGraph callees result",
            callback=symbol_callees,
            node_id=node_id,
            database=database,
            limit=limit,
        )

    def impact(
        self,
        node_id: str,
        database: str | None = None,
        max_depth: int = 4,
        limit: int = 80,
    ) -> CodeGraphToolResult:
        """Return bounded impact paths for a node id."""

        return self._node_graph_query(
            tool="codegraph_impact",
            title="CodeGraph impact result",
            callback=impact_context,
            node_id=node_id,
            database=database,
            max_depth=max_depth,
            limit=limit,
        )

    def affected_routes(
        self,
        node_id: str,
        database: str | None = None,
        max_depth: int = 5,
        limit: int = 80,
    ) -> CodeGraphToolResult:
        """Return routes/endpoints that may be affected by a node id."""

        return self._node_graph_query(
            tool="codegraph_affected_routes",
            title="CodeGraph affected routes result",
            callback=affected_routes_context,
            node_id=node_id,
            database=database,
            max_depth=max_depth,
            limit=limit,
        )

    def affected_tests(
        self,
        node_id: str,
        database: str | None = None,
        max_depth: int = 5,
        limit: int = 80,
    ) -> CodeGraphToolResult:
        """Return tests that may be affected by a node id when test nodes exist."""

        return self._node_graph_query(
            tool="codegraph_affected_tests",
            title="CodeGraph affected tests result",
            callback=affected_tests_context,
            node_id=node_id,
            database=database,
            max_depth=max_depth,
            limit=limit,
        )

    def _node_graph_query(
        self,
        *,
        tool: str,
        title: str,
        callback: Any,
        node_id: str,
        database: str | None = None,
        limit: int = 80,
        max_depth: int | None = None,
    ) -> CodeGraphToolResult:
        if not self._settings.codegraph_enabled:
            return self._unavailable("disabled", "CodeGraph is disabled.", extra={"tool": tool})
        if callback is None:
            return self._unavailable(
                "dependency_unavailable",
                f"{title} dependency is unavailable.",
                extra={"tool": tool},
            )

        params = {
            "database": self._database_name(database),
            "node_id": node_id,
            "limit": limit,
        }
        if max_depth is not None:
            params["max_depth"] = max_depth

        try:
            payload = asyncio.run(callback(**params))
        except Exception as exc:
            logger.exception("codegraph_report_failed", extra={"tool": tool})
            return self._unavailable(
                "connection_error",
                f"{title} failed: {exc.__class__.__name__}: {exc}",
                params=params,
                extra={
                    "tool": tool,
                    "exception_type": exc.__class__.__name__,
                    "exception_detail": str(exc),
                },
            )

        if not isinstance(payload, dict):
            return self._unavailable(
                "invalid_response",
                f"{title} response did not match the expected shape.",
                params=params,
                extra={"tool": tool},
            )

        output, truncated = self._format_node_graph_payload(title, payload)
        return CodeGraphToolResult(
            output=output,
            available=True,
            status="ok",
            truncated=truncated,
            metadata={
                "tool": tool,
                "codegraph_base_url": self._settings.codegraph_base_url,
                "available": True,
                "database": params["database"],
                "node_id": node_id,
                "limit": limit,
                "max_depth": max_depth,
            },
        )

    def _format_node_graph_payload(self, title: str, payload: dict[str, Any]) -> tuple[str, bool]:
        lines = [
            f"{title}:",
            f"CodeGraph database: {payload.get('database') or 'unknown'}",
            f"Node id: {payload.get('nodeId') or payload.get('node_id') or 'unknown'}",
        ]
        results = payload.get("results") if isinstance(payload.get("results"), list) else []
        if results:
            lines.append("Direct relationships:")
            for item in results[:80]:
                node = item.get("node") if isinstance(item, dict) else None
                lines.append(
                    f"- {item.get('relationshipType') if isinstance(item, dict) else 'RELATED'}: "
                    f"{_format_inventory_endpoint(node)}"
                )
        paths = payload.get("paths") if isinstance(payload.get("paths"), list) else []
        if paths:
            lines.append("Evidence paths:")
            for path in paths[:40]:
                if not isinstance(path, dict):
                    continue
                nodes = path.get("nodes") if isinstance(path.get("nodes"), list) else []
                relationships = path.get("relationships") if isinstance(path.get("relationships"), list) else []
                node_text = " -> ".join(_format_inventory_endpoint(node) for node in nodes[:8])
                rel_text = " -> ".join(str(rel) for rel in relationships[:8])
                lines.append(f"- {node_text}")
                if rel_text:
                    lines.append(f"  relationships: {rel_text}")
        if not results and not paths:
            lines.append("No matching graph paths were returned.")
        if payload.get("truncated"):
            lines.append("Result was truncated by query limits.")

        output = "\n".join(lines)
        limit = max(500, self._settings.codegraph_max_result_chars)
        if len(output) <= limit:
            return output, False
        return output[:limit].rstrip() + "\n[CodeGraph node query truncated]", True
    def _format_project_inventory(self, inventory: dict[str, Any]) -> tuple[str, bool]:
        """Convert structural inventory JSON into prompt-safe text."""

        totals = inventory.get("totals") if isinstance(inventory.get("totals"), dict) else {}
        node_counts = inventory.get("nodeTypeCounts") if isinstance(inventory.get("nodeTypeCounts"), dict) else {}
        relationship_counts = (
            inventory.get("relationshipTypeCounts")
            if isinstance(inventory.get("relationshipTypeCounts"), dict)
            else {}
        )
        lines = [
            "CodeGraph project inventory result:",
            f"CodeGraph database: {inventory.get('database') or 'unknown'}",
            "Totals:",
            f"- Nodes: {totals.get('nodes', 0)}",
            f"- Relationships: {totals.get('relationships', 0)}",
            f"- Files: {totals.get('files', 0)}",
            f"- Folders: {totals.get('folders', 0)}",
            f"- Classes: {totals.get('classes', 0)}",
            f"- Methods: {totals.get('methods', 0)}",
            f"- Functions: {totals.get('functions', 0)}",
            f"- Interfaces: {totals.get('interfaces', 0)}",
            f"- Call expressions: {totals.get('callExpressions', 0)}",
            f"- Arguments: {totals.get('arguments', 0)}",
        ]
        if node_counts:
            lines.append("Node type counts:")
            for name, count in sorted(node_counts.items()):
                lines.append(f"- {name}: {count}")
        if relationship_counts:
            lines.append("Relationship type counts:")
            for name, count in sorted(relationship_counts.items()):
                lines.append(f"- {name}: {count}")

        folders = inventory.get("folders") if isinstance(inventory.get("folders"), list) else []
        if folders:
            lines.append("Folders/modules:")
            for folder in folders[:80]:
                folder_name = folder.get("filePath") or folder.get("name") or folder.get("id") or "unnamed"
                lines.append(f"- {folder_name}")
            if len(folders) > 80:
                lines.append(f"- ... {len(folders) - 80} more folders omitted")

        files = inventory.get("files") if isinstance(inventory.get("files"), list) else []
        lines.append("Files and symbols:")
        for file_entry in files:
            file_name = (
                file_entry.get("filePath")
                or file_entry.get("name")
                or file_entry.get("id")
                or "unnamed file"
            )
            symbols = file_entry.get("symbols") if isinstance(file_entry.get("symbols"), list) else []
            lines.append(f"- {file_name} ({len(symbols)} symbols)")
            for symbol in symbols[:40]:
                lines.append(f"  - {_format_inventory_symbol(symbol)}")
            if len(symbols) > 40:
                lines.append(f"  - ... {len(symbols) - 40} more symbols omitted")

        unfiled_symbols = (
            inventory.get("unfiledSymbols")
            if isinstance(inventory.get("unfiledSymbols"), list)
            else []
        )
        if unfiled_symbols:
            lines.append("Symbols without file paths:")
            for symbol in unfiled_symbols[:80]:
                lines.append(f"- {_format_inventory_symbol(symbol)}")
            if len(unfiled_symbols) > 80:
                lines.append(f"- ... {len(unfiled_symbols) - 80} more unfiled symbols omitted")

        samples = (
            inventory.get("relationshipSamples")
            if isinstance(inventory.get("relationshipSamples"), list)
            else []
        )
        if samples:
            lines.append("Relationship samples:")
            for sample in samples[:80]:
                source = _format_inventory_endpoint(sample.get("source"))
                target = _format_inventory_endpoint(sample.get("target"))
                lines.append(f"- {source} -[{sample.get('relationshipType')}]-> {target}")

        truncated_info = inventory.get("truncated")
        if isinstance(truncated_info, dict) and any(truncated_info.values()):
            lines.append(f"Inventory limits reached: {_short_json(truncated_info)}")

        output = "\n".join(lines)
        limit = max(500, self._settings.codegraph_max_result_chars)
        if len(output) <= limit:
            return output, False
        return output[:limit].rstrip() + "\n[CodeGraph project inventory truncated]", True

    def _format_report_payload(self, payload: dict[str, Any]) -> tuple[str, bool]:
        report_type = str(payload.get("reportType") or "graph_report")
        if report_type == "architecture_report":
            lines = self._format_architecture_report(payload)
        elif report_type == "workflow_relationship_report":
            lines = self._format_workflow_report(payload, "CodeGraph workflow report")
        elif report_type == "focused_symbol_report":
            lines = self._format_workflow_report(payload, "CodeGraph focused symbol report")
        elif report_type == "compare_report":
            lines = self._format_compare_report(payload)
        else:
            lines = ["CodeGraph report result:", _short_json(payload, limit=4000)]

        output = "\n".join(lines)
        limit = self._report_limit(report_type)
        if len(output) <= limit:
            return output, False
        return output[:limit].rstrip() + f"\n[CodeGraph {report_type} truncated]", True

    def _format_architecture_report(self, payload: dict[str, Any]) -> list[str]:
        inventory = payload.get("inventory") if isinstance(payload.get("inventory"), dict) else {}
        totals = inventory.get("totals") if isinstance(inventory.get("totals"), dict) else {}
        node_counts = inventory.get("nodeTypeCounts") if isinstance(inventory.get("nodeTypeCounts"), dict) else {}
        relationship_counts = inventory.get("relationshipTypeCounts") if isinstance(inventory.get("relationshipTypeCounts"), dict) else {}
        lines = [
            "CodeGraph architecture report:",
            f"CodeGraph database: {payload.get('codegraphDatabase') or inventory.get('database') or 'unknown'}",
        ]
        if payload.get("query"):
            lines.append(f"Query: {payload.get('query')}")
        if totals:
            lines.extend(
                [
                    "Totals:",
                    f"- Nodes: {totals.get('nodes', 0)}",
                    f"- Relationships: {totals.get('relationships', 0)}",
                    f"- Files: {totals.get('files', 0)}",
                    f"- Folders: {totals.get('folders', 0)}",
                    f"- Classes: {totals.get('classes', 0)}",
                    f"- Functions: {totals.get('functions', 0)}",
                    f"- Methods: {totals.get('methods', 0)}",
                    f"- Endpoints: {totals.get('endpoints', 0)}",
                    f"- Routes: {totals.get('routes', 0)}",
                    f"- Services: {totals.get('services', 0)}",
                    f"- Repositories: {totals.get('repositories', 0)}",
                    f"- ORM models: {totals.get('ormModels', 0)}",
                    f"- Database tables: {totals.get('databaseTables', 0)}",
                ]
            )

        app_databases = payload.get("applicationDatabases") if isinstance(payload.get("applicationDatabases"), list) else []
        lines.append("Application database evidence:")
        if app_databases:
            for item in app_databases:
                evidence = item.get("evidence") if isinstance(item.get("evidence"), list) else []
                first = _format_inventory_endpoint(evidence[0]) if evidence else "no specific node"
                lines.append(f"- {item.get('name')}: {first}")
        else:
            lines.append("- No application database was detected from code/config evidence in this report.")

        router_files = payload.get("routerFiles") if isinstance(payload.get("routerFiles"), list) else []
        lines.append("Router/controller files:")
        if router_files:
            for file_item in router_files:
                lines.append(f"- {_format_inventory_endpoint(file_item)}")
        else:
            lines.append("- No router/controller files were detected by graph evidence.")

        endpoints = payload.get("endpoints") if isinstance(payload.get("endpoints"), list) else []
        if endpoints:
            lines.append("Endpoints and handlers:")
            for item in endpoints[:160]:
                endpoint = item.get("endpoint") if isinstance(item, dict) else None
                lines.append(f"- {_format_inventory_endpoint(endpoint)}")
                targets = item.get("targets") if isinstance(item.get("targets"), list) else []
                for target in targets[:8]:
                    node = target.get("node") if isinstance(target, dict) else None
                    relationship = target.get("relationshipType") if isinstance(target, dict) else "RELATED"
                    lines.append(f"  - {relationship}: {_format_inventory_endpoint(node)}")
            if len(endpoints) > 160:
                lines.append(f"- ... {len(endpoints) - 160} more endpoints omitted")

        layer_nodes = payload.get("layerNodes") if isinstance(payload.get("layerNodes"), dict) else {}
        if layer_nodes:
            lines.append("Architecture layers:")
            for node_type, nodes in sorted(layer_nodes.items()):
                if not isinstance(nodes, list):
                    continue
                rendered = ", ".join(_format_inventory_endpoint(node) for node in nodes[:20])
                lines.append(f"- {node_type} ({len(nodes)}): {rendered}")
                if len(nodes) > 20:
                    lines.append(f"  - ... {len(nodes) - 20} more {node_type} nodes omitted")

        if node_counts:
            lines.append("Node type counts:")
            for name, count in sorted(node_counts.items()):
                lines.append(f"- {name}: {count}")
        if relationship_counts:
            lines.append("Relationship type counts:")
            for name, count in sorted(relationship_counts.items()):
                lines.append(f"- {name}: {count}")

        samples = payload.get("relationshipSamples") if isinstance(payload.get("relationshipSamples"), list) else []
        if samples:
            lines.append("Architecture relationship evidence:")
            for sample in samples[:160]:
                source = _format_inventory_endpoint(sample.get("source"))
                target = _format_inventory_endpoint(sample.get("target"))
                lines.append(f"- {source} -[{sample.get('relationshipType')}]-> {target}")
            if len(samples) > 160:
                lines.append(f"- ... {len(samples) - 160} more relationships omitted")
        self._append_completeness(lines, payload)
        return lines

    def _format_workflow_report(self, payload: dict[str, Any], title: str) -> list[str]:
        lines = [
            f"{title}:",
            f"CodeGraph database: {payload.get('codegraphDatabase') or 'unknown'}",
        ]
        if payload.get("query"):
            lines.append(f"Query: {payload.get('query')}")
        retrieval = payload.get("retrieval") if isinstance(payload.get("retrieval"), dict) else {}
        if retrieval:
            lines.append(f"Seed retrieval count: {retrieval.get('resultCount', 0)}")

        seed_nodes = payload.get("seedNodes") if isinstance(payload.get("seedNodes"), list) else []
        if seed_nodes:
            lines.append("Seed nodes:")
            for node in seed_nodes[:40]:
                lines.append(f"- {_format_inventory_endpoint(node)}")

        files = payload.get("files") if isinstance(payload.get("files"), list) else []
        lines.append("All files involved:")
        if files:
            for file_item in files:
                lines.append(f"- {file_item.get('filePath')} ({file_item.get('nodeCount', 0)} related nodes)")
        else:
            lines.append("- No file-backed nodes were returned for this report.")

        paths = payload.get("paths") if isinstance(payload.get("paths"), list) else []
        if paths:
            lines.append("Evidence paths:")
            for path in paths[:80]:
                nodes = path.get("nodes") if isinstance(path.get("nodes"), list) else []
                relationships = path.get("relationships") if isinstance(path.get("relationships"), list) else []
                node_text = " -> ".join(_format_inventory_endpoint(node) for node in nodes[:10])
                rel_text = " -> ".join(str(rel.get("relationshipType")) for rel in relationships[:10] if isinstance(rel, dict))
                lines.append(f"- {node_text}")
                if rel_text:
                    lines.append(f"  relationships: {rel_text}")
            if len(paths) > 80:
                lines.append(f"- ... {len(paths) - 80} more paths omitted")

        relationships = payload.get("relationships") if isinstance(payload.get("relationships"), list) else []
        if relationships:
            lines.append("Relationship table:")
            for relationship in relationships[:160]:
                source = _format_inventory_endpoint(relationship.get("source"))
                target = _format_inventory_endpoint(relationship.get("target"))
                lines.append(f"- {source} -[{relationship.get('relationshipType')}]-> {target}")
            if len(relationships) > 160:
                lines.append(f"- ... {len(relationships) - 160} more relationships omitted")
        self._append_completeness(lines, payload)
        return lines

    def _format_compare_report(self, payload: dict[str, Any]) -> list[str]:
        lines = [
            "CodeGraph compare report:",
            f"CodeGraph database: {payload.get('codegraphDatabase') or 'unknown'}",
        ]
        if payload.get("query"):
            lines.append(f"Query: {payload.get('query')}")
        for side_name in ("left", "right"):
            side = payload.get(side_name) if isinstance(payload.get(side_name), dict) else {}
            lines.append(f"{side_name.title()} side: {side.get('query') or side_name}")
            files = side.get("files") if isinstance(side.get("files"), list) else []
            lines.append(f"- Files: {', '.join(file.get('filePath') for file in files[:30] if file.get('filePath')) or 'none returned'}")
            relationships = side.get("relationships") if isinstance(side.get("relationships"), list) else []
            lines.append(f"- Relationships returned: {len(relationships)}")
            for relationship in relationships[:50]:
                source = _format_inventory_endpoint(relationship.get("source"))
                target = _format_inventory_endpoint(relationship.get("target"))
                lines.append(f"  - {source} -[{relationship.get('relationshipType')}]-> {target}")
        shared = payload.get("sharedFiles") if isinstance(payload.get("sharedFiles"), list) else []
        left_only = payload.get("leftOnlyFiles") if isinstance(payload.get("leftOnlyFiles"), list) else []
        right_only = payload.get("rightOnlyFiles") if isinstance(payload.get("rightOnlyFiles"), list) else []
        lines.append(f"Shared files: {', '.join(shared) if shared else 'none returned'}")
        lines.append(f"Left-only files: {', '.join(left_only) if left_only else 'none returned'}")
        lines.append(f"Right-only files: {', '.join(right_only) if right_only else 'none returned'}")
        self._append_completeness(lines, payload)
        return lines

    def _append_completeness(self, lines: list[str], payload: dict[str, Any]) -> None:
        completeness = payload.get("completeness") if isinstance(payload.get("completeness"), dict) else {}
        if not completeness:
            return
        lines.append("Completeness:")
        lines.append(f"- Truncated: {completeness.get('truncated', False)}")
        if completeness.get("limits"):
            lines.append(f"- Limits: {_short_json(completeness.get('limits'), limit=800)}")

    def _report_limit(self, report_type: str) -> int:
        base = max(500, self._settings.codegraph_max_result_chars)
        if report_type == "architecture_report":
            return max(base, 60000)
        if report_type in {"workflow_relationship_report", "compare_report"}:
            return max(base, 30000)
        return base
    def _format_results(self, response: CodeGraphRetrieveResponse) -> tuple[str, bool]:
        """Convert validated CodeGraph JSON into prompt-safe profile evidence."""

        metadata = response.metadata if isinstance(response.metadata, dict) else {}
        relationship_filters = metadata.get("relationship_types") or metadata.get("expanded_relationship_types") or []
        node_filters = metadata.get("node_types") or []
        lines = [
            "CodeGraph retrieval result:",
            f"Profile: {metadata.get('profile') or metadata.get('retrieval_profile') or 'focused'}",
            f"Query: {response.query}",
            f"Result count: {len(response.results)}",
        ]
        if response.database:
            lines.append(f"CodeGraph database: {response.database}")
        if metadata:
            lines.extend(
                [
                    f"Candidate nodes searched: {metadata.get('candidate_k', metadata.get('top_k', 'unknown'))}",
                    f"Final seed nodes: {metadata.get('final_k', response.top_k if response.top_k is not None else 'unknown')}",
                    f"Max neighbors per seed: {metadata.get('max_neighbors', 'unknown')}",
                ]
            )
            if node_filters:
                lines.append(f"Seed node filters: {_format_filter_list(node_filters)}")
            if relationship_filters:
                lines.append(f"Relationship filters: {_format_filter_list(relationship_filters)}")
            if metadata.get("filter_fallback"):
                lines.append("Filter fallback: profile node filters returned no seeds, so best unfiltered candidates were used.")

        for result in response.results:
            seed = result.seed_node
            location = _format_location(seed.filePath, seed.lineNumber)
            seed_type = seed.type or "CodeNode"
            neighbor_count = len(result.graph_context.neighbors)
            lines.append("")
            lines.append(f"Seed {result.rank or '?'}: {seed_type} {seed.name or seed.id or 'unnamed node'}")
            if location:
                lines.append(f"Location: {location}")
            lines.append(f"Neighbors returned: {neighbor_count}")
            if seed.ragText:
                lines.append("Seed evidence:")
                lines.append(_untrusted_block(seed.ragText))

            if result.graph_context.neighbors:
                lines.append("Relevant neighbors:")
                for neighbor in result.graph_context.neighbors[:8]:
                    lines.append(f"- {_format_neighbor(neighbor)}")

        output = "\n".join(lines)
        limit = max(500, self._settings.codegraph_max_result_chars)
        if len(output) <= limit:
            return output, False
        return output[:limit].rstrip() + "\n[CodeGraph result truncated]", True

    def _metadata(
        self,
        params: dict[str, Any],
        *,
        result_count: int | None = None,
        extra: dict[str, Any] | None = None,
        seed_nodes: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        metadata = {
            "tool": "codegraph",
            "codegraph_base_url": self._settings.codegraph_base_url,
            "available": True,
            "top_k": params.get("top_k"),
            "candidate_k": params.get("candidate_k"),
            "final_k": params.get("final_k"),
            "max_neighbors": params.get("max_neighbors"),
            "database": params.get("database"),
            "retrieval_profile": params.get("profile"),
            "node_types": params.get("node_types"),
            "relationship_types": params.get("relationship_types"),
        }
        if result_count is not None:
            metadata["result_count"] = result_count
        if seed_nodes is not None:
            metadata["seed_nodes"] = seed_nodes
        if extra:
            metadata.update(extra)
        return metadata

    def _unavailable(
        self,
        status: str,
        output: str,
        *,
        params: dict[str, Any] | None = None,
        extra: dict[str, Any] | None = None,
    ) -> CodeGraphToolResult:
        """Return a bounded unavailable artifact instead of raising."""

        metadata = {
            "tool": "codegraph",
            "codegraph_base_url": self._settings.codegraph_base_url,
            "available": False,
        }
        if params:
            metadata.update(
                {
                    "top_k": params.get("top_k"),
                    "candidate_k": params.get("candidate_k"),
                    "final_k": params.get("final_k"),
                    "max_neighbors": params.get("max_neighbors"),
                    "database": params.get("database"),
                    "retrieval_profile": params.get("profile"),
                    "node_types": params.get("node_types"),
                    "relationship_types": params.get("relationship_types"),
                }
            )
        if extra:
            metadata.update(extra)
        return CodeGraphToolResult(
            output=output,
            available=False,
            status=status,
            error=status,
            metadata=metadata,
        )

    def _url(self, path: str) -> str:
        return f"{self._settings.codegraph_base_url.rstrip('/')}/{path.lstrip('/')}"

    def _database_name(self, value: str | None = None) -> str:
        return (
            (value or "").strip()
            or os.environ.get("CODEGRAPH_DATABASE", "").strip()
            or os.environ.get("NEO4J_DATABASE", "").strip()
            or self._settings.codegraph_database
            or "neo4j"
        )



def _format_filter_list(values: Any, limit: int = 18) -> str:
    if not isinstance(values, list):
        return str(values)
    rendered = [str(value) for value in values if str(value).strip()]
    if len(rendered) <= limit:
        return ", ".join(rendered)
    return ", ".join(rendered[:limit]) + f", ... {len(rendered) - limit} more"


def _format_neighbor(neighbor: Any) -> str:
    if not isinstance(neighbor, dict):
        return str(neighbor)
    relationship = neighbor.get("relationshipType") or "RELATED"
    direction = neighbor.get("direction") or ""
    node = neighbor.get("node") if isinstance(neighbor.get("node"), dict) else {}
    endpoint = _format_inventory_endpoint(node)
    arrow = "->" if direction == "OUT" else "<-" if direction == "IN" else "--"
    return f"{arrow} {relationship} {endpoint}"


def _format_inventory_symbol(symbol: Any) -> str:
    if not isinstance(symbol, dict):
        return str(symbol)
    symbol_type = symbol.get("type") or "Symbol"
    name = symbol.get("name") or symbol.get("id") or "unnamed"
    location = _format_location(symbol.get("filePath"), symbol.get("lineNumber"))
    if location:
        return f"{symbol_type} {name} ({location})"
    return f"{symbol_type} {name}"


def _format_inventory_endpoint(endpoint: Any) -> str:
    if not isinstance(endpoint, dict):
        return str(endpoint)
    endpoint_type = endpoint.get("type") or "Node"
    name = endpoint.get("name") or endpoint.get("id") or "unnamed"
    location = _format_location(endpoint.get("filePath"), endpoint.get("lineNumber"))
    if location:
        return f"{endpoint_type} {name} ({location})"
    return f"{endpoint_type} {name}"
def build_codegraph_tool(settings: Settings | None = None) -> CodeGraphTool:
    return CodeGraphTool(settings=settings)


def _safe_json(response: Any) -> Any:
    try:
        return response.json()
    except (ValueError, json.JSONDecodeError, TypeError, AttributeError):
        return None


def _format_location(file_path: str | None, line_number: int | None) -> str:
    if not file_path:
        return ""
    if line_number is None:
        return file_path
    return f"{file_path}:{line_number}"


def _short_json(value: dict[str, Any], limit: int = 400) -> str:
    text = json.dumps(value, ensure_ascii=True, sort_keys=True)
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "..."


def _untrusted_block(text: str) -> str:
    """Delimit retrieved text so prompts treat it as evidence, not instruction."""

    return (
        "<UNTRUSTED_CODEGRAPH_EVIDENCE>\n"
        f"{text}\n"
        "</UNTRUSTED_CODEGRAPH_EVIDENCE>"
    )

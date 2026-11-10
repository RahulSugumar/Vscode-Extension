"""Deterministic CodeGraph reports built from graph traversal.

These reports sit above semantic retrieval: vector/fulltext search finds good
seed nodes, then bounded Cypher traversal collects the connected evidence that
answers need for architecture, workflow, focused, and compare questions.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

from graphrag_agent.services.neo4j_service import get_driver
from graphrag_agent.services.rag_service import fetch_project_inventory


ARCHITECTURE_NODE_TYPES = (
    "Controller",
    "Service",
    "Repository",
    "ReactComponent",
    "AngularComponent",
    "AngularService",
    "FrameworkModule",
    "Route",
    "Endpoint",
    "ORMModel",
    "DatabaseTable",
    "ConfigFile",
    "Dependency",
    "Package",
    "Module",
    "Namespace",
)

ARCHITECTURE_RELATIONSHIPS = (
    "CONTAINS",
    "IMPORTS",
    "IMPORTS_FROM",
    "EXPORTS",
    "REEXPORTS",
    "DEPENDS_ON",
    "USED_BY",
    "EXTENDS",
    "IMPLEMENTS",
    "INSTANTIATES",
    "ROUTES_TO",
    "HANDLES",
    "CALLS",
    "REF_CALL",
    "CALLS_SERVICE",
    "QUERIES_TABLE",
    "USES_MODEL",
    "RENDERS",
    "BINDS_TEMPLATE",
)

WORKFLOW_RELATIONSHIPS = (
    "CONTAINS",
    "ROUTES_TO",
    "HANDLES",
    "CALLS",
    "REF_CALL",
    "CALL_SITE_OF",
    "HAS_ARGUMENT",
    "ARGUMENT_FLOWS_TO_PARAMETER",
    "RECEIVER_OF",
    "RETURN_FLOWS_TO_CALLER",
    "CALLS_SERVICE",
    "QUERIES_TABLE",
    "USES_MODEL",
    "READS",
    "WRITES",
    "ASSIGNS",
    "USES_VALUE",
    "DEFINES_VALUE",
    "REACHING_DEF",
    "FLOWS_TO",
    "FIELD_READ",
    "FIELD_WRITE",
    "CFG_NEXT",
    "BRANCH_TRUE",
    "BRANCH_FALSE",
    "LOOP_BACK",
    "EXCEPTION_FLOW",
    "RETURNS_TO",
    "RETURN_FLOWS_TO",
)

FOCUSED_RELATIONSHIPS = (
    "CONTAINS",
    "DEFINES",
    "DECLARES",
    "HAS_OCCURRENCE",
    "REFERS_TO",
    "RESOLVES_TO",
    "REF_CALL",
    "CALLS",
    "IMPORTS_FROM",
    "HAS_PARAM",
    "HAS_FIELD",
    "HAS_PROPERTY",
    "TYPE_OF",
    "RETURNS",
    "DOCUMENTS",
    "ANNOTATED_BY",
)


def fetch_architecture_report(
    database: str,
    *,
    max_files: int = 400,
    max_symbols: int = 3000,
    max_relationship_samples: int = 300,
) -> dict[str, Any]:
    """Return a broad architecture report without top-k semantic truncation."""

    inventory = fetch_project_inventory(
        database,
        max_files=max_files,
        max_symbols=max_symbols,
        max_relationship_samples=max_relationship_samples,
    )
    driver = get_driver()
    with driver.session(database=database) as session:
        router_files = [
            _record_node(record, "file")
            for record in session.run(
                """
                MATCH (file:CodeNode)
                WHERE any(label IN labels(file) WHERE label = 'File')
                  AND (
                    toLower(coalesce(file.filePath, file.name, '')) CONTAINS 'router'
                    OR toLower(coalesce(file.filePath, file.name, '')) CONTAINS 'route'
                    OR toLower(coalesce(file.filePath, file.name, '')) CONTAINS 'controller'
                    OR EXISTS {
                      MATCH (member:CodeNode)
                      WHERE member.filePath = file.filePath
                        AND any(label IN labels(member) WHERE label IN ['Route', 'Endpoint', 'Controller'])
                    }
                  )
                RETURN file.id AS fileId,
                       coalesce(file.name, '') AS fileName,
                       coalesce(file.filePath, '') AS fileFilePath,
                       file.lineNumber AS fileLineNumber,
                       labels(file) AS fileLabels
                ORDER BY coalesce(file.filePath, ''), coalesce(file.name, '')
                LIMIT $limit
                """,
                limit=max_files,
            )
        ]
        endpoints = [
            {
                "endpoint": _record_node(record, "endpoint"),
                "targets": record.get("targets") or [],
            }
            for record in session.run(
                """
                MATCH (endpoint:CodeNode)
                WHERE any(label IN labels(endpoint) WHERE label IN ['Route', 'Endpoint'])
                OPTIONAL MATCH (endpoint)-[r]->(target:CodeNode)
                WHERE type(r) IN ['ROUTES_TO', 'HANDLES', 'CALLS', 'REF_CALL', 'CALLS_SERVICE']
                WITH endpoint,
                     collect(DISTINCT {
                       relationshipType: type(r),
                       node: {
                         id: target.id,
                         name: coalesce(target.name, ''),
                         type: head([label IN labels(target) WHERE label <> 'CodeNode']),
                         filePath: coalesce(target.filePath, ''),
                         lineNumber: target.lineNumber
                       }
                     }) AS rawTargets
                RETURN endpoint.id AS endpointId,
                       coalesce(endpoint.name, '') AS endpointName,
                       coalesce(endpoint.filePath, '') AS endpointFilePath,
                       endpoint.lineNumber AS endpointLineNumber,
                       labels(endpoint) AS endpointLabels,
                       [target IN rawTargets WHERE target.node.id IS NOT NULL] AS targets
                ORDER BY coalesce(endpoint.filePath, ''), coalesce(endpoint.lineNumber, 0), coalesce(endpoint.name, '')
                LIMIT $limit
                """,
                limit=max_symbols,
            )
        ]
        layer_nodes = [
            _record_node(record, "node")
            for record in session.run(
                """
                MATCH (node:CodeNode)
                WHERE any(label IN labels(node) WHERE label IN $nodeTypes)
                RETURN node.id AS nodeId,
                       coalesce(node.name, '') AS nodeName,
                       coalesce(node.filePath, '') AS nodeFilePath,
                       node.lineNumber AS nodeLineNumber,
                       labels(node) AS nodeLabels
                ORDER BY head([label IN labels(node) WHERE label <> 'CodeNode']),
                         coalesce(node.filePath, ''),
                         coalesce(node.name, '')
                LIMIT $limit
                """,
                nodeTypes=list(ARCHITECTURE_NODE_TYPES),
                limit=max_symbols,
            )
        ]
        relationship_samples = _relationship_samples(
            session,
            ARCHITECTURE_RELATIONSHIPS,
            max_relationship_samples,
        )

    return {
        "reportType": "architecture_report",
        "codegraphDatabase": database,
        "inventory": inventory,
        "routerFiles": router_files,
        "endpoints": endpoints,
        "layerNodes": _group_nodes_by_type(layer_nodes),
        "relationshipSamples": relationship_samples,
        "applicationDatabases": detect_application_databases(database),
        "completeness": {
            "truncated": {
                "inventory": inventory.get("truncated", {}),
                "routerFiles": len(router_files) >= max_files,
                "endpoints": len(endpoints) >= max_symbols,
                "layerNodes": len(layer_nodes) >= max_symbols,
                "relationshipSamples": len(relationship_samples) >= max_relationship_samples,
            },
            "limits": {
                "maxFiles": max_files,
                "maxSymbols": max_symbols,
                "maxRelationshipSamples": max_relationship_samples,
            },
        },
    }


def fetch_workflow_report(
    database: str,
    query: str,
    seed_ids: list[str],
    *,
    max_depth: int = 4,
    limit: int = 160,
) -> dict[str, Any]:
    """Return connected workflow evidence around semantic seed nodes."""

    max_depth = _bounded_int(max_depth, 4, 1, 6)
    limit = _bounded_int(limit, 160, 1, 400)
    report = _fetch_path_report(
        database,
        query,
        seed_ids,
        WORKFLOW_RELATIONSHIPS,
        max_depth=max_depth,
        limit=limit,
    )
    report["reportType"] = "workflow_relationship_report"
    return report


def fetch_focused_symbol_report(
    database: str,
    query: str,
    seed_ids: list[str],
    *,
    limit: int = 120,
) -> dict[str, Any]:
    """Return definitions, references, callers, and direct symbol context."""

    limit = _bounded_int(limit, 120, 1, 300)
    seed_ids = _clean_seed_ids(seed_ids)
    seed_nodes = _fetch_nodes_by_id(database, seed_ids)
    driver = get_driver()
    with driver.session(database=database) as session:
        relationships = [
            {
                "relationshipType": record["relationshipType"],
                "direction": record["direction"],
                "source": _record_node(record, "source"),
                "target": _record_node(record, "target"),
            }
            for record in session.run(
                """
                MATCH (seed:CodeNode)-[r]-(other:CodeNode)
                WHERE seed.id IN $seedIds AND type(r) IN $relationships
                RETURN type(r) AS relationshipType,
                       CASE WHEN startNode(r) = seed THEN 'OUT' ELSE 'IN' END AS direction,
                       startNode(r).id AS sourceId,
                       coalesce(startNode(r).name, '') AS sourceName,
                       coalesce(startNode(r).filePath, '') AS sourceFilePath,
                       startNode(r).lineNumber AS sourceLineNumber,
                       labels(startNode(r)) AS sourceLabels,
                       endNode(r).id AS targetId,
                       coalesce(endNode(r).name, '') AS targetName,
                       coalesce(endNode(r).filePath, '') AS targetFilePath,
                       endNode(r).lineNumber AS targetLineNumber,
                       labels(endNode(r)) AS targetLabels
                ORDER BY relationshipType, sourceFilePath, sourceName, targetName
                LIMIT $limit
                """,
                seedIds=seed_ids,
                relationships=list(FOCUSED_RELATIONSHIPS),
                limit=limit,
            )
        ]
    nodes = _unique_nodes([*seed_nodes, *[rel["source"] for rel in relationships], *[rel["target"] for rel in relationships]])
    return {
        "reportType": "focused_symbol_report",
        "query": query,
        "codegraphDatabase": database,
        "seedIds": seed_ids,
        "seedNodes": seed_nodes,
        "files": _files_from_nodes(nodes),
        "nodes": nodes,
        "relationships": _unique_relationships(relationships),
        "relationshipTypes": list(FOCUSED_RELATIONSHIPS),
        "completeness": {
            "truncated": len(relationships) >= limit,
            "limits": {"maxRelationships": limit},
        },
    }


def fetch_compare_report(
    database: str,
    query: str,
    left_query: str,
    right_query: str,
    left_seed_ids: list[str],
    right_seed_ids: list[str],
    *,
    max_depth: int = 3,
    limit: int = 120,
) -> dict[str, Any]:
    """Return balanced evidence for two compared code targets."""

    left = fetch_workflow_report(
        database,
        left_query,
        left_seed_ids,
        max_depth=max_depth,
        limit=max(1, limit // 2),
    )
    right = fetch_workflow_report(
        database,
        right_query,
        right_seed_ids,
        max_depth=max_depth,
        limit=max(1, limit // 2),
    )
    left_files = {file_item["filePath"] for file_item in left.get("files", [])}
    right_files = {file_item["filePath"] for file_item in right.get("files", [])}
    return {
        "reportType": "compare_report",
        "query": query,
        "codegraphDatabase": database,
        "left": left,
        "right": right,
        "sharedFiles": sorted(left_files & right_files),
        "leftOnlyFiles": sorted(left_files - right_files),
        "rightOnlyFiles": sorted(right_files - left_files),
        "completeness": {
            "truncated": bool(
                left.get("completeness", {}).get("truncated")
                or right.get("completeness", {}).get("truncated")
            ),
            "limits": {"maxDepth": max_depth, "maxPathsPerSide": max(1, limit // 2)},
        },
    }


def detect_application_databases(database: str, *, limit: int = 1000) -> list[dict[str, Any]]:
    """Detect app databases only from code/config evidence, not CodeGraph storage."""

    signatures = {
        "PostgreSQL": ("postgres", "postgresql", "psycopg", "asyncpg"),
        "MySQL": ("mysql", "pymysql", "mariadb"),
        "SQLite": ("sqlite", "sqlite3"),
        "MongoDB": ("mongodb", "mongoengine", "pymongo"),
        "Redis": ("redis",),
        "SQL Server": ("sql server", "mssql", "pyodbc"),
        "Oracle": ("oracle", "cx_oracle"),
        "Neo4j": ("neo4j", "bolt://", "neo4j+s://"),
    }
    driver = get_driver()
    with driver.session(database=database) as session:
        records = list(
            session.run(
                """
                MATCH (node:CodeNode)
                WHERE any(label IN labels(node) WHERE label IN ['Dependency', 'ConfigFile', 'Repository', 'ORMModel', 'DatabaseTable', 'File'])
                RETURN node.id AS nodeId,
                       coalesce(node.name, '') AS nodeName,
                       coalesce(node.filePath, '') AS nodeFilePath,
                       node.lineNumber AS nodeLineNumber,
                       labels(node) AS nodeLabels,
                       coalesce(node.ragText, '') AS ragText
                LIMIT $limit
                """,
                limit=limit,
            )
        )

    found: dict[str, dict[str, Any]] = {}
    for record in records:
        text = " ".join(
            str(record.get(key) or "")
            for key in ("nodeName", "nodeFilePath", "ragText")
        ).lower()
        for database_name, needles in signatures.items():
            if any(needle in text for needle in needles):
                evidence = found.setdefault(
                    database_name,
                    {"name": database_name, "evidence": []},
                )
                if len(evidence["evidence"]) < 5:
                    evidence["evidence"].append(_record_node(record, "node"))
    return sorted(found.values(), key=lambda item: item["name"])


def split_compare_targets(query: str) -> tuple[str, str]:
    """Best-effort target extraction for compare-style questions."""

    cleaned = " ".join(query.strip().split())
    patterns = (
        r"\bbetween\s+(.+?)\s+and\s+(.+)$",
        r"\bcompare\s+(.+?)\s+(?:and|with|vs\.?|versus)\s+(.+)$",
        r"\bdifference\s+between\s+(.+?)\s+and\s+(.+)$",
    )
    for pattern in patterns:
        match = re.search(pattern, cleaned, re.IGNORECASE)
        if match:
            return match.group(1).strip(" ?."), match.group(2).strip(" ?.")
    return cleaned, cleaned


def _fetch_path_report(
    database: str,
    query: str,
    seed_ids: list[str],
    relationships: Iterable[str],
    *,
    max_depth: int,
    limit: int,
) -> dict[str, Any]:
    seed_ids = _clean_seed_ids(seed_ids)
    relationship_list = list(dict.fromkeys(relationships))
    seed_nodes = _fetch_nodes_by_id(database, seed_ids)
    if not seed_ids:
        return {
            "query": query,
            "codegraphDatabase": database,
            "seedIds": [],
            "seedNodes": [],
            "files": [],
            "nodes": [],
            "relationships": [],
            "paths": [],
            "relationshipTypes": relationship_list,
            "completeness": {
                "truncated": False,
                "limits": {"maxDepth": max_depth, "maxPaths": limit},
            },
        }

    driver = get_driver()
    cypher = f"""
    MATCH (seed:CodeNode)
    WHERE seed.id IN $seedIds
    MATCH path = (seed)-[*1..{max_depth}]-(node:CodeNode)
    WHERE seed <> node
      AND all(rel IN relationships(path) WHERE type(rel) IN $relationships)
    RETURN [n IN nodes(path) | {{
             id: n.id,
             name: coalesce(n.name, ''),
             type: head([label IN labels(n) WHERE label <> 'CodeNode']),
             filePath: coalesce(n.filePath, ''),
             lineNumber: n.lineNumber,
             labels: labels(n)
           }}] AS nodes,
           [r IN relationships(path) | {{
             relationshipType: type(r),
             source: {{
               id: startNode(r).id,
               name: coalesce(startNode(r).name, ''),
               type: head([label IN labels(startNode(r)) WHERE label <> 'CodeNode']),
               filePath: coalesce(startNode(r).filePath, ''),
               lineNumber: startNode(r).lineNumber
             }},
             target: {{
               id: endNode(r).id,
               name: coalesce(endNode(r).name, ''),
               type: head([label IN labels(endNode(r)) WHERE label <> 'CodeNode']),
               filePath: coalesce(endNode(r).filePath, ''),
               lineNumber: endNode(r).lineNumber
             }}
           }}] AS relationships
    LIMIT $limit
    """
    with driver.session(database=database) as session:
        paths = [
            {"nodes": record["nodes"], "relationships": record["relationships"]}
            for record in session.run(
                cypher,
                seedIds=seed_ids,
                relationships=relationship_list,
                limit=limit,
            )
        ]

    nodes = _unique_nodes(
        [
            *seed_nodes,
            *[
                node
                for path in paths
                for node in path.get("nodes", [])
                if isinstance(node, dict)
            ],
        ]
    )
    path_relationships = [
        relationship
        for path in paths
        for relationship in path.get("relationships", [])
        if isinstance(relationship, dict)
    ]
    return {
        "query": query,
        "codegraphDatabase": database,
        "seedIds": seed_ids,
        "seedNodes": seed_nodes,
        "files": _files_from_nodes(nodes),
        "nodes": nodes,
        "relationships": _unique_relationships(path_relationships),
        "paths": paths,
        "relationshipTypes": relationship_list,
        "completeness": {
            "truncated": len(paths) >= limit,
            "limits": {"maxDepth": max_depth, "maxPaths": limit},
        },
    }


def _fetch_nodes_by_id(database: str, node_ids: list[str]) -> list[dict[str, Any]]:
    if not node_ids:
        return []
    driver = get_driver()
    with driver.session(database=database) as session:
        return [
            _record_node(record, "node")
            for record in session.run(
                """
                MATCH (node:CodeNode)
                WHERE node.id IN $nodeIds
                RETURN node.id AS nodeId,
                       coalesce(node.name, '') AS nodeName,
                       coalesce(node.filePath, '') AS nodeFilePath,
                       node.lineNumber AS nodeLineNumber,
                       labels(node) AS nodeLabels
                """,
                nodeIds=node_ids,
            )
        ]


def _relationship_samples(session: Any, relationships: Iterable[str], limit: int) -> list[dict[str, Any]]:
    return [
        {
            "relationshipType": record["relationshipType"],
            "source": _record_node(record, "source"),
            "target": _record_node(record, "target"),
        }
        for record in session.run(
            """
            MATCH (source:CodeNode)-[r]->(target:CodeNode)
            WHERE type(r) IN $relationships
            RETURN type(r) AS relationshipType,
                   source.id AS sourceId,
                   coalesce(source.name, '') AS sourceName,
                   coalesce(source.filePath, '') AS sourceFilePath,
                   source.lineNumber AS sourceLineNumber,
                   labels(source) AS sourceLabels,
                   target.id AS targetId,
                   coalesce(target.name, '') AS targetName,
                   coalesce(target.filePath, '') AS targetFilePath,
                   target.lineNumber AS targetLineNumber,
                   labels(target) AS targetLabels
            ORDER BY relationshipType, sourceFilePath, sourceName, targetName
            LIMIT $limit
            """,
            relationships=list(relationships),
            limit=limit,
        )
    ]


def _record_node(record: Any, prefix: str) -> dict[str, Any]:
    labels = list(record.get(f"{prefix}Labels") or [])
    return {
        "id": record.get(f"{prefix}Id"),
        "name": record.get(f"{prefix}Name") or "",
        "type": _primary_type(labels),
        "filePath": record.get(f"{prefix}FilePath") or "",
        "lineNumber": record.get(f"{prefix}LineNumber"),
        "labels": labels,
    }


def _primary_type(labels: list[str]) -> str:
    for label in labels:
        if label != "CodeNode":
            return label
    return "Unknown"


def _group_nodes_by_type(nodes: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for node in nodes:
        grouped.setdefault(node.get("type") or "Unknown", []).append(node)
    return dict(sorted(grouped.items()))


def _clean_seed_ids(seed_ids: list[str]) -> list[str]:
    cleaned = []
    seen = set()
    for node_id in seed_ids:
        value = str(node_id or "").strip()
        if not value or value in seen:
            continue
        cleaned.append(value)
        seen.add(value)
    return cleaned


def _files_from_nodes(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    files: dict[str, dict[str, Any]] = {}
    for node in nodes:
        file_path = node.get("filePath") or ""
        if not file_path:
            continue
        entry = files.setdefault(
            file_path,
            {"filePath": file_path, "nodes": [], "nodeCount": 0},
        )
        entry["nodes"].append(
            {
                "id": node.get("id"),
                "name": node.get("name"),
                "type": node.get("type"),
                "lineNumber": node.get("lineNumber"),
            }
        )
        entry["nodeCount"] = len(entry["nodes"])
    return sorted(files.values(), key=lambda item: item["filePath"])


def _unique_nodes(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    unique: dict[str, dict[str, Any]] = {}
    for node in nodes:
        node_id = node.get("id")
        if not node_id or node_id in unique:
            continue
        unique[node_id] = node
    return list(unique.values())


def _unique_relationships(relationships: list[dict[str, Any]]) -> list[dict[str, Any]]:
    unique: dict[tuple[str, str, str], dict[str, Any]] = {}
    for relationship in relationships:
        source = relationship.get("source") or {}
        target = relationship.get("target") or {}
        key = (
            str(source.get("id") or ""),
            str(relationship.get("relationshipType") or ""),
            str(target.get("id") or ""),
        )
        if key in unique:
            continue
        unique[key] = relationship
    return list(unique.values())


def _bounded_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(parsed, maximum))

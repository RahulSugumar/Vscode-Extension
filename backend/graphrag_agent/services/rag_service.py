import logging
import inspect
import re
from typing import Dict, Any, List
from neo4j_graphrag.retrievers import HybridRetriever
from graphrag_agent.services.neo4j_service import get_driver
from graphrag_agent.services.embedding_service import get_embedder
from graphrag_agent.services.retrieval_profiles import expand_relationship_dependencies

log = logging.getLogger("rag_service")

DEFAULT_VECTOR_INDEX = "codegraph_codenode_ragEmbedding"
DEFAULT_FULLTEXT_INDEX = "codegraph_codenode_ragText"
DEFAULT_RETURN_PROPERTIES = [
    "id",
    "name",
    "type",
    "filePath",
    "lineNumber",
    "ragText",
    "ragEmbeddingModel",
    "ragEmbeddingDim",
    "sourceStartLine",
    "sourceStartColumn",
    "sourceEndLine",
    "sourceEndColumn",
    "sourceStartByte",
    "sourceEndByte",
]

_FULLTEXT_PARSE_ERROR_MARKERS = (
    "Could not parse the given fulltext search query",
    "TokenMgrError",
    "db.index.fulltext.queryNodes",
)

def fetch_graph_context(
    database: str,
    seed_ids: List[str],
    max_neighbors: int,
    relationship_types: List[str] | None = None,
) -> Dict[str, Dict[str, Any]]:
    if not seed_ids:
        return {}

    selected_relationships = expand_relationship_dependencies(relationship_types or []) or None
    driver = get_driver()
    query = """
    UNWIND $seed_ids AS seed_id
    MATCH (seed:CodeNode {id: seed_id})
    OPTIONAL MATCH (seed)-[r]-(nbr:CodeNode)
    WHERE r IS NULL OR $relationship_types IS NULL OR type(r) IN $relationship_types
    WITH
      seed,
      collect(DISTINCT {
        relationshipType: type(r),
        direction: CASE
          WHEN r IS NULL THEN NULL
          WHEN startNode(r) = seed THEN 'OUT'
          ELSE 'IN'
        END,
        node: {
          id: nbr.id,
          name: coalesce(nbr.name, ''),
          type: head([label IN labels(nbr) WHERE label <> 'CodeNode']),
          filePath: coalesce(nbr.filePath, ''),
          lineNumber: nbr.lineNumber,
          sourceRange: {
            startLine: nbr.sourceStartLine,
            startColumn: nbr.sourceStartColumn,
            endLine: nbr.sourceEndLine,
            endColumn: nbr.sourceEndColumn,
            startByte: nbr.sourceStartByte,
            endByte: nbr.sourceEndByte
          },
          labels: labels(nbr),
          ragText: coalesce(nbr.ragText, '')
        }
      }) AS raw_neighbors
    RETURN
      seed.id AS seedId,
      {
        id: seed.id,
        name: coalesce(seed.name, ''),
        type: head([label IN labels(seed) WHERE label <> 'CodeNode']),
        filePath: coalesce(seed.filePath, ''),
        lineNumber: seed.lineNumber,
        sourceRange: {
          startLine: seed.sourceStartLine,
          startColumn: seed.sourceStartColumn,
          endLine: seed.sourceEndLine,
          endColumn: seed.sourceEndColumn,
          startByte: seed.sourceStartByte,
          endByte: seed.sourceEndByte
        },
        labels: labels(seed),
        ragText: coalesce(seed.ragText, ''),
        neighbors: [x IN raw_neighbors WHERE x.node.id IS NOT NULL]
      } AS context
    """

    contexts: Dict[str, Dict[str, Any]] = {}
    with driver.session(database=database) as session:
        records = session.run(
            query,
            seed_ids=seed_ids,
            relationship_types=selected_relationships,
        )
        for record in records:
            context = record["context"]
            context["neighbors"] = context["neighbors"][:max_neighbors]
            contexts[record["seedId"]] = context
    return contexts


def fetch_total_code_node_count(database: str) -> int:
    driver = get_driver()
    with driver.session(database=database) as session:
        record = session.run("MATCH (n:CodeNode) RETURN count(n) AS count").single()
    return int(record["count"] if record else 0)

INVENTORY_SYMBOL_TYPES = (
    "Class",
    "Method",
    "Function",
    "Interface",
    "Namespace",
    "Field",
    "Property",
    "Variable",
    "Constant",
    "Import",
    "Export",
    "TypeAlias",
    "Enum",
    "EnumMember",
    "ConfigFile",
    "Dependency",
    "Route",
    "Endpoint",
    "Controller",
    "Service",
    "Repository",
    "ReactComponent",
    "AngularComponent",
    "AngularService",
    "FrameworkModule",
    "Hook",
    "StateVariable",
    "EventHandler",
    "ORMModel",
    "DatabaseTable",
    "MessageTopic",
    "Template",
    "BasicBlock",
    "IfStatement",
    "Loop",
    "SwitchCase",
    "TryCatch",
    "ReturnStatement",
    "ThrowStatement",
    "BreakStatement",
    "ContinueStatement",
    "Value",
    "Assignment",
    "Expression",
    "SourceExpression",
    "SinkExpression",
)


def fetch_project_inventory(
    database: str,
    *,
    max_files: int = 200,
    max_symbols: int = 1000,
    max_relationship_samples: int = 80,
) -> Dict[str, Any]:
    """Return a structural project inventory from Neo4j, bypassing retrieval."""

    driver = get_driver()
    max_files = max(1, min(max_files, 500))
    max_symbols = max(1, min(max_symbols, 5000))
    max_relationship_samples = max(0, min(max_relationship_samples, 500))

    with driver.session(database=database) as session:
        node_type_counts = {
            record["nodeType"]: int(record["count"])
            for record in session.run(
                """
                MATCH (n:CodeNode)
                WITH [label IN labels(n) WHERE label <> 'CodeNode'] AS typeLabels
                UNWIND CASE WHEN size(typeLabels) = 0 THEN ['Unknown'] ELSE typeLabels END AS nodeType
                RETURN nodeType, count(*) AS count
                ORDER BY nodeType
                """
            )
        }
        relationship_type_counts = {
            record["relationshipType"]: int(record["count"])
            for record in session.run(
                """
                MATCH (:CodeNode)-[r]->(:CodeNode)
                RETURN type(r) AS relationshipType, count(*) AS count
                ORDER BY relationshipType
                """
            )
        }
        folders = [
            _node_record(record)
            for record in session.run(
                """
                MATCH (n:CodeNode)
                WHERE any(label IN labels(n) WHERE label = 'Folder')
                RETURN n.id AS id,
                       coalesce(n.name, '') AS name,
                       coalesce(n.filePath, '') AS filePath,
                       n.lineNumber AS lineNumber,
                       labels(n) AS labels,
                       coalesce(n.ragText, '') AS ragText
                ORDER BY name
                LIMIT $limit
                """,
                limit=max_files,
            )
        ]
        file_records = [
            _node_record(record)
            for record in session.run(
                """
                MATCH (n:CodeNode)
                WHERE any(label IN labels(n) WHERE label = 'File')
                RETURN n.id AS id,
                       coalesce(n.name, '') AS name,
                       coalesce(n.filePath, '') AS filePath,
                       n.lineNumber AS lineNumber,
                       labels(n) AS labels,
                       coalesce(n.ragText, '') AS ragText
                ORDER BY coalesce(n.filePath, ''), coalesce(n.name, '')
                LIMIT $limit
                """,
                limit=max_files,
            )
        ]
        symbol_records = [
            _node_record(record)
            for record in session.run(
                """
                MATCH (n:CodeNode)
                WHERE any(label IN labels(n) WHERE label IN $symbolTypes)
                RETURN n.id AS id,
                       coalesce(n.name, '') AS name,
                       coalesce(n.filePath, '') AS filePath,
                       n.lineNumber AS lineNumber,
                       labels(n) AS labels,
                       coalesce(n.ragText, '') AS ragText
                ORDER BY coalesce(n.filePath, ''), coalesce(n.lineNumber, 0), coalesce(n.name, '')
                LIMIT $limit
                """,
                symbolTypes=list(INVENTORY_SYMBOL_TYPES),
                limit=max_symbols,
            )
        ]
        relationship_samples = [
            {
                "relationshipType": record["relationshipType"],
                "source": _compact_endpoint(record, "source"),
                "target": _compact_endpoint(record, "target"),
            }
            for record in session.run(
                """
                MATCH (source:CodeNode)-[r]->(target:CodeNode)
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
                limit=max_relationship_samples,
            )
        ]

    files = _group_symbols_by_file(file_records, symbol_records)
    unfiled_symbols = [symbol for symbol in symbol_records if not symbol.get("filePath")]
    total_nodes = sum(node_type_counts.values())
    total_relationships = sum(relationship_type_counts.values())
    return {
        "database": database,
        "limits": {
            "maxFiles": max_files,
            "maxSymbols": max_symbols,
            "maxRelationshipSamples": max_relationship_samples,
        },
        "totals": {
            "nodes": total_nodes,
            "relationships": total_relationships,
            "files": node_type_counts.get("File", 0),
            "folders": node_type_counts.get("Folder", 0),
            "classes": node_type_counts.get("Class", 0),
            "methods": node_type_counts.get("Method", 0),
            "functions": node_type_counts.get("Function", 0),
            "interfaces": node_type_counts.get("Interface", 0),
            "namespaces": node_type_counts.get("Namespace", 0),
            "fields": node_type_counts.get("Field", 0),
            "properties": node_type_counts.get("Property", 0),
            "variables": node_type_counts.get("Variable", 0),
            "constants": node_type_counts.get("Constant", 0),
            "imports": node_type_counts.get("Import", 0),
            "exports": node_type_counts.get("Export", 0),
            "typeAliases": node_type_counts.get("TypeAlias", 0),
            "enums": node_type_counts.get("Enum", 0),
            "enumMembers": node_type_counts.get("EnumMember", 0),
            "configFiles": node_type_counts.get("ConfigFile", 0),
            "dependencies": node_type_counts.get("Dependency", 0),
            "callExpressions": node_type_counts.get("CallExpression", 0),
            "arguments": node_type_counts.get("Argument", 0),
            "receivers": node_type_counts.get("Receiver", 0),
            "returnValues": node_type_counts.get("ReturnValue", 0),
            "routes": node_type_counts.get("Route", 0),
            "endpoints": node_type_counts.get("Endpoint", 0),
            "controllers": node_type_counts.get("Controller", 0),
            "services": node_type_counts.get("Service", 0) + node_type_counts.get("AngularService", 0),
            "repositories": node_type_counts.get("Repository", 0),
            "components": node_type_counts.get("ReactComponent", 0) + node_type_counts.get("AngularComponent", 0),
            "hooks": node_type_counts.get("Hook", 0),
            "ormModels": node_type_counts.get("ORMModel", 0),
            "databaseTables": node_type_counts.get("DatabaseTable", 0),        },
        "nodeTypeCounts": node_type_counts,
        "relationshipTypeCounts": relationship_type_counts,
        "folders": folders,
        "files": files,
        "unfiledSymbols": unfiled_symbols,
        "relationshipSamples": relationship_samples,
        "truncated": {
            "files": node_type_counts.get("File", 0) > len(file_records),
            "symbols": sum(node_type_counts.get(t, 0) for t in INVENTORY_SYMBOL_TYPES) > len(symbol_records),
            "relationshipSamples": total_relationships > len(relationship_samples),
        },
    }


def _node_record(record: Any) -> Dict[str, Any]:
    labels = list(record.get("labels") or [])
    return {
        "id": record.get("id"),
        "name": record.get("name") or "",
        "type": _primary_type(labels),
        "filePath": record.get("filePath") or "",
        "lineNumber": record.get("lineNumber"),
        "sourceRange": _source_range_from_record(record),
        "labels": labels,
        "ragText": record.get("ragText") or "",
    }


def _source_range_from_record(record: Any) -> Dict[str, Any] | None:
    source_range = {
        "startLine": record.get("sourceStartLine"),
        "startColumn": record.get("sourceStartColumn"),
        "endLine": record.get("sourceEndLine"),
        "endColumn": record.get("sourceEndColumn"),
        "startByte": record.get("sourceStartByte"),
        "endByte": record.get("sourceEndByte"),
    }
    return source_range if any(value is not None for value in source_range.values()) else None

def _primary_type(labels: List[str]) -> str:
    for label in (
        "Folder",
        "File",
        "Class",
        "Interface",
        "Method",
        "Function",
        "Namespace",
        "Enum",
        "EnumMember",
        "TypeAlias",
        "Field",
        "Property",
        "Variable",
        "Constant",
        "Import",
        "Export",
        "Parameter",
        "Dependency",
        "ConfigFile",
        "CallExpression",
        "Argument",
        "Receiver",
        "ReturnValue",
        "Route",
        "Endpoint",
        "Controller",
        "Service",
        "Repository",
        "ReactComponent",
        "AngularComponent",
        "AngularService",
        "FrameworkModule",
        "Hook",
        "StateVariable",
        "EventHandler",
        "ORMModel",
        "DatabaseTable",
        "MessageTopic",
        "Template",
        "BasicBlock",
        "IfStatement",
        "Loop",
        "SwitchCase",
        "TryCatch",
        "ReturnStatement",
        "ThrowStatement",
        "BreakStatement",
        "ContinueStatement",
        "Value",
        "Assignment",
        "Expression",
        "SourceExpression",
        "SinkExpression",
        "Symbol",
        "Definition",
        "Declaration",
        "Reference",
        "ExternalSymbol",
    ):
        if label in labels:
            return label
    for label in labels:
        if label != "CodeNode":
            return label
    return "Unknown"


def _group_symbols_by_file(
    file_records: List[Dict[str, Any]],
    symbol_records: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    files_by_path: Dict[str, Dict[str, Any]] = {}
    for file_record in file_records:
        file_entry = dict(file_record)
        file_entry["symbols"] = []
        key = file_entry.get("filePath") or file_entry.get("name") or file_entry.get("id") or ""
        files_by_path[key] = file_entry

    for symbol in symbol_records:
        file_path = symbol.get("filePath") or ""
        if not file_path:
            continue
        if file_path not in files_by_path:
            files_by_path[file_path] = {
                "id": None,
                "name": file_path,
                "type": "File",
                "filePath": file_path,
                "lineNumber": None,
                "labels": ["File"],
                "ragText": "",
                "synthetic": True,
                "symbols": [],
            }
        files_by_path[file_path]["symbols"].append(symbol)

    for file_entry in files_by_path.values():
        file_entry["symbols"].sort(
            key=lambda item: (
                item.get("lineNumber") if item.get("lineNumber") is not None else 10**9,
                item.get("name") or "",
            )
        )
    return sorted(
        files_by_path.values(),
        key=lambda item: (item.get("filePath") or item.get("name") or ""),
    )


def _compact_endpoint(record: Any, prefix: str) -> Dict[str, Any]:
    labels = list(record.get(f"{prefix}Labels") or [])
    return {
        "id": record.get(f"{prefix}Id"),
        "name": record.get(f"{prefix}Name") or "",
        "type": _primary_type(labels),
        "filePath": record.get(f"{prefix}FilePath") or "",
        "lineNumber": record.get(f"{prefix}LineNumber"),
    }


IMPACT_RELATIONSHIPS = (
    "CALLS",
    "CALLS_SERVICE",
    "QUERIES_TABLE",
    "ROUTES_TO",
    "HANDLES",
    "AFFECTS",
    "IMPACT_PATH",
    "USES_MODEL",
    "DEPENDS_ON",
    "USED_BY",
    "FLOWS_TO",
    "REACHING_DEF",
    "RETURN_FLOWS_TO",
    "RETURNS_TO",
    "FIELD_READ",
    "FIELD_WRITE",
)


def fetch_symbol_callers(
    database: str,
    node_id: str,
    *,
    limit: int = 50,
) -> Dict[str, Any]:
    """Return direct incoming callers/handlers for a CodeGraph node."""

    return _fetch_direct_relationships(
        database,
        node_id,
        direction="incoming",
        relationships=("CALLS", "REF_CALL", "CALLS_SERVICE", "ROUTES_TO", "HANDLES"),
        limit=limit,
    )


def fetch_symbol_callees(
    database: str,
    node_id: str,
    *,
    limit: int = 50,
) -> Dict[str, Any]:
    """Return direct outgoing callees/dependencies for a CodeGraph node."""

    return _fetch_direct_relationships(
        database,
        node_id,
        direction="outgoing",
        relationships=("CALLS", "CALLS_SERVICE", "QUERIES_TABLE", "USES_MODEL", "DEPENDS_ON"),
        limit=limit,
    )


def fetch_impact_paths(
    database: str,
    node_id: str,
    *,
    max_depth: int = 4,
    limit: int = 80,
) -> Dict[str, Any]:
    """Return bounded architecture/call impact paths around a node."""

    max_depth = max(1, min(int(max_depth or 4), 6))
    limit = max(1, min(int(limit or 80), 200))
    rel_clause = "|".join(IMPACT_RELATIONSHIPS)
    query = f"""
    MATCH path = (seed:CodeNode {{id: $node_id}})-[:{rel_clause}*1..{max_depth}]-(affected:CodeNode)
    WHERE seed <> affected
    RETURN [n IN nodes(path) | {{
             id: n.id,
             name: coalesce(n.name, ''),
             filePath: coalesce(n.filePath, ''),
             lineNumber: n.lineNumber,
             labels: labels(n),
             type: head([label IN labels(n) WHERE label <> 'CodeNode'])
           }}] AS nodes,
           [r IN relationships(path) | type(r)] AS relationships
    LIMIT $limit
    """
    return _fetch_paths(database, node_id, query, limit=limit, max_depth=max_depth)


def fetch_affected_routes(
    database: str,
    node_id: str,
    *,
    max_depth: int = 5,
    limit: int = 80,
) -> Dict[str, Any]:
    """Return route/endpoint paths that may be affected by a node."""

    max_depth = max(1, min(int(max_depth or 5), 6))
    limit = max(1, min(int(limit or 80), 200))
    rel_clause = "|".join(IMPACT_RELATIONSHIPS)
    query = f"""
    MATCH path = (seed:CodeNode {{id: $node_id}})-[:{rel_clause}*1..{max_depth}]-(route:CodeNode)
    WHERE any(label IN labels(route) WHERE label IN ['Route', 'Endpoint'])
    RETURN [n IN nodes(path) | {{
             id: n.id,
             name: coalesce(n.name, ''),
             filePath: coalesce(n.filePath, ''),
             lineNumber: n.lineNumber,
             labels: labels(n),
             type: head([label IN labels(n) WHERE label <> 'CodeNode'])
           }}] AS nodes,
           [r IN relationships(path) | type(r)] AS relationships
    LIMIT $limit
    """
    return _fetch_paths(database, node_id, query, limit=limit, max_depth=max_depth)


def fetch_affected_tests(
    database: str,
    node_id: str,
    *,
    max_depth: int = 5,
    limit: int = 80,
) -> Dict[str, Any]:
    """Return future Phase 5 test paths when test nodes exist."""

    max_depth = max(1, min(int(max_depth or 5), 6))
    limit = max(1, min(int(limit or 80), 200))
    rel_clause = "|".join((*IMPACT_RELATIONSHIPS, "TESTS", "COVERS", "AFFECTED_BY"))
    query = f"""
    MATCH path = (seed:CodeNode {{id: $node_id}})-[:{rel_clause}*1..{max_depth}]-(test:CodeNode)
    WHERE any(label IN labels(test) WHERE label IN ['TestFile', 'TestCase'])
    RETURN [n IN nodes(path) | {{
             id: n.id,
             name: coalesce(n.name, ''),
             filePath: coalesce(n.filePath, ''),
             lineNumber: n.lineNumber,
             labels: labels(n),
             type: head([label IN labels(n) WHERE label <> 'CodeNode'])
           }}] AS nodes,
           [r IN relationships(path) | type(r)] AS relationships
    LIMIT $limit
    """
    return _fetch_paths(database, node_id, query, limit=limit, max_depth=max_depth)


def _fetch_direct_relationships(
    database: str,
    node_id: str,
    *,
    direction: str,
    relationships: tuple[str, ...],
    limit: int,
) -> Dict[str, Any]:
    limit = max(1, min(int(limit or 50), 200))
    rel_clause = "|".join(relationships)
    arrow = f"<-[r:{rel_clause}]-" if direction == "incoming" else f"-[r:{rel_clause}]->"
    query = f"""
    MATCH (seed:CodeNode {{id: $node_id}}){arrow}(node:CodeNode)
    RETURN type(r) AS relationshipType,
           {{
             id: node.id,
             name: coalesce(node.name, ''),
             filePath: coalesce(node.filePath, ''),
             lineNumber: node.lineNumber,
             labels: labels(node),
             type: head([label IN labels(node) WHERE label <> 'CodeNode'])
           }} AS node
    LIMIT $limit
    """
    driver = get_driver()
    with driver.session(database=database) as session:
        records = [
            {"relationshipType": record["relationshipType"], "node": record["node"]}
            for record in session.run(query, node_id=node_id, limit=limit)
        ]
    return {
        "database": database,
        "nodeId": node_id,
        "direction": direction,
        "relationships": list(relationships),
        "results": records,
        "truncated": len(records) >= limit,
    }


def _fetch_paths(
    database: str,
    node_id: str,
    query: str,
    *,
    limit: int,
    max_depth: int,
) -> Dict[str, Any]:
    driver = get_driver()
    with driver.session(database=database) as session:
        paths = [
            {"nodes": record["nodes"], "relationships": record["relationships"]}
            for record in session.run(query, node_id=node_id, limit=limit)
        ]
    return {
        "database": database,
        "nodeId": node_id,
        "maxDepth": max_depth,
        "paths": paths,
        "truncated": len(paths) >= limit,
    }

def get_hybrid_retriever(database: str | None = None) -> HybridRetriever:
    kwargs: dict[str, Any] = {
        "driver": get_driver(),
        "vector_index_name": DEFAULT_VECTOR_INDEX,
        "fulltext_index_name": DEFAULT_FULLTEXT_INDEX,
        "embedder": get_embedder(),
        "return_properties": DEFAULT_RETURN_PROPERTIES,
    }
    if database:
        kwargs.update(_database_kwargs(HybridRetriever.__init__, database))
    return HybridRetriever(**kwargs)


def search_hybrid_retriever(
    retriever: HybridRetriever,
    *,
    query_text: str,
    top_k: int,
    database: str,
) -> Any:
    safe_query_text = sanitize_fulltext_query_text(query_text)
    kwargs: dict[str, Any] = {"query_text": safe_query_text, "top_k": top_k}
    kwargs.update(_database_kwargs(retriever.search, database))
    try:
        return retriever.search(**kwargs)
    except Exception as exc:
        if not _is_fulltext_parse_error(exc):
            raise
        fallback_query_text = _minimal_fulltext_query_text(safe_query_text)
        if fallback_query_text == safe_query_text:
            raise
        log.warning(
            "hybrid_retriever_fulltext_retry",
            extra={
                "database": database,
                "sanitized_query_length": len(safe_query_text),
                "fallback_query_length": len(fallback_query_text),
            },
        )
        retry_kwargs: dict[str, Any] = {"query_text": fallback_query_text, "top_k": top_k}
        retry_kwargs.update(_database_kwargs(retriever.search, database))
        return retriever.search(**retry_kwargs)


def sanitize_fulltext_query_text(query_text: str, max_terms: int = 80) -> str:
    """Return a Lucene-safe query for Neo4j hybrid/fulltext search."""

    tokens = re.findall(r"[A-Za-z0-9_]+", str(query_text or ""))
    normalized_tokens = [
        token.lower() if token in {"AND", "OR", "NOT"} else token
        for token in tokens
    ]
    return " ".join(normalized_tokens[:max_terms]) or "code"


def _minimal_fulltext_query_text(query_text: str, max_terms: int = 12) -> str:
    tokens = re.findall(r"[A-Za-z0-9_]+", str(query_text or ""))
    return " ".join(tokens[:max_terms]) or "code"


def _is_fulltext_parse_error(exc: Exception) -> bool:
    detail = str(exc)
    return any(marker in detail for marker in _FULLTEXT_PARSE_ERROR_MARKERS)


def _database_kwargs(callback: Any, database: str) -> dict[str, str]:
    """Pass database to neo4j-graphrag across supported package versions."""

    try:
        parameters = inspect.signature(callback).parameters
    except (TypeError, ValueError):
        parameters = {}
    if "neo4j_database" in parameters:
        return {"neo4j_database": database}
    if "database" in parameters:
        return {"database": database}
    return {}

"""Apply incremental CodeGraph deltas to Neo4j."""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Dict, Iterable, List, Tuple

from neo4j import Driver, ManagedTransaction

from ..schemas.patch_schemas import (
    GraphDeltaPayload,
    GraphEdgePayload,
    GraphNodePayload,
    PatchApplyStats,
)
from .embedding_service import get_embedder

logger = logging.getLogger(__name__)

BATCH_SIZE = 1000
UNIVERSAL_LABEL = "CodeNode"

RAG_TEXT_PROP = "ragText"
RAG_EMBEDDING_PROP = "ragEmbedding"
RAG_MODEL_PROP = "ragEmbeddingModel"
RAG_DIM_PROP = "ragEmbeddingDim"
RAG_RESERVED_KEYS = {
    RAG_TEXT_PROP,
    RAG_EMBEDDING_PROP,
    RAG_MODEL_PROP,
    RAG_DIM_PROP,
    "embedding",
    "embeddings",
    "vector",
    "vectors",
}


def apply_delta_batch(
    driver: Driver,
    database: str,
    deltas: List[GraphDeltaPayload],
) -> PatchApplyStats:
    start = time.perf_counter()

    node_ids_to_remove: List[str] = []
    edge_ids_to_remove: List[str] = []
    nodes_to_add: List[GraphNodePayload] = []
    edges_to_add: List[GraphEdgePayload] = []

    for delta in deltas:
        node_ids_to_remove.extend(delta.nodesToRemove)
        edge_ids_to_remove.extend(delta.edgesToRemove)
        nodes_to_add.extend(delta.nodesToAdd)
        edges_to_add.extend(delta.edgesToAdd)

    for edge in edges_to_add:
        if not _is_safe_label(edge.relationshipType):
            raise ValueError(
                f"Rejected edge {edge.id}: relationship type "
                f"'{edge.relationshipType}' is not a safe Cypher label."
            )

    node_rows = _prepare_node_rows(nodes_to_add)
    edge_rows = _prepare_edge_rows(edges_to_add, nodes_to_add)

    stats = PatchApplyStats()
    stats.embeddingsRefreshed = sum(
        1 for row in node_rows if row["props"].get(RAG_EMBEDDING_PROP) is not None
    )

    with driver.session(database=database) as session:
        result = session.execute_write(
            _apply_in_transaction,
            edge_ids_to_remove,
            node_ids_to_remove,
            node_rows,
            edge_rows,
        )

    stats.edgesDeleted = result["edges_deleted"]
    stats.nodesDeleted = result["nodes_deleted"]
    stats.nodesMerged = result["nodes_merged"]
    stats.edgesMerged = result["edges_merged"]
    stats.durationMs = int((time.perf_counter() - start) * 1000)

    logger.info(
        "Patch applied: +%dn/-%dn +%de/-%de emb=%d in %dms",
        stats.nodesMerged,
        stats.nodesDeleted,
        stats.edgesMerged,
        stats.edgesDeleted,
        stats.embeddingsRefreshed,
        stats.durationMs,
    )
    return stats


def _apply_in_transaction(
    tx: ManagedTransaction,
    edge_ids_to_remove: List[str],
    node_ids_to_remove: List[str],
    node_rows: List[Dict[str, Any]],
    edge_rows: List[Dict[str, Any]],
) -> Dict[str, int]:
    result: Dict[str, int] = {
        "edges_deleted": 0,
        "nodes_deleted": 0,
        "nodes_merged": 0,
        "edges_merged": 0,
    }

    if edge_ids_to_remove:
        rec = tx.run(
            """
            UNWIND $ids AS edgeId
            MATCH ()-[r {edgeId: edgeId}]->()
            DELETE r
            RETURN count(r) AS removed
            """,
            ids=edge_ids_to_remove,
        ).single()
        result["edges_deleted"] = rec["removed"] if rec else 0

    if node_ids_to_remove:
        rec = tx.run(
            """
            UNWIND $ids AS nodeId
            MATCH (n:CodeNode {id: nodeId})
            DETACH DELETE n
            RETURN count(n) AS removed
            """,
            ids=node_ids_to_remove,
        ).single()
        result["nodes_deleted"] = rec["removed"] if rec else 0

    for node_type, rows in _group_by_type(node_rows):
        if not _is_safe_label(node_type):
            logger.warning("Skipping node type with unsafe label: %r", node_type)
            continue

        cypher = f"""
            UNWIND $rows AS row
            MERGE (n:{UNIVERSAL_LABEL}:`{node_type}` {{id: row.id}})
            SET n += row.props,
                n.updatedAt = timestamp()
            RETURN count(n) AS merged
        """
        for batch in _chunked(rows, BATCH_SIZE):
            rec = tx.run(cypher, rows=batch).single()
            result["nodes_merged"] += rec["merged"] if rec else 0

    for rel_type, rows in _group_edges_by_type(edge_rows):
        if not _is_safe_label(rel_type):
            logger.warning("Skipping relationship type with unsafe label: %r", rel_type)
            continue

        cypher = f"""
            UNWIND $rows AS row
            MATCH (src:CodeNode {{id: row.source}})
            MATCH (tgt:CodeNode {{id: row.target}})
            MERGE (src)-[r:`{rel_type}` {{edgeId: row.edgeId}}]->(tgt)
            SET r += row.props,
                r.updatedAt = timestamp()
            RETURN count(r) AS merged
        """
        for batch in _chunked(rows, BATCH_SIZE):
            rec = tx.run(cypher, rows=batch).single()
            result["edges_merged"] += rec["merged"] if rec else 0

    return result


def _prepare_node_rows(nodes: List[GraphNodePayload]) -> List[Dict[str, Any]]:
    if not nodes:
        return []

    embedder = get_embedder()
    texts = [_build_node_rag_text(node) for node in nodes]
    embeddings = _embed_texts(texts)

    rows: List[Dict[str, Any]] = []
    for node, text, embedding in zip(nodes, texts, embeddings):
        props: Dict[str, Any] = {
            "id": node.id,
            "name": node.label,
            "type": _sanitize_label(node.type),
            "filePath": node.filePath,
            "lineNumber": node.lineNumber,
            **_source_range_props(node.sourceRange),
            RAG_TEXT_PROP: text,
            RAG_EMBEDDING_PROP: embedding,
            RAG_MODEL_PROP: embedder.get_model_name(),
            RAG_DIM_PROP: len(embedding),
        }
        props.update(_clean_props(node.properties))
        rows.append({"id": node.id, "type": props["type"], "props": _drop_none(props)})
    return rows


def _prepare_edge_rows(
    edges: List[GraphEdgePayload],
    nodes_to_add: List[GraphNodePayload],
) -> List[Dict[str, Any]]:
    if not edges:
        return []

    node_index = {node.id: node for node in nodes_to_add}
    embedder = get_embedder()
    texts = [_build_edge_rag_text(edge, node_index) for edge in edges]
    embeddings = _embed_texts(texts)

    rows: List[Dict[str, Any]] = []
    for edge, text, embedding in zip(edges, texts, embeddings):
        props: Dict[str, Any] = {
            "edgeId": edge.id,
            RAG_TEXT_PROP: text,
            RAG_EMBEDDING_PROP: embedding,
            RAG_MODEL_PROP: embedder.get_model_name(),
            RAG_DIM_PROP: len(embedding),
        }
        props.update(_source_range_props(edge.sourceRange))
        props.update(_clean_props(edge.properties))
        rows.append(
            {
                "edgeId": edge.id,
                "source": edge.source,
                "target": edge.target,
                "relationshipType": _sanitize_relationship_type(edge.relationshipType),
                "props": _drop_none(props),
            }
        )
    return rows


def _embed_texts(texts: List[str]) -> List[List[float]]:
    if not texts:
        return []
    try:
        return get_embedder().embed_documents(texts)
    except Exception:
        logger.exception("Embedding batch failed; graph patch will store empty vectors.")
        return [[] for _ in texts]


def _build_node_rag_text(node: GraphNodePayload) -> str:
    parts = [f"type: {_sanitize_label(node.type)}"]
    if node.label:
        parts.append(f"name: {node.label}")
    if node.filePath:
        parts.append(f"file: {node.filePath}")
    prop_text = "; ".join(
        f"{key}: {value}" for key, value in sorted(_clean_props(node.properties).items())
    )
    if prop_text:
        parts.append(f"properties: {prop_text}")
    return " | ".join(parts)


def _build_edge_rag_text(
    edge: GraphEdgePayload,
    node_index: Dict[str, GraphNodePayload],
) -> str:
    source_node = node_index.get(edge.source)
    target_node = node_index.get(edge.target)
    parts = [f"relationship: {edge.relationshipType}"]
    if source_node and source_node.label:
        parts.append(f"sourceName: {source_node.label}")
    if target_node and target_node.label:
        parts.append(f"targetName: {target_node.label}")
    return " | ".join(parts)


def _clean_props(props: Any) -> Dict[str, Any]:
    if not props or not isinstance(props, dict):
        return {}

    clean: Dict[str, Any] = {}
    for key, value in props.items():
        if key in RAG_RESERVED_KEYS or value is None:
            continue
        if isinstance(value, (str, int, float, bool)):
            clean[key] = value
        elif isinstance(value, list) and all(isinstance(x, (str, int, float, bool)) for x in value):
            clean[key] = value
        else:
            clean[key] = json.dumps(value, default=str)
    return clean


def _drop_none(props: Dict[str, Any]) -> Dict[str, Any]:
    return {key: value for key, value in props.items() if value is not None}


def _sanitize_label(value: str | None) -> str:
    return value if value and _is_safe_label(value) else "Unknown"


def _sanitize_relationship_type(value: str | None) -> str:
    if value and _is_safe_label(value):
        return value
    raise ValueError(f"Relationship type is not a safe Cypher label: {value!r}")


def _source_range_props(source_range: Any) -> Dict[str, Any]:
    if not source_range:
        return {}
    return _drop_none(
        {
            "sourceStartLine": getattr(source_range, "startLine", None),
            "sourceStartColumn": getattr(source_range, "startColumn", None),
            "sourceEndLine": getattr(source_range, "endLine", None),
            "sourceEndColumn": getattr(source_range, "endColumn", None),
            "sourceStartByte": getattr(source_range, "startByte", None),
            "sourceEndByte": getattr(source_range, "endByte", None),
        }
    )


def _group_by_type(rows: List[Dict[str, Any]]) -> Iterable[Tuple[str, List[Dict[str, Any]]]]:
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(row["type"], []).append(row)
    return grouped.items()


def _group_edges_by_type(rows: List[Dict[str, Any]]) -> Iterable[Tuple[str, List[Dict[str, Any]]]]:
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(row["relationshipType"], []).append(row)
    return grouped.items()


def _chunked(seq: List[Dict[str, Any]], size: int) -> Iterable[List[Dict[str, Any]]]:
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def _is_safe_label(label: str) -> bool:
    if not label:
        return False
    if not (label[0].isalpha() or label[0] == "_"):
        return False
    return all(ch.isalnum() or ch == "_" for ch in label)
import json
import logging
import os
import re
import hashlib
from typing import Any, Dict, Iterator, Tuple
from collections import defaultdict
from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from fastapi.responses import StreamingResponse

from graphrag_agent.services.neo4j_service import get_driver, wipe_database, create_constraints, ensure_indexes
from graphrag_agent.services.embedding_service import get_embedder

log = logging.getLogger("seed_router")
router = APIRouter()

BATCH_SIZE = 1000
EMBED_BATCH_SIZE = 128
SAFE_LABEL_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

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


def sanitize_label(value: str) -> str:
    if not value or not SAFE_LABEL_RE.match(str(value)):
        return "Unknown"
    return str(value)


def clean_props(props: Any) -> Dict[str, Any]:
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


def source_range_props(source_range: Any) -> Dict[str, Any]:
    if not isinstance(source_range, dict):
        return {}
    return {
        key: value
        for key, value in {
            "sourceStartLine": source_range.get("startLine"),
            "sourceStartColumn": source_range.get("startColumn"),
            "sourceEndLine": source_range.get("endLine"),
            "sourceEndColumn": source_range.get("endColumn"),
            "sourceStartByte": source_range.get("startByte"),
            "sourceEndByte": source_range.get("endByte"),
        }.items()
        if value is not None
    }


def build_node_rag_text(node: Dict[str, Any]) -> str:
    parts = [f"type: {sanitize_label(node.get('type', 'Unknown'))}"]
    if node.get("label"):
        parts.append(f"name: {node['label']}")
    if node.get("filePath"):
        parts.append(f"file: {node['filePath']}")
    source_range = source_range_props(node.get("sourceRange"))
    if source_range:
        parts.append(
            "sourceRange: "
            f"{source_range.get('sourceStartLine')}:{source_range.get('sourceStartColumn')}-"
            f"{source_range.get('sourceEndLine')}:{source_range.get('sourceEndColumn')}"
        )
    prop_text = "; ".join(
        f"{k}: {v}" for k, v in sorted(clean_props(node.get("properties", {})).items())
    )
    if prop_text:
        parts.append(f"properties: {prop_text}")
    return " | ".join(parts)


def build_edge_rag_text(edge: Dict[str, Any], node_index: Dict[str, Any]) -> str:
    rel = sanitize_label(edge.get("relationshipType", "RELATED_TO")).upper()
    source_node = node_index.get(edge["source"], {})
    target_node = node_index.get(edge["target"], {})
    parts = [f"relationship: {rel}"]
    if source_node.get("label"):
        parts.append(f"sourceName: {source_node['label']}")
    if target_node.get("label"):
        parts.append(f"targetName: {target_node['label']}")
    return " | ".join(parts)


def chunked(seq, size):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


@router.post("/api/seed")
async def seed_graph(
    file: UploadFile = File(...),
    database: str = Form(""),
    wipe: bool = Form(False),
):
    data = await read_graph_upload(file)
    database_name = resolve_seed_database(database)
    result: Dict[str, Any] | None = None
    for event, payload in seed_graph_events(data, database_name, wipe):
        if event == "done":
            result = payload
    if result is None:
        raise RuntimeError("Neo4j upload ended without a completion result")
    return result


@router.post("/api/seed/stream")
async def seed_graph_stream(
    file: UploadFile = File(...),
    database: str = Form(""),
    wipe: bool = Form(False),
):
    data = await read_graph_upload(file)
    database_name = resolve_seed_database(database)

    def stream() -> Iterator[str]:
        try:
            for event, payload in seed_graph_events(data, database_name, wipe):
                yield format_sse(event, payload)
        except Exception as error:
            log.exception("Neo4j Project Graph upload failed")
            yield format_sse("error", {"message": str(error)})

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


async def read_graph_upload(file: UploadFile) -> Dict[str, Any]:
    content = await file.read()
    try:
        data = json.loads(content.decode("utf-8"))
    except Exception as error:
        raise HTTPException(status_code=400, detail=f"Invalid JSON file: {error}")

    if "nodes" not in data or "edges" not in data:
        raise HTTPException(status_code=400, detail="JSON must contain 'nodes' and 'edges'")
    if not isinstance(data["nodes"], list) or not isinstance(data["edges"], list):
        raise HTTPException(status_code=400, detail="'nodes' and 'edges' must be arrays")
    return data


def format_sse(event: str, payload: Dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, default=str)}\n\n"


def seed_graph_events(
    data: Dict[str, Any],
    database_name: str,
    wipe: bool,
) -> Iterator[Tuple[str, Dict[str, Any]]]:
    nodes = data["nodes"]
    edges = data["edges"]
    node_index = {n["id"]: n for n in nodes if isinstance(n, dict) and "id" in n}

    node_type_counts: Dict[str, int] = defaultdict(int)
    for node in nodes:
        node_type_counts[sanitize_label(node.get("type", "Unknown"))] += 1
    edge_type_counts: Dict[str, int] = defaultdict(int)
    for edge in edges:
        edge_type_counts[sanitize_label(edge.get("relationshipType", "RELATED_TO")).upper()] += 1

    node_embed_batches = (len(nodes) + EMBED_BATCH_SIZE - 1) // EMBED_BATCH_SIZE
    edge_embed_batches = (len(edges) + EMBED_BATCH_SIZE - 1) // EMBED_BATCH_SIZE
    node_write_batches = sum((count + BATCH_SIZE - 1) // BATCH_SIZE for count in node_type_counts.values())
    edge_write_batches = sum((count + BATCH_SIZE - 1) // BATCH_SIZE for count in edge_type_counts.values())
    fixed_steps = 4 + (1 if wipe else 0)  # embedder, driver, constraints, indexes, optional wipe
    total_steps = max(
        1,
        fixed_steps
        + node_embed_batches
        + edge_embed_batches
        + node_write_batches
        + edge_write_batches,
    )
    completed_steps = 0

    def progress(message: str) -> Tuple[str, Dict[str, Any]]:
        percent = min(98, max(1, round((completed_steps / total_steps) * 98)))
        return "progress", {"message": message, "percent": percent}

    log.info(f"Processing {len(nodes)} nodes and {len(edges)} edges")
    yield progress(
        f"Preparing {len(nodes)} nodes and {len(edges)} relationships..."
    )
    yield progress("Preparing code embeddings...")
    embedder = get_embedder()
    completed_steps += 1
    yield progress(
        f"Ready to embed {len(nodes)} nodes and {len(edges)} relationships."
    )

    # 1. Embed Nodes
    node_texts = [build_node_rag_text(n) for n in nodes]
    node_embeddings = []
    embedded_nodes = 0
    for batch in chunked(node_texts, EMBED_BATCH_SIZE):
        node_embeddings.extend(embedder.embed_documents(batch))
        embedded_nodes += len(batch)
        completed_steps += 1
        yield progress(f"Embedded {embedded_nodes} of {len(nodes)} nodes.")

    by_type = defaultdict(list)
    for node, text, emb in zip(nodes, node_texts, node_embeddings):
        node_type = sanitize_label(node.get("type", "Unknown"))
        row = {
            "id": node["id"],
            "name": node.get("label"),
            "type": node_type,
            "filePath": node.get("filePath"),
            "lineNumber": node.get("lineNumber"),
            **source_range_props(node.get("sourceRange")),
            RAG_TEXT_PROP: text,
            RAG_EMBEDDING_PROP: emb,
            RAG_MODEL_PROP: embedder.get_model_name(),
            RAG_DIM_PROP: len(emb),
        }
        row.update(clean_props(node.get("properties")))
        by_type[node_type].append(row)

    # 2. Embed Edges
    edge_texts = [build_edge_rag_text(e, node_index) for e in edges]
    edge_embeddings = []
    embedded_edges = 0
    for batch in chunked(edge_texts, EMBED_BATCH_SIZE):
        edge_embeddings.extend(embedder.embed_documents(batch))
        embedded_edges += len(batch)
        completed_steps += 1
        yield progress(
            f"Embedded {embedded_edges} of {len(edges)} relationships."
        )

    by_rel = defaultdict(list)
    for i, (edge, text, emb) in enumerate(zip(edges, edge_texts, edge_embeddings)):
        rel = sanitize_label(edge.get("relationshipType", "RELATED_TO")).upper()
        edge_id = (
            str(edge.get("id"))
            if edge.get("id")
            else hashlib.sha1(f"{i}{edge['source']}{edge['target']}".encode()).hexdigest()
        )
        props = {
            "edgeId": edge_id,
            "relationshipType": rel,
            RAG_TEXT_PROP: text,
            RAG_EMBEDDING_PROP: emb,
            RAG_MODEL_PROP: embedder.get_model_name(),
            RAG_DIM_PROP: len(emb),
        }
        props.update(source_range_props(edge.get("sourceRange")))
        props.update(clean_props(edge.get("properties")))
        by_rel[rel].append({"edgeId": edge_id, "source": edge["source"], "target": edge["target"], "props": props})

    # 3. Push to Neo4j
    yield progress("Connecting to Neo4j...")
    driver = get_driver()
    completed_steps += 1
    yield progress("Connected to Neo4j.")
    if wipe:
        yield progress("Clearing the previous Neo4j Project Graph...")
        wipe_database(database_name)
        completed_steps += 1
        yield progress("Previous Neo4j Project Graph cleared.")
    yield progress("Preparing Neo4j for the Project Graph...")
    create_constraints(database_name)
    completed_steps += 1
    yield progress("Neo4j is ready for the Project Graph.")

    n_count, e_count = 0, 0
    with driver.session(database=database_name) as session:
        for label, items in by_type.items():
            cypher = f"UNWIND $batch AS row MERGE (n:CodeNode:`{label}` {{id: row.id}}) SET n += row"
            for batch in chunked(items, BATCH_SIZE):
                query_result = session.run(cypher, batch=batch)
                consume = getattr(query_result, "consume", None)
                if callable(consume):
                    consume()
                n_count += len(batch)
                completed_steps += 1
                yield progress(f"Uploaded {n_count} of {len(nodes)} nodes to Neo4j.")

        for rel, items in by_rel.items():
            cypher = f"UNWIND $batch AS row MATCH (s:CodeNode {{id: row.source}}) MATCH (t:CodeNode {{id: row.target}}) MERGE (s)-[r:`{rel}` {{edgeId: row.edgeId}}]->(t) SET r += row.props"
            for batch in chunked(items, BATCH_SIZE):
                query_result = session.run(cypher, batch=batch)
                consume = getattr(query_result, "consume", None)
                if callable(consume):
                    consume()
                e_count += len(batch)
                completed_steps += 1
                yield progress(
                    f"Uploaded {e_count} of {len(edges)} relationships to Neo4j."
                )

    yield progress("Finishing Neo4j search setup...")
    ensure_indexes(database_name, "codegraph_codenode_ragEmbedding", "codegraph_codenode_ragText", embedder.dimension)
    completed_steps += 1
    yield progress("Neo4j search setup is ready.")

    yield "done", {
        "message": "Success",
        "nodes_upserted": n_count,
        "edges_upserted": e_count,
        "database": database_name,
    }


def resolve_seed_database(database: str | None = None) -> str:
    return (
        (database or "").strip()
        or os.environ.get("CODEGRAPH_DATABASE", "").strip()
        or os.environ.get("NEO4J_DATABASE", "").strip()
        or "neo4j"
    )

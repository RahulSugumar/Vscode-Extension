import ast
import json
import os
from typing import Any

from fastapi import APIRouter, HTTPException

from graphrag_agent.schemas.responses import RetrievalResponse
from graphrag_agent.services.rag_service import (
    fetch_affected_routes,
    fetch_affected_tests,
    fetch_graph_context,
    fetch_total_code_node_count,
    fetch_impact_paths,
    fetch_project_inventory,
    fetch_symbol_callees,
    fetch_symbol_callers,
    get_hybrid_retriever,
    search_hybrid_retriever,
)
from graphrag_agent.services.graph_report_service import (
    fetch_architecture_report,
    fetch_compare_report,
    fetch_focused_symbol_report,
    fetch_workflow_report,
    split_compare_targets,
)
from graphrag_agent.services.retrieval_profiles import (
    NOISY_SEED_NODE_TYPES,
    build_profile_request,
)
router = APIRouter()


def parse_result_content(content):
    if isinstance(content, dict):
        return content
    if isinstance(content, str):
        try:
            parsed = ast.literal_eval(content)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass
        try:
            parsed = json.loads(content)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass
    return {}


def source_range_from_props(props: dict[str, Any]) -> dict[str, Any] | None:
    source_range = {
        "startLine": props.get("sourceStartLine"),
        "startColumn": props.get("sourceStartColumn"),
        "endLine": props.get("sourceEndLine"),
        "endColumn": props.get("sourceEndColumn"),
        "startByte": props.get("sourceStartByte"),
        "endByte": props.get("sourceEndByte"),
    }
    return source_range if any(value is not None for value in source_range.values()) else None


@router.get("/api/retrieve", response_model=RetrievalResponse)
async def retrieve_context(
    query: str,
    top_k: int | None = None,
    max_neighbors: int | None = None,
    database: str | None = None,
    profile: str = "focused",
    candidate_k: int | None = None,
    final_k: int | None = None,
    node_types: str | None = None,
    relationship_types: str | None = None,
):
    database_name = resolve_retrieval_database(database)
    total_nodes = fetch_total_code_node_count(database_name)
    retrieval_plan = build_profile_request(
        profile,
        total_nodes=total_nodes,
        requested_candidate_k=candidate_k,
        requested_final_k=final_k,
        requested_top_k=top_k,
        requested_max_neighbors=max_neighbors,
        node_types=node_types,
        relationship_types=relationship_types,
    )

    retriever = get_hybrid_retriever(database_name)
    try:
        raw_results = search_hybrid_retriever(
            retriever,
            query_text=query,
            top_k=retrieval_plan["candidate_k"],
            database=database_name,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    items = _retriever_items(raw_results)

    candidates = []
    for rank, item in enumerate(items, 1):
        content = _retriever_item_content(item)
        if content is None:
            continue
        props = parse_result_content(content)
        node_id = props.get("id")
        if not node_id:
            continue
        candidates.append(
            {
                "rawRank": rank,
                "score": _candidate_score(query, props, rank),
                "props": props,
                "type": _candidate_type(props),
            }
        )

    allowed_types = set(retrieval_plan["node_types"])
    filtered_candidates = [
        candidate
        for candidate in candidates
        if not allowed_types or candidate["type"] in allowed_types
    ]
    filter_fallback = bool(candidates and allowed_types and not filtered_candidates)
    seed_candidates = filtered_candidates or candidates
    seed_candidates = sorted(
        seed_candidates,
        key=lambda candidate: (-candidate["score"], candidate["rawRank"]),
    )[: retrieval_plan["final_k"]]

    seed_ids = []
    results_list = []
    for rank, candidate in enumerate(seed_candidates, 1):
        props = candidate["props"]
        node_id = props.get("id")
        seed_ids.append(node_id)
        results_list.append(
            {
                "rank": rank,
                "seedNode": {
                    "id": node_id,
                    "name": props.get("name"),
                    "type": candidate["type"],
                    "filePath": props.get("filePath"),
                    "lineNumber": props.get("lineNumber"),
                    "sourceRange": source_range_from_props(props),
                    "ragText": props.get("ragText"),
                },
                "score": candidate["score"],
                "rawRank": candidate["rawRank"],
            }
        )

    graph_context = fetch_graph_context(
        database_name,
        seed_ids,
        retrieval_plan["max_neighbors"],
        relationship_types=retrieval_plan["expanded_relationship_types"],
    )

    for res in results_list:
        node_id = res["seedNode"]["id"]
        res["graphContext"] = graph_context.get(node_id, {})

    return {
        "query": query,
        "top_k": retrieval_plan["final_k"],
        "database": database_name,
        "results": results_list,
        "metadata": {
            "profile": retrieval_plan["profile"],
            "total_nodes": total_nodes,
            "candidate_k": retrieval_plan["candidate_k"],
            "final_k": retrieval_plan["final_k"],
            "max_neighbors": retrieval_plan["max_neighbors"],
            "node_types": retrieval_plan["node_types"],
            "relationship_types": retrieval_plan["expanded_relationship_types"],
            "requested_relationship_types": retrieval_plan["relationship_types"],
            "raw_candidate_count": len(candidates),
            "filtered_candidate_count": len(filtered_candidates),
            "filter_fallback": filter_fallback,
        },
    }


def _retriever_items(raw_results: Any) -> list[Any]:
    """Normalize neo4j-graphrag result shapes without treating dict.items as results."""

    if raw_results is None:
        return []
    if isinstance(raw_results, dict):
        for key in ("items", "results", "records"):
            value = raw_results.get(key)
            if isinstance(value, list):
                return value
            if value is not None and not callable(value):
                try:
                    return list(value)
                except TypeError:
                    return []
        return []
    value = getattr(raw_results, "items", None)
    if isinstance(value, list):
        return value
    if value is not None and not callable(value):
        try:
            return list(value)
        except TypeError:
            return []
    if isinstance(raw_results, list):
        return raw_results
    try:
        return list(raw_results)
    except TypeError:
        return []

def _retriever_item_content(item: Any) -> Any:
    if hasattr(item, "content"):
        return getattr(item, "content")
    if isinstance(item, dict):
        for key in ("content", "text", "properties", "node"):
            if key in item:
                return item[key]
    return None

def _candidate_type(props: dict[str, Any]) -> str:
    node_type = str(props.get("type") or "").strip()
    if node_type:
        return node_type
    rag_text = str(props.get("ragText") or "")
    if rag_text.startswith("type: "):
        return rag_text.split("|", 1)[0].replace("type:", "").strip()
    return "CodeNode"


def _candidate_score(query: str, props: dict[str, Any], rank: int) -> float:
    lowered_query = query.lower()
    terms = {term for term in lowered_query.replace("/", " ").replace(".", " ").split() if term}
    name = str(props.get("name") or "")
    file_path = str(props.get("filePath") or "")
    node_type = _candidate_type(props)
    lowered_name = name.lower()
    score = max(0.0, 1000.0 - float(rank))
    if lowered_name and lowered_name in lowered_query:
        score += 120.0
    if lowered_name and lowered_name in terms:
        score += 80.0
    if file_path and file_path.replace("\\", "/").lower() in lowered_query:
        score += 90.0
    basename = os.path.basename(file_path).lower()
    if basename and basename in lowered_query:
        score += 60.0
    if node_type in {"Function", "Method", "Class", "Interface", "File", "Endpoint", "Route"}:
        score += 20.0
    if node_type in NOISY_SEED_NODE_TYPES:
        score -= 80.0
    return score


@router.get("/api/report/architecture")
async def architecture_report_context(
    query: str = "",
    database: str | None = None,
    max_files: int = 400,
    max_symbols: int = 3000,
    max_relationship_samples: int = 300,
):
    database_name = resolve_retrieval_database(database)
    try:
        report = fetch_architecture_report(
            database_name,
            max_files=max_files,
            max_symbols=max_symbols,
            max_relationship_samples=max_relationship_samples,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    report["query"] = query
    return report


@router.get("/api/report/workflow")
async def workflow_report_context(
    query: str,
    database: str | None = None,
    seed_k: int | None = None,
    max_depth: int = 4,
    limit: int = 160,
):
    database_name = resolve_retrieval_database(database)
    retrieval_payload = await retrieve_context(
        query=query,
        database=database_name,
        profile="workflow",
        final_k=seed_k,
    )
    seed_ids = _seed_ids_from_retrieval_payload(retrieval_payload)
    try:
        report = fetch_workflow_report(
            database_name,
            query,
            seed_ids,
            max_depth=max_depth,
            limit=limit,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    report["retrieval"] = _retrieval_summary(retrieval_payload)
    return report


@router.get("/api/report/focused")
async def focused_report_context(
    query: str,
    database: str | None = None,
    seed_k: int | None = None,
    limit: int = 120,
):
    database_name = resolve_retrieval_database(database)
    retrieval_payload = await retrieve_context(
        query=query,
        database=database_name,
        profile="focused",
        final_k=seed_k,
    )
    seed_ids = _seed_ids_from_retrieval_payload(retrieval_payload)
    try:
        report = fetch_focused_symbol_report(
            database_name,
            query,
            seed_ids,
            limit=limit,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    report["retrieval"] = _retrieval_summary(retrieval_payload)
    return report


@router.get("/api/report/compare")
async def compare_report_context(
    query: str,
    database: str | None = None,
    left: str | None = None,
    right: str | None = None,
    seed_k: int | None = None,
    max_depth: int = 3,
    limit: int = 120,
):
    database_name = resolve_retrieval_database(database)
    inferred_left, inferred_right = split_compare_targets(query)
    left_query = (left or inferred_left or query).strip()
    right_query = (right or inferred_right or query).strip()
    left_payload = await retrieve_context(
        query=left_query,
        database=database_name,
        profile="compare",
        final_k=seed_k,
    )
    right_payload = await retrieve_context(
        query=right_query,
        database=database_name,
        profile="compare",
        final_k=seed_k,
    )
    try:
        report = fetch_compare_report(
            database_name,
            query,
            left_query,
            right_query,
            _seed_ids_from_retrieval_payload(left_payload),
            _seed_ids_from_retrieval_payload(right_payload),
            max_depth=max_depth,
            limit=limit,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    report["retrieval"] = {
        "left": _retrieval_summary(left_payload),
        "right": _retrieval_summary(right_payload),
    }
    return report


def _seed_ids_from_retrieval_payload(payload: dict[str, Any]) -> list[str]:
    results = payload.get("results") if isinstance(payload, dict) else []
    seed_ids: list[str] = []
    if not isinstance(results, list):
        return seed_ids
    for result in results:
        if not isinstance(result, dict):
            continue
        seed_node = result.get("seedNode")
        if not isinstance(seed_node, dict):
            continue
        node_id = seed_node.get("id")
        if node_id:
            seed_ids.append(str(node_id))
    return seed_ids


def _retrieval_summary(payload: dict[str, Any]) -> dict[str, Any]:
    results = payload.get("results") if isinstance(payload, dict) else []
    metadata = payload.get("metadata") if isinstance(payload, dict) else {}
    return {
        "query": payload.get("query") if isinstance(payload, dict) else None,
        "database": payload.get("database") if isinstance(payload, dict) else None,
        "resultCount": len(results) if isinstance(results, list) else 0,
        "metadata": metadata if isinstance(metadata, dict) else {},
        "seedIds": _seed_ids_from_retrieval_payload(payload),
    }

@router.get("/api/project-inventory")
async def project_inventory_context(
    database: str | None = None,
    max_files: int = 200,
    max_symbols: int = 1000,
    max_relationship_samples: int = 80,
):
    database_name = resolve_retrieval_database(database)
    try:
        return fetch_project_inventory(
            database_name,
            max_files=max_files,
            max_symbols=max_symbols,
            max_relationship_samples=max_relationship_samples,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/symbol/{node_id}/callers")
async def symbol_callers(
    node_id: str,
    database: str | None = None,
    limit: int = 50,
):
    database_name = resolve_retrieval_database(database)
    try:
        return fetch_symbol_callers(database_name, node_id, limit=limit)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/symbol/{node_id}/callees")
async def symbol_callees(
    node_id: str,
    database: str | None = None,
    limit: int = 50,
):
    database_name = resolve_retrieval_database(database)
    try:
        return fetch_symbol_callees(database_name, node_id, limit=limit)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/impact")
async def impact_context(
    node_id: str,
    database: str | None = None,
    max_depth: int = 4,
    limit: int = 80,
):
    database_name = resolve_retrieval_database(database)
    try:
        return fetch_impact_paths(
            database_name,
            node_id,
            max_depth=max_depth,
            limit=limit,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/affected-tests")
async def affected_tests_context(
    node_id: str,
    database: str | None = None,
    max_depth: int = 5,
    limit: int = 80,
):
    database_name = resolve_retrieval_database(database)
    try:
        return fetch_affected_tests(
            database_name,
            node_id,
            max_depth=max_depth,
            limit=limit,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/affected-routes")
async def affected_routes_context(
    node_id: str,
    database: str | None = None,
    max_depth: int = 5,
    limit: int = 80,
):
    database_name = resolve_retrieval_database(database)
    try:
        return fetch_affected_routes(
            database_name,
            node_id,
            max_depth=max_depth,
            limit=limit,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def resolve_retrieval_database(database: str | None = None) -> str:
    return (
        (database or "").strip()
        or os.environ.get("CODEGRAPH_DATABASE", "").strip()
        or os.environ.get("NEO4J_DATABASE", "").strip()
        or "neo4j"
    )
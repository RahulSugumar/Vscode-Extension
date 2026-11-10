
"""Incremental CodeGraph patch endpoint."""

from __future__ import annotations

import logging
import os

from fastapi import APIRouter, HTTPException, status

from ..schemas.patch_schemas import DeltaBatchPayload, PatchApplyStats, PatchResponse
from ..services.codegraph_patch import apply_delta_batch
from ..services.neo4j_service import get_driver

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/graphrag/api", tags=["graphrag-patch"])


@router.post(
    "/patch",
    response_model=PatchResponse,
    summary="Apply an incremental graph delta batch to Neo4j",
)
def patch_graph(payload: DeltaBatchPayload) -> PatchResponse:
    if not payload.deltas:
        return PatchResponse(
            status="ok",
            message="Empty batch; nothing to apply.",
            stats=PatchApplyStats(),
        )

    try:
        driver = get_driver()
    except Exception as exc:
        logger.exception("Neo4j driver unavailable")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Neo4j is not available: {exc}",
        ) from exc

    database = payload.database or os.environ.get("NEO4J_DATABASE") or os.environ.get("CODEGRAPH_DATABASE") or "neo4j"

    try:
        stats = apply_delta_batch(driver, database, payload.deltas)
    except ValueError as exc:
        logger.warning("Rejected patch payload: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        logger.exception("Patch application failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Neo4j patch failed: {exc}",
        ) from exc

    return PatchResponse(
        status="ok",
        message=(
            f"Applied {len(payload.deltas)} delta(s): "
            f"+{stats.nodesMerged} nodes, -{stats.nodesDeleted} nodes, "
            f"+{stats.edgesMerged} edges, -{stats.edgesDeleted} edges."
        ),
        stats=stats,
    )

from typing import List, Optional, Dict, Any, Literal
from pydantic import BaseModel, Field


class SourceRangePayload(BaseModel):
    startLine: int
    startColumn: int
    endLine: int
    endColumn: int
    startByte: Optional[int] = None
    endByte: Optional[int] = None


class GraphNodePayload(BaseModel):
    id: str
    label: str
    type: str = Field(
        description="Extensible graph node label. Known labels include File, "
                    "Folder, Class, Method, Function, Interface, Symbol, Definition, Declaration, Reference, "
                    "ExternalSymbol, Parameter, Field, Property, Variable, Local, Constant, Import, Export, "
                    "TypeAlias, Enum, EnumMember, Decorator, Annotation, Comment, DocBlock, Namespace, Module, "
                    "Package, ConfigFile, Dependency, CallExpression, Argument, Receiver, and ReturnValue."
    )
    filePath: Optional[str] = None
    lineNumber: Optional[int] = None
    sourceRange: Optional[SourceRangePayload] = None
    properties: Optional[Dict[str, Any]] = None


class GraphEdgePayload(BaseModel):
    id: str
    source: str
    target: str
    relationshipType: str = Field(
        description="Extensible Cypher relationship type. Known types include "
                    "CONTAINS, CALLS, IMPORTS_FROM, EXTENDS, IMPLEMENTS, INSTANTIATES, HAS_OCCURRENCE, "
                    "DEFINES, DECLARES, REFERS_TO, RESOLVES_TO, REF_CALL, HAS_PARAM, HAS_FIELD, "
                    "HAS_PROPERTY, HAS_TYPE_PARAM, TYPE_OF, RETURNS, IMPORTS, EXPORTS, REEXPORTS, "
                    "ALIASES, DOCUMENTS, ANNOTATED_BY, CALL_SITE_OF, HAS_ARGUMENT, ARGUMENT_FLOWS_TO_PARAMETER, RECEIVER_OF, RETURN_FLOWS_TO_CALLER, OVERRIDES, and CALLS_OVERRIDE."
    )
    sourceRange: Optional[SourceRangePayload] = None
    properties: Optional[Dict[str, Any]] = None


FileChangeOp = Literal["added", "modified", "deleted", "renamed"]


class GraphDeltaPayload(BaseModel):
    filePath: str
    op: FileChangeOp
    previousFilePath: Optional[str] = None
    oldHash: Optional[str] = None
    newHash: Optional[str] = None
    nodesToAdd: List[GraphNodePayload] = Field(default_factory=list)
    nodesToRemove: List[str] = Field(default_factory=list)
    edgesToAdd: List[GraphEdgePayload] = Field(default_factory=list)
    edgesToRemove: List[str] = Field(default_factory=list)


class DeltaBatchTotals(BaseModel):
    filesProcessed: int
    nodesAdded: int
    nodesRemoved: int
    edgesAdded: int
    edgesRemoved: int


class DeltaBatchPayload(BaseModel):
    schemaVersion: Optional[int] = None
    batchId: Optional[str] = None
    createdAt: Optional[int] = None
    workspaceRoot: Optional[str] = None
    database: Optional[str] = None
    deltas: List[GraphDeltaPayload]
    totals: DeltaBatchTotals


class PatchApplyStats(BaseModel):
    nodesMerged: int = 0
    nodesDeleted: int = 0
    edgesMerged: int = 0
    edgesDeleted: int = 0
    embeddingsRefreshed: int = 0
    durationMs: int = 0


class PatchResponse(BaseModel):
    status: Literal["ok", "error"]
    message: str
    stats: PatchApplyStats

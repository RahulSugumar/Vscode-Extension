export const GRAPH_SCHEMA_VERSION = 7;
export const DEFAULT_GRAPH_ANALYZER_VERSION = "tree-sitter-lsp-framework-flow-v1";

export const KNOWN_NODE_TYPES = [
  "Folder",
  "File",
  "Class",
  "Method",
  "Function",
  "Interface",
  "Symbol",
  "Occurrence",
  "Definition",
  "Declaration",
  "Reference",
  "ExternalSymbol",
  "Module",
  "Package",
  "Namespace",
  "Variable",
  "Local",
  "Parameter",
  "Field",
  "Property",
  "Constant",
  "Import",
  "Export",
  "TypeAlias",
  "Enum",
  "EnumMember",
  "Decorator",
  "Annotation",
  "Comment",
  "DocBlock",
  "ConfigFile",
  "Dependency",
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
] as const;

export const KNOWN_RELATIONSHIP_TYPES = [
  "CONTAINS",
  "CALLS",
  "IMPORTS_FROM",
  "EXTENDS",
  "IMPLEMENTS",
  "INSTANTIATES",
  "HAS_OCCURRENCE",
  "DEFINES",
  "DECLARES",
  "REFERS_TO",
  "RESOLVES_TO",
  "REF_CALL",
  "HAS_PARAM",
  "HAS_FIELD",
  "HAS_PROPERTY",
  "HAS_TYPE_PARAM",
  "TYPE_OF",
  "RETURNS",
  "IMPORTS",
  "EXPORTS",
  "REEXPORTS",
  "ALIASES",
  "DOCUMENTS",
  "ANNOTATED_BY",
  "CALL_SITE_OF",
  "HAS_ARGUMENT",
  "ARGUMENT_FLOWS_TO_PARAMETER",
  "RECEIVER_OF",
  "RETURN_FLOWS_TO_CALLER",
  "OVERRIDES",
  "CALLS_OVERRIDE",
  "ROUTES_TO",
  "HANDLES",
  "CALLS_SERVICE",
  "QUERIES_TABLE",
  "USES_MODEL",
  "EMITS_EVENT",
  "SUBSCRIBES_TO",
  "RENDERS",
  "USES_HOOK",
  "UPDATES_STATE",
  "BINDS_TEMPLATE",
  "DEPENDS_ON",
  "USED_BY",
  "AFFECTS",
  "IMPACT_PATH",
  "CHANGES_PUBLIC_API",
  "CFG_NEXT",
  "BRANCH_TRUE",
  "BRANCH_FALSE",
  "LOOP_BACK",
  "EXCEPTION_FLOW",
  "RETURNS_TO",
  "DOMINATES",
  "POST_DOMINATES",
  "CONTROL_DEPENDS_ON",
  "READS",
  "WRITES",
  "ASSIGNS",
  "USES_VALUE",
  "DEFINES_VALUE",
  "REACHING_DEF",
  "FLOWS_TO",
  "PARAM_FLOWS_TO_ARG",
  "ARG_FLOWS_TO_PARAM",
  "RETURN_FLOWS_TO",
  "FIELD_READ",
  "FIELD_WRITE",
  "CAPTURES",
] as const;

export type KnownNodeType = (typeof KNOWN_NODE_TYPES)[number];
export type KnownRelationshipType = (typeof KNOWN_RELATIONSHIP_TYPES)[number];
export type GraphNodeType = KnownNodeType | (string & {});
export type GraphRelationshipType = KnownRelationshipType | (string & {});
export type GraphAnalysisDepth =
  | "structural"
  | "symbols"
  | "calls"
  | "framework"
  | "flow"
  | "security"
  | (string & {});

export interface SourceRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  startByte?: number;
  endByte?: number;
}

export interface GraphMetadata {
  workspaceRoot?: string;
  generatedAt?: string;
  analyzerVersion?: string;
  analysisDepth?: GraphAnalysisDepth;
}

export interface Graph {
  schemaVersion: number;
  metadata: GraphMetadata;
  nodes: GraphNodeModel[];
  edges: GraphEdgeModel[];
}

export interface GraphNodeModel {
  id: string;
  label: string;
  type: GraphNodeType;
  filePath?: string;
  lineNumber?: number;
  sourceRange?: SourceRange;
  properties?: Record<string, unknown>;
}

export interface GraphEdgeModel {
  id: string;
  source: string;
  target: string;
  relationshipType: GraphRelationshipType;
  sourceRange?: SourceRange;
  properties?: Record<string, unknown>;
}

export function createGraph(metadata: Partial<GraphMetadata> = {}): Graph {
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    metadata: {
      generatedAt: new Date().toISOString(),
      analyzerVersion: DEFAULT_GRAPH_ANALYZER_VERSION,
      analysisDepth: "structural",
      ...metadata,
    },
    nodes: [],
    edges: [],
  };
}

export function normalizeGraph(
  value: unknown,
  metadataDefaults: Partial<GraphMetadata> = {},
): Graph | undefined {
  if (!isRecord(value)) return undefined;
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    return undefined;
  }

  const rawMetadata = isRecord(value.metadata) ? value.metadata : {};
  const schemaVersion =
    typeof value.schemaVersion === "number"
      ? value.schemaVersion
      : 1;

  return {
    schemaVersion,
    metadata: {
      ...metadataDefaults,
      ...cleanMetadata(rawMetadata),
    },
    nodes: value.nodes as GraphNodeModel[],
    edges: value.edges as GraphEdgeModel[],
  };
}

export function withGraphMetadata(
  graph: Graph,
  metadata: Partial<GraphMetadata>,
): Graph {
  return {
    ...graph,
    schemaVersion: graph.schemaVersion ?? GRAPH_SCHEMA_VERSION,
    metadata: {
      ...(graph.metadata ?? {}),
      ...metadata,
    },
  };
}

function cleanMetadata(value: Record<string, unknown>): GraphMetadata {
  const metadata: GraphMetadata = {};
  if (typeof value.workspaceRoot === "string") {
    metadata.workspaceRoot = value.workspaceRoot;
  }
  if (typeof value.generatedAt === "string") {
    metadata.generatedAt = value.generatedAt;
  }
  if (typeof value.analyzerVersion === "string") {
    metadata.analyzerVersion = value.analyzerVersion;
  }
  if (typeof value.analysisDepth === "string") {
    metadata.analysisDepth = value.analysisDepth;
  }
  return metadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

/** A pending question for the LSP: "what does this reference point to?" */
export interface ResolutionRequest {
  sourceNodeId: string;        // The enclosing function/method/class node
  occurrenceNodeId?: string;   // Exact Reference occurrence node, when available
  callSiteNodeId?: string;     // Exact CallExpression node, when this reference is a call
  argumentNodeIds?: string[];  // Ordered Argument nodes for the call site
  receiverNodeId?: string;     // Receiver node for member/selector calls
  returnValueNodeId?: string;  // ReturnValue node for the call expression
  sourceUri: string;
  refLine: number;             // 0-indexed
  refCharacter: number;        // 0-indexed
  refText: string;
  kind: "call" | "import" | "extends" | "implements" | "new";
  sourceRange?: SourceRange;
}

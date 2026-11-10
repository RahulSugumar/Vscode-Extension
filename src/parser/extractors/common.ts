import * as vscode from "vscode";
import { createHash } from "crypto";
import { SyntaxNode } from "web-tree-sitter";
import {
  GraphEdgeModel,
  GraphNodeModel,
  GraphNodeType,
  GraphRelationshipType,
  SourceRange,
} from "../../models/Graph";
import { sourceRangeFromSyntaxNode } from "../SourceRange";

export interface RichExtractionContext {
  astNode: SyntaxNode;
  uri: vscode.Uri;
  fileNodeId: string;
  enclosingScopeId: string;
  currentScopeId: string;
  scopePath: readonly string[];
  nodes: GraphNodeModel[];
  edges: GraphEdgeModel[];
}

export interface RichNodeInput {
  type: GraphNodeType;
  label: string;
  astNode: SyntaxNode;
  rangeNode?: SyntaxNode;
  ownerId?: string;
  properties?: Record<string, unknown>;
}

export interface RichEdgeInput {
  source: string;
  target: string;
  relationshipType: GraphRelationshipType;
  astNode?: SyntaxNode;
  properties?: Record<string, unknown>;
}
export interface FrameworkRouteInput {
  framework: string;
  httpMethod: string;
  path: string;
  handlerId: string;
  astNode: SyntaxNode;
  rangeNode?: SyntaxNode;
  routerName?: string;
  handlerLabel?: string;
  properties?: Record<string, unknown>;
}

export interface FrameworkRoleInput {
  type: GraphNodeType;
  label: string;
  ownerId: string;
  astNode: SyntaxNode;
  rangeNode?: SyntaxNode;
  framework: string;
  role?: string;
  confidence?: "explicit" | "convention";
  properties?: Record<string, unknown>;
}

export function addRichNode(
  ctx: RichExtractionContext,
  input: RichNodeInput,
): GraphNodeModel {
  const rangeNode = input.rangeNode ?? input.astNode;
  const sourceRange = sourceRangeFromSyntaxNode(rangeNode);
  const label = compactLabel(input.label || input.type);
  const node: GraphNodeModel = {
    id: createRichNodeId({
      filePath: ctx.uri.fsPath,
      type: input.type,
      label,
      sourceRange,
    }),
    label,
    type: input.type,
    filePath: ctx.uri.fsPath,
    lineNumber: sourceRange.startLine,
    sourceRange,
    properties: {
      astType: input.astNode.type,
      ownerId: input.ownerId ?? ctx.currentScopeId,
      scopePath: ctx.scopePath.join("."),
      detailNode: true,
      inventoryVisible: isInventoryVisible(input.type),
      ...(input.properties ?? {}),
    },
  };
  pushNode(ctx.nodes, node);
  return node;
}

export function addRichEdge(
  ctx: RichExtractionContext,
  input: RichEdgeInput,
): GraphEdgeModel {
  const sourceRange = input.astNode
    ? sourceRangeFromSyntaxNode(input.astNode)
    : undefined;
  const edge: GraphEdgeModel = {
    id: createRichEdgeId({
      source: input.source,
      target: input.target,
      relationshipType: input.relationshipType,
      sourceRange,
    }),
    source: input.source,
    target: input.target,
    relationshipType: input.relationshipType,
    sourceRange,
    properties: input.properties,
  };
  pushEdge(ctx.edges, edge);
  return edge;
}

export function addTypedAnnotation(
  ctx: RichExtractionContext,
  ownerId: string,
  annotationNode: SyntaxNode | undefined | null,
  relationshipType: "TYPE_OF" | "RETURNS",
  annotationKind: string,
): GraphNodeModel | undefined {
  if (!annotationNode) return undefined;
  const label = cleanTypeText(annotationNode.text);
  if (!label) return undefined;
  const annotation = addRichNode(ctx, {
    type: "Annotation",
    label,
    astNode: annotationNode,
    ownerId,
    properties: {
      annotationKind,
      relationshipType,
    },
  });
  addRichEdge(ctx, {
    source: ownerId,
    target: annotation.id,
    relationshipType,
    astNode: annotationNode,
  });
  return annotation;
}

export function addContainment(
  ctx: RichExtractionContext,
  ownerId: string,
  childId: string,
  astNode: SyntaxNode,
): void {
  if (!ownerId || ownerId === childId) return;
  addRichEdge(ctx, {
    source: ownerId,
    target: childId,
    relationshipType: "CONTAINS",
    astNode,
    properties: { detailContainment: true },
  });
}


export function addFrameworkRoute(
  ctx: RichExtractionContext,
  input: FrameworkRouteInput,
): { route: GraphNodeModel; endpoint: GraphNodeModel } | undefined {
  const path = compactLabel(input.path, 160);
  if (!path) return undefined;
  const httpMethod = normalizeHttpMethod(input.httpMethod);
  const label = `${httpMethod} ${path}`;
  const properties = {
    framework: input.framework,
    httpMethod,
    path,
    routerName: input.routerName,
    handlerId: input.handlerId,
    handlerLabel: input.handlerLabel,
    frameworkRole: "Route",
    inventoryVisible: true,
    ...(input.properties ?? {}),
  };

  const route = addRichNode(ctx, {
    type: "Route",
    label,
    astNode: input.astNode,
    rangeNode: input.rangeNode ?? input.astNode,
    ownerId: input.handlerId,
    properties,
  });

  const endpoint = addRichNode(ctx, {
    type: "Endpoint",
    label: `${input.framework} ${label}`,
    astNode: input.astNode,
    rangeNode: input.rangeNode ?? input.astNode,
    ownerId: route.id,
    properties: {
      ...properties,
      frameworkRole: "Endpoint",
      routeId: route.id,
    },
  });

  addRichEdge(ctx, {
    source: route.id,
    target: input.handlerId,
    relationshipType: "ROUTES_TO",
    astNode: input.astNode,
    properties,
  });
  addRichEdge(ctx, {
    source: endpoint.id,
    target: input.handlerId,
    relationshipType: "HANDLES",
    astNode: input.astNode,
    properties: { ...properties, routeId: route.id },
  });
  addRichEdge(ctx, {
    source: endpoint.id,
    target: route.id,
    relationshipType: "DEPENDS_ON",
    astNode: input.astNode,
    properties: { framework: input.framework, dependencyKind: "route" },
  });

  return { route, endpoint };
}

export function addFrameworkRoleNode(
  ctx: RichExtractionContext,
  input: FrameworkRoleInput,
): GraphNodeModel {
  const role = input.role ?? String(input.type);
  const node = addRichNode(ctx, {
    type: input.type,
    label: input.label,
    astNode: input.astNode,
    rangeNode: input.rangeNode ?? input.astNode,
    ownerId: input.ownerId,
    properties: {
      framework: input.framework,
      frameworkRole: role,
      roleOwnerId: input.ownerId,
      architectureRole: true,
      confidence: input.confidence ?? "explicit",
      inventoryVisible: true,
      ...(input.properties ?? {}),
    },
  });

  addRichEdge(ctx, {
    source: node.id,
    target: input.ownerId,
    relationshipType: "USED_BY",
    astNode: input.astNode,
    properties: {
      framework: input.framework,
      frameworkRole: role,
      confidence: input.confidence ?? "explicit",
    },
  });

  return node;
}

export function stringLiteralValues(value: string): string[] {
  const result: string[] = [];
  const pattern = /(["'`])([^"'`]*)\1/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    if (match[2] !== undefined) result.push(match[2]);
  }
  return result;
}

export function firstStringLiteralValue(value: string): string | undefined {
  return stringLiteralValues(value)[0];
}

export function normalizeHttpMethod(value: string): string {
  const method = value.replace(/^HTTP_?/i, "").trim().toUpperCase();
  if (method === "DEL") return "DELETE";
  if (method === "ANY" || method === "ALL" || method === "ROUTE") return "ANY";
  return method || "ANY";
}

export function frameworkRoleFromNameOrPath(
  label: string,
  filePath: string,
): "Controller" | "Service" | "Repository" | undefined {
  const combined = `${filePath}/${label}`.replace(/\\/g, "/").toLowerCase();
  if (/\/controllers?\//.test(combined) || /controller\b/.test(combined)) {
    return "Controller";
  }
  if (/\/services?\//.test(combined) || /service\b/.test(combined)) {
    return "Service";
  }
  if (/\/repositories?\//.test(combined) || /repository\b/.test(combined) || /repo\b/.test(combined)) {
    return "Repository";
  }
  return undefined;
}

export function ownerType(ctx: RichExtractionContext): string | undefined {
  return ctx.nodes.find((node) => node.id === ctx.currentScopeId)?.type;
}

export function compactLabel(value: string, maxLength = 80): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1)}...`;
}

export function cleanTypeText(value: string): string {
  return compactLabel(
    value
      .replace(/^:\s*/, "")
      .replace(/^->\s*/, "")
      .replace(/^as\s+/, "")
      .trim(),
    100,
  );
}

export function unquote(value: string): string {
  const clean = value.trim();
  if (clean.length >= 2) {
    const first = clean[0];
    const last = clean[clean.length - 1];
    if (
      (first === "'" && last === "'") ||
      (first === '"' && last === '"') ||
      (first === "`" && last === "`")
    ) {
      return clean.slice(1, -1);
    }
  }
  return clean;
}

export function firstNamedChildOfType(
  node: SyntaxNode,
  types: readonly string[],
): SyntaxNode | undefined {
  return node.namedChildren.find((child) => types.includes(child.type));
}

export function firstDescendantOfType(
  node: SyntaxNode,
  types: readonly string[],
): SyntaxNode | undefined {
  const stack = [...node.namedChildren];
  while (stack.length > 0) {
    const current = stack.shift();
    if (!current) break;
    if (types.includes(current.type)) return current;
    stack.unshift(...current.namedChildren);
  }
  return undefined;
}

export function hasAncestorType(
  node: SyntaxNode,
  types: readonly string[],
  maxDepth = 6,
): boolean {
  let current = node.parent;
  let depth = 0;
  while (current && depth < maxDepth) {
    if (types.includes(current.type)) return true;
    current = current.parent;
    depth++;
  }
  return false;
}

export function isUppercaseName(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name);
}

export function pushNode(nodes: GraphNodeModel[], node: GraphNodeModel): void {
  if (nodes.some((existing) => existing.id === node.id)) return;
  nodes.push(node);
}

export function pushEdge(edges: GraphEdgeModel[], edge: GraphEdgeModel): void {
  if (edges.some((existing) => existing.id === edge.id)) return;
  edges.push(edge);
}

function isInventoryVisible(type: GraphNodeType): boolean {
  return [
    "Namespace",
    "Field",
    "Property",
    "Constant",
    "Import",
    "Export",
    "TypeAlias",
    "Enum",
    "EnumMember",
    "Decorator",
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
  ].includes(type);
}

function createRichNodeId(input: {
  filePath: string;
  type: GraphNodeType;
  label: string;
  sourceRange: SourceRange;
}): string {
  const start = input.sourceRange.startByte ?? input.sourceRange.startLine;
  const end = input.sourceRange.endByte ?? input.sourceRange.endLine;
  const digest = shortHash(
    `${input.filePath}|${input.type}|${input.label}|${start}|${end}`,
  );
  return `${input.filePath}:rich:${input.type}:${start}:${end}:${digest}`;
}

function createRichEdgeId(input: {
  source: string;
  target: string;
  relationshipType: GraphRelationshipType;
  sourceRange?: SourceRange;
}): string {
  const start = input.sourceRange?.startByte ?? "";
  const end = input.sourceRange?.endByte ?? "";
  const digest = shortHash(
    `${input.relationshipType}|${input.source}|${input.target}|${start}|${end}`,
  );
  return `edge_${String(input.relationshipType).toLowerCase()}_${digest}`;
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

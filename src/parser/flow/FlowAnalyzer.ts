import { createHash } from "crypto";
import * as vscode from "vscode";
import { SyntaxNode } from "web-tree-sitter";
import {
  GraphEdgeModel,
  GraphNodeModel,
  GraphNodeType,
  GraphRelationshipType,
  SourceRange,
} from "../../models/Graph";
import { sourceRangeFromSyntaxNode } from "../SourceRange";

const MAX_FLOW_NODES_PER_FUNCTION = 220;
const MAX_FLOW_DEPTH = 5;

const BLOCK_TYPES = new Set([
  "block",
  "statement_block",
  "compound_statement",
  "declaration_list",
  "block_statement",
  "body",
  "do_block",
]);

const FUNCTION_LIKE_TYPES = new Set([
  "function_definition",
  "function_declaration",
  "function_item",
  "function_expression",
  "arrow_function",
  "generator_function",
  "generator_function_declaration",
  "method_definition",
  "method_declaration",
  "method_signature",
  "constructor_declaration",
  "lambda",
  "lambda_expression",
]);

const IDENTIFIER_TYPES = new Set([
  "identifier",
  "type_identifier",
  "field_identifier",
  "property_identifier",
  "shorthand_field_identifier",
  "scoped_identifier",
  "qualified_name",
  "dotted_name",
]);

const IGNORED_IDENTIFIER_TEXT = new Set([
  "this",
  "self",
  "super",
  "true",
  "false",
  "null",
  "none",
  "nil",
  "undefined",
]);

const TERMINAL_FLOW_TYPES = new Set<GraphNodeType>([
  "ReturnStatement",
  "ThrowStatement",
  "BreakStatement",
  "ContinueStatement",
]);

interface FlowAnalyzeInput {
  astNode: SyntaxNode;
  uri: vscode.Uri;
  fileNodeId: string;
  ownerId: string;
  nodes: GraphNodeModel[];
  edges: GraphEdgeModel[];
}

interface FlowContext extends FlowAnalyzeInput {
  entryNodeId: string;
  valueNodesByName: Map<string, string>;
  lastWriteByName: Map<string, string>;
  emittedNodes: number;
}

interface FlowBuildResult {
  firstNodeId?: string;
  tailNodeIds: string[];
}

interface PendingEdge {
  source: string;
  relationshipType: GraphRelationshipType;
}

export class FlowAnalyzer {
  public analyzeFunction(input: FlowAnalyzeInput): void {
    const body = functionBody(input.astNode);
    if (!body) return;

    const statements = directStatements(body).filter(
      (statement) => !FUNCTION_LIKE_TYPES.has(statement.type),
    );
    if (statements.length === 0) return;

    const entry = this.addFlowNode(
      {
        ...input,
        entryNodeId: "",
        valueNodesByName: new Map<string, string>(),
        lastWriteByName: new Map<string, string>(),
        emittedNodes: 0,
      },
      {
        type: "BasicBlock",
        label: "entry",
        astNode: input.astNode,
        properties: { blockKind: "entry" },
      },
    );

    const ctx: FlowContext = {
      ...input,
      entryNodeId: entry.id,
      valueNodesByName: new Map<string, string>(),
      lastWriteByName: new Map<string, string>(),
      emittedNodes: 1,
    };

    this.addFlowEdge(ctx, ctx.ownerId, entry.id, "CONTAINS", input.astNode, {
      flowEntry: true,
    });
    this.seedParameterValues(ctx);
    this.buildSequentialFlow(ctx, statements, [
      { source: entry.id, relationshipType: "CFG_NEXT" },
    ], 0);
  }

  private buildSequentialFlow(
    ctx: FlowContext,
    statements: SyntaxNode[],
    incoming: PendingEdge[],
    depth: number,
  ): FlowBuildResult {
    if (statements.length === 0 || depth > MAX_FLOW_DEPTH) {
      return { tailNodeIds: incoming.map((edge) => edge.source) };
    }

    let firstNodeId: string | undefined;
    let pending = incoming;
    let tails: string[] = [];

    statements.forEach((statement, index) => {
      if (ctx.emittedNodes >= MAX_FLOW_NODES_PER_FUNCTION) return;

      const flowType = classifyFlowType(statement);
      const flowNode = this.addFlowNode(ctx, {
        type: flowType,
        label: flowLabel(flowType, statement),
        astNode: statement,
        properties: {
          flowIndex: index,
          flowDepth: depth,
          flowKind: statement.type,
        },
      });

      if (!firstNodeId) firstNodeId = flowNode.id;
      for (const edge of pending) {
        this.addFlowEdge(ctx, edge.source, flowNode.id, edge.relationshipType, statement);
      }

      this.recordDataFlow(ctx, statement, flowNode.id, flowType);
      const branchTails = this.addNestedControlFlow(ctx, statement, flowNode.id, depth + 1);
      tails = branchTails.length > 0 ? branchTails : [flowNode.id];
      pending = TERMINAL_FLOW_TYPES.has(flowType)
        ? []
        : tails.map((source) => ({ source, relationshipType: "CFG_NEXT" as const }));
    });

    return { firstNodeId, tailNodeIds: tails };
  }

  private addNestedControlFlow(
    ctx: FlowContext,
    statement: SyntaxNode,
    flowNodeId: string,
    depth: number,
  ): string[] {
    const flowType = classifyFlowType(statement);
    if (flowType === "IfStatement") {
      this.addConditionExpression(ctx, statement, flowNodeId);
      const thenStatements = branchStatements(statement, ["consequence", "then", "body"]);
      const elseStatements = branchStatements(statement, ["alternative", "else"]);
      const trueBranch = this.buildSequentialFlow(
        ctx,
        thenStatements,
        [{ source: flowNodeId, relationshipType: "BRANCH_TRUE" }],
        depth,
      );
      const falseBranch = this.buildSequentialFlow(
        ctx,
        elseStatements,
        [{ source: flowNodeId, relationshipType: "BRANCH_FALSE" }],
        depth,
      );
      return [
        ...(trueBranch.tailNodeIds.length ? trueBranch.tailNodeIds : [flowNodeId]),
        ...(elseStatements.length
          ? falseBranch.tailNodeIds.length
            ? falseBranch.tailNodeIds
            : [flowNodeId]
          : [flowNodeId]),
      ];
    }

    if (flowType === "Loop") {
      this.addConditionExpression(ctx, statement, flowNodeId);
      const bodyStatements = branchStatements(statement, ["body", "consequence"]);
      const body = this.buildSequentialFlow(
        ctx,
        bodyStatements,
        [{ source: flowNodeId, relationshipType: "BRANCH_TRUE" }],
        depth,
      );
      for (const tail of body.tailNodeIds) {
        this.addFlowEdge(ctx, tail, flowNodeId, "LOOP_BACK", statement);
      }
      return [flowNodeId];
    }

    if (flowType === "TryCatch") {
      const tryStatements = branchStatements(statement, ["body"]);
      const tryFlow = this.buildSequentialFlow(
        ctx,
        tryStatements,
        [{ source: flowNodeId, relationshipType: "CFG_NEXT" }],
        depth,
      );
      const catchNodes = statement.namedChildren.filter((child) =>
        ["catch_clause", "except_clause", "except_group_clause", "finally_clause"].includes(child.type),
      );
      const catchTails: string[] = [];
      catchNodes.forEach((catchNode) => {
        const catchFlow = this.buildSequentialFlow(
          ctx,
          directStatements(catchNode),
          [{ source: flowNodeId, relationshipType: "EXCEPTION_FLOW" }],
          depth,
        );
        catchTails.push(...catchFlow.tailNodeIds);
      });
      return [...tryFlow.tailNodeIds, ...catchTails, flowNodeId];
    }

    if (flowType === "SwitchCase") {
      const cases = statement.namedChildren.filter((child) =>
        ["case_clause", "switch_case", "case_statement", "match_arm", "default_clause"].includes(child.type),
      );
      const caseTails: string[] = [];
      cases.forEach((caseNode) => {
        const caseFlow = this.buildSequentialFlow(
          ctx,
          [caseNode],
          [{ source: flowNodeId, relationshipType: "CFG_NEXT" }],
          depth,
        );
        caseTails.push(...caseFlow.tailNodeIds);
      });
      return caseTails.length ? caseTails : [flowNodeId];
    }

    if (flowType === "ReturnStatement") {
      this.addReturnExpression(ctx, statement, flowNodeId);
      this.addFlowEdge(ctx, flowNodeId, ctx.ownerId, "RETURNS_TO", statement);
      return [flowNodeId];
    }

    if (flowType === "ThrowStatement") {
      this.addConditionExpression(ctx, statement, flowNodeId, "throw expression");
      return [flowNodeId];
    }

    return [];
  }

  private seedParameterValues(ctx: FlowContext): void {
    for (const node of ctx.nodes) {
      if (node.type !== "Parameter") continue;
      const props = node.properties;
      if (!props || typeof props !== "object") continue;
      if (props["ownerId"] !== ctx.ownerId) continue;
      const name = String(node.label || "").trim();
      if (!name) continue;
      const valueId = this.ensureValueNode(ctx, name, node.sourceRange, {
        valueKind: "parameter",
        parameterId: node.id,
      });
      this.addFlowEdge(ctx, node.id, valueId, "DEFINES_VALUE", undefined, {
        valueName: name,
        valueKind: "parameter",
      });
      ctx.lastWriteByName.set(name, node.id);
    }
  }

  private recordDataFlow(
    ctx: FlowContext,
    statement: SyntaxNode,
    flowNodeId: string,
    flowType: GraphNodeType,
  ): void {
    const assignment = assignmentParts(statement);
    if (assignment) {
      const rhsExpression = this.addExpressionNode(ctx, assignment.value, "assigned expression", flowNodeId);
      if (rhsExpression) {
        this.addFlowEdge(ctx, rhsExpression.id, flowNodeId, "FLOWS_TO", assignment.value);
      }
      for (const read of identifierReads(assignment.value)) {
        this.addReadEdges(ctx, read, rhsExpression?.id ?? flowNodeId);
      }
      for (const target of assignment.targets) {
        const name = valueName(target);
        if (!name) continue;
        const valueId = this.ensureValueNode(ctx, name, sourceRangeFromSyntaxNode(target), {
          valueKind: isFieldAccess(target) ? "field" : "local",
        });
        this.addFlowEdge(ctx, flowNodeId, valueId, "WRITES", target, { valueName: name });
        this.addFlowEdge(ctx, flowNodeId, valueId, "DEFINES_VALUE", target, { valueName: name });
        if (rhsExpression) {
          this.addFlowEdge(ctx, rhsExpression.id, valueId, "ASSIGNS", target, { valueName: name });
        }
        if (isFieldAccess(target)) {
          this.addFlowEdge(ctx, flowNodeId, valueId, "FIELD_WRITE", target, { valueName: name });
        }
        ctx.lastWriteByName.set(name, flowNodeId);
      }
      return;
    }

    if (flowType === "ReturnStatement" || flowType === "ThrowStatement") {
      const expr = returnExpression(statement);
      identifierReads(expr ?? statement).forEach((read) => this.addReadEdges(ctx, read, flowNodeId));
      return;
    }

    identifierReads(statement).forEach((read) => this.addReadEdges(ctx, read, flowNodeId));
  }

  private addReadEdges(ctx: FlowContext, read: SyntaxNode, readerNodeId: string): void {
    const name = valueName(read);
    if (!name) return;
    const valueId = this.ensureValueNode(ctx, name, sourceRangeFromSyntaxNode(read), {
      valueKind: isFieldAccess(read) ? "field" : "local",
    });
    this.addFlowEdge(ctx, readerNodeId, valueId, "READS", read, { valueName: name });
    this.addFlowEdge(ctx, valueId, readerNodeId, "USES_VALUE", read, { valueName: name });
    if (isFieldAccess(read)) {
      this.addFlowEdge(ctx, readerNodeId, valueId, "FIELD_READ", read, { valueName: name });
    }
    const lastWrite = ctx.lastWriteByName.get(name);
    if (lastWrite && lastWrite !== readerNodeId) {
      this.addFlowEdge(ctx, lastWrite, readerNodeId, "REACHING_DEF", read, { valueName: name });
      this.addFlowEdge(ctx, lastWrite, valueId, "FLOWS_TO", read, { valueName: name });
    }
  }

  private addConditionExpression(
    ctx: FlowContext,
    statement: SyntaxNode,
    flowNodeId: string,
    label = "condition",
  ): void {
    const condition =
      statement.childForFieldName("condition") ??
      statement.childForFieldName("predicate") ??
      statement.namedChildren.find((child) => !BLOCK_TYPES.has(child.type));
    if (!condition || condition === statement) return;
    const expression = this.addExpressionNode(ctx, condition, label, flowNodeId);
    if (!expression) return;
    this.addFlowEdge(ctx, flowNodeId, expression.id, "CONTROL_DEPENDS_ON", condition);
    identifierReads(condition).forEach((read) => this.addReadEdges(ctx, read, expression.id));
  }

  private addReturnExpression(ctx: FlowContext, statement: SyntaxNode, flowNodeId: string): void {
    const expr = returnExpression(statement);
    if (!expr) return;
    const expression = this.addExpressionNode(ctx, expr, "return expression", flowNodeId);
    if (!expression) return;
    this.addFlowEdge(ctx, expression.id, flowNodeId, "RETURN_FLOWS_TO", expr);
    identifierReads(expr).forEach((read) => this.addReadEdges(ctx, read, expression.id));
  }

  private addExpressionNode(
    ctx: FlowContext,
    astNode: SyntaxNode,
    labelPrefix: string,
    ownerId: string,
  ): GraphNodeModel | undefined {
    if (ctx.emittedNodes >= MAX_FLOW_NODES_PER_FUNCTION) return undefined;
    return this.addFlowNode(ctx, {
      type: expressionNodeType(astNode),
      label: compactLabel(`${labelPrefix}: ${astNode.text}`, 90),
      astNode,
      properties: {
        expressionKind: astNode.type,
        expressionOwnerId: ownerId,
      },
    });
  }

  private ensureValueNode(
    ctx: FlowContext,
    name: string,
    range: SourceRange | undefined,
    properties: Record<string, unknown> = {},
  ): string {
    const key = `${ctx.ownerId}|${name}`;
    const existing = ctx.valueNodesByName.get(key);
    if (existing) return existing;

    const sourceRange = range ?? sourceRangeFromSyntaxNode(ctx.astNode);
    const id = createFlowNodeId(ctx.uri.fsPath, ctx.ownerId, "Value", name, sourceRange);
    this.pushNode(ctx.nodes, {
      id,
      label: compactLabel(name, 80),
      type: "Value",
      filePath: ctx.uri.fsPath,
      lineNumber: sourceRange.startLine,
      sourceRange,
      properties: {
        ownerId: ctx.ownerId,
        fileNodeId: ctx.fileNodeId,
        flowNode: true,
        detailNode: true,
        inventoryVisible: false,
        valueName: name,
        ...properties,
      },
    });
    ctx.valueNodesByName.set(key, id);
    return id;
  }

  private addFlowNode(
    ctx: FlowContext,
    input: {
      type: GraphNodeType;
      label: string;
      astNode: SyntaxNode;
      properties?: Record<string, unknown>;
    },
  ): GraphNodeModel {
    const sourceRange = sourceRangeFromSyntaxNode(input.astNode);
    const label = compactLabel(input.label || String(input.type), 100);
    const node: GraphNodeModel = {
      id: createFlowNodeId(ctx.uri.fsPath, ctx.ownerId, input.type, label, sourceRange),
      label,
      type: input.type,
      filePath: ctx.uri.fsPath,
      lineNumber: sourceRange.startLine,
      sourceRange,
      properties: {
        ownerId: ctx.ownerId,
        fileNodeId: ctx.fileNodeId,
        astType: input.astNode.type,
        flowNode: true,
        detailNode: true,
        inventoryVisible: false,
        ...(input.properties ?? {}),
      },
    };
    this.pushNode(ctx.nodes, node);
    ctx.emittedNodes += 1;
    return node;
  }

  private addFlowEdge(
    ctx: FlowContext,
    source: string,
    target: string,
    relationshipType: GraphRelationshipType,
    astNode?: SyntaxNode,
    properties: Record<string, unknown> = {},
  ): void {
    if (!source || !target || source === target) return;
    const sourceRange = astNode ? sourceRangeFromSyntaxNode(astNode) : undefined;
    this.pushEdge(ctx.edges, {
      id: createFlowEdgeId(source, target, relationshipType, sourceRange, properties),
      source,
      target,
      relationshipType,
      sourceRange,
      properties: {
        ownerId: ctx.ownerId,
        flowEdge: true,
        ...(Object.keys(properties).length ? properties : undefined),
      },
    });
  }

  private pushNode(nodes: GraphNodeModel[], node: GraphNodeModel): void {
    if (nodes.some((existing) => existing.id === node.id)) return;
    nodes.push(node);
  }

  private pushEdge(edges: GraphEdgeModel[], edge: GraphEdgeModel): void {
    if (edges.some((existing) => existing.id === edge.id)) return;
    edges.push(edge);
  }
}

function functionBody(node: SyntaxNode): SyntaxNode | undefined {
  return (
    node.childForFieldName("body") ??
    node.namedChildren.find((child) => BLOCK_TYPES.has(child.type)) ??
    node.namedChildren[node.namedChildren.length - 1]
  );
}

function directStatements(node: SyntaxNode): SyntaxNode[] {
  const body = BLOCK_TYPES.has(node.type) || node.type.endsWith("clause") ? node : functionBody(node);
  const source = body ?? node;
  const statements = source.namedChildren.filter(
    (child) =>
      !["comment", "line_comment", "block_comment", "decorator", "annotation", "attribute"].includes(child.type),
  );
  return statements.length > 0 ? statements : source === node ? [] : [source];
}

function branchStatements(node: SyntaxNode, fieldNames: readonly string[]): SyntaxNode[] {
  for (const name of fieldNames) {
    const field = node.childForFieldName(name);
    if (field) return directStatements(field);
  }
  const block = node.namedChildren.find((child) => BLOCK_TYPES.has(child.type));
  return block ? directStatements(block) : [];
}

function classifyFlowType(node: SyntaxNode): GraphNodeType {
  if (["if_statement", "if_expression", "conditional_expression"].includes(node.type)) return "IfStatement";
  if (
    [
      "for_statement",
      "for_in_statement",
      "enhanced_for_statement",
      "foreach_statement",
      "while_statement",
      "do_statement",
      "loop_expression",
      "for_expression",
      "while_expression",
      "range_clause",
    ].includes(node.type)
  ) {
    return "Loop";
  }
  if (
    [
      "switch_statement",
      "switch_expression",
      "match_expression",
      "case_clause",
      "switch_case",
      "case_statement",
      "match_arm",
      "default_clause",
    ].includes(node.type)
  ) {
    return "SwitchCase";
  }
  if (
    [
      "try_statement",
      "try_expression",
      "try_with_resources_statement",
      "catch_clause",
      "except_clause",
      "except_group_clause",
      "finally_clause",
    ].includes(node.type)
  ) {
    return "TryCatch";
  }
  if (["return_statement", "return_expression"].includes(node.type)) return "ReturnStatement";
  if (["throw_statement", "throw_expression", "raise_statement"].includes(node.type)) return "ThrowStatement";
  if (["break_statement", "break_expression"].includes(node.type)) return "BreakStatement";
  if (["continue_statement", "continue_expression"].includes(node.type)) return "ContinueStatement";
  if (assignmentParts(node)) return "Assignment";
  if (["expression_statement", "parenthesized_expression", "binary_expression", "unary_expression"].includes(node.type)) return "Expression";
  return "BasicBlock";
}

function flowLabel(type: GraphNodeType, node: SyntaxNode): string {
  const prefix = String(type).replace(/([a-z])([A-Z])/g, "$1 $2");
  return compactLabel(`${prefix}: ${node.text}`, 90);
}

function expressionNodeType(node: SyntaxNode): GraphNodeType {
  const text = node.text.toLowerCase();
  if (/\b(req|request|params|query|body|headers|input|stdin|env|process\.env)\b/.test(text)) {
    return "SourceExpression";
  }
  if (/\b(sql|query|exec|execute|send|write|render|redirect|open|fetch|http|response)\b/.test(text)) {
    return "SinkExpression";
  }
  return "Expression";
}

function assignmentParts(node: SyntaxNode): { targets: SyntaxNode[]; value: SyntaxNode } | undefined {
  const isAssignment = [
    "assignment",
    "augmented_assignment",
    "assignment_expression",
    "variable_declarator",
    "lexical_declaration",
    "variable_declaration",
    "local_variable_declaration",
    "let_declaration",
    "short_var_declaration",
    "var_spec",
    "const_spec",
  ].includes(node.type);
  if (!isAssignment) return undefined;

  if (
    [
      "lexical_declaration",
      "variable_declaration",
      "local_variable_declaration",
      "let_declaration",
      "var_spec",
      "const_spec",
    ].includes(node.type)
  ) {
    const declarationTargets = declarationTargetNodes(node);
    if (declarationTargets.length > 0) {
      return {
        targets: declarationTargets,
        value: declarationValueNode(node) ?? node,
      };
    }
  }

  const left =
    node.childForFieldName("left") ??
    node.childForFieldName("name") ??
    node.childForFieldName("pattern") ??
    node.namedChildren[0];
  const value =
    node.childForFieldName("right") ??
    node.childForFieldName("value") ??
    node.namedChildren[node.namedChildren.length - 1];
  if (!left || !value || left === value) return undefined;

  const targets = targetIdentifiers(left);
  return targets.length > 0 ? { targets, value } : undefined;
}

function declarationTargetNodes(node: SyntaxNode): SyntaxNode[] {
  const targets: SyntaxNode[] = [];
  const declarators = node.namedChildren.length > 0 ? node.namedChildren : [node];
  for (const declarator of declarators) {
    const target =
      declarator.childForFieldName("name") ??
      declarator.childForFieldName("pattern") ??
      declarator.childForFieldName("left") ??
      declarator.namedChildren.find((child) => isValueNode(child));
    if (target) targets.push(...targetIdentifiers(target));
  }
  return uniqueSyntaxNodes(targets);
}

function declarationValueNode(node: SyntaxNode): SyntaxNode | undefined {
  for (const declarator of node.namedChildren) {
    const value =
      declarator.childForFieldName("value") ??
      declarator.childForFieldName("right");
    if (value) return value;
  }
  return node.childForFieldName("value") ?? node.childForFieldName("right") ?? undefined;
}

function targetIdentifiers(node: SyntaxNode): SyntaxNode[] {
  if (isValueNode(node)) return [node];
  const result = node.descendantsOfType(Array.from(IDENTIFIER_TYPES));
  return uniqueSyntaxNodes(result.filter((candidate) => isUsefulIdentifier(candidate.text)));
}

function identifierReads(node: SyntaxNode): SyntaxNode[] {
  if (FUNCTION_LIKE_TYPES.has(node.type)) return [];
  const result: SyntaxNode[] = [];
  const stack = [...node.namedChildren];
  while (stack.length > 0) {
    const current = stack.shift();
    if (!current) break;
    if (FUNCTION_LIKE_TYPES.has(current.type)) continue;
    if (isValueNode(current) && isUsefulIdentifier(current.text)) {
      result.push(current);
      continue;
    }
    stack.unshift(...current.namedChildren);
  }
  return uniqueSyntaxNodes(result);
}

function isValueNode(node: SyntaxNode): boolean {
  return IDENTIFIER_TYPES.has(node.type) || isFieldAccess(node);
}

function isFieldAccess(node: SyntaxNode): boolean {
  return [
    "member_expression",
    "member_access_expression",
    "attribute",
    "field_expression",
    "selector_expression",
    "subscript",
    "subscript_expression",
  ].includes(node.type);
}

function valueName(node: SyntaxNode): string | undefined {
  const text = compactLabel(node.text, 100);
  if (!text || !isUsefulIdentifier(text.split(/[.\[]/)[0])) return undefined;
  return text;
}

function returnExpression(node: SyntaxNode): SyntaxNode | undefined {
  return (
    node.childForFieldName("argument") ??
    node.childForFieldName("value") ??
    node.namedChildren.find((child) => !["return", "throw", "raise"].includes(child.type))
  );
}

function isUsefulIdentifier(text: string): boolean {
  const clean = text.trim();
  if (!clean || clean.length > 120) return false;
  if (IGNORED_IDENTIFIER_TEXT.has(clean.toLowerCase())) return false;
  return /[A-Za-z_$]/.test(clean[0] ?? "");
}

function uniqueSyntaxNodes(nodes: SyntaxNode[]): SyntaxNode[] {
  const seen = new Set<string>();
  const result: SyntaxNode[] = [];
  for (const node of nodes) {
    const key = `${node.startIndex}:${node.endIndex}:${node.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(node);
  }
  return result;
}

function createFlowNodeId(
  filePath: string,
  ownerId: string,
  type: GraphNodeType,
  label: string,
  sourceRange: SourceRange,
): string {
  const start = sourceRange.startByte ?? sourceRange.startLine;
  const end = sourceRange.endByte ?? sourceRange.endLine;
  const digest = shortHash(`${filePath}|${ownerId}|${type}|${label}|${start}|${end}`);
  return `${filePath}:flow:${type}:${start}:${end}:${digest}`;
}

function createFlowEdgeId(
  source: string,
  target: string,
  relationshipType: GraphRelationshipType,
  sourceRange: SourceRange | undefined,
  properties: Record<string, unknown>,
): string {
  const start = sourceRange?.startByte ?? "";
  const end = sourceRange?.endByte ?? "";
  const propKey = Object.entries(properties)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${String(value)}`)
    .join("|");
  return `edge_${String(relationshipType).toLowerCase()}_${shortHash(`${relationshipType}|${source}|${target}|${start}|${end}|${propKey}`)}`;
}

function compactLabel(value: string, maxLength = 80): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1)}...`;
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

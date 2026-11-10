import { createHash } from "crypto";
import * as vscode from "vscode";
import { SyntaxNode } from "web-tree-sitter";
import { GraphEdgeModel, GraphNodeModel, ResolutionRequest } from "../models/Graph";
import { sourceRangeFromSyntaxNode } from "./SourceRange";

export interface CallSiteBuildInput {
  astNode: SyntaxNode;
  calleeNode: SyntaxNode;
  targetNode: SyntaxNode;
  uri: vscode.Uri;
  fileNodeId: string;
  enclosingScopeId: string;
  kind: Extract<ResolutionRequest["kind"], "call" | "new">;
}

export interface CallSiteBuildResult {
  callSiteNodeId: string;
  argumentNodeIds: string[];
  receiverNodeId?: string;
  returnValueNodeId?: string;
  nodes: GraphNodeModel[];
  edges: GraphEdgeModel[];
}

export class CallSiteBuilder {
  public build(input: CallSiteBuildInput): CallSiteBuildResult {
    const nodes: GraphNodeModel[] = [];
    const edges: GraphEdgeModel[] = [];
    const callRange = sourceRangeFromSyntaxNode(input.astNode);
    const callSiteNodeId = createStableId("call", [
      input.uri.fsPath,
      input.kind,
      input.targetNode.text,
      callRange.startByte,
      callRange.endByte,
      input.astNode.startPosition.row,
      input.astNode.startPosition.column,
    ]);
    const callee = compactLabel(input.targetNode.text || input.calleeNode.text, 100);

    nodes.push({
      id: callSiteNodeId,
      label: input.kind === "new" ? `new ${callee}` : `${callee}()`,
      type: "CallExpression",
      filePath: input.uri.fsPath,
      lineNumber: callRange.startLine,
      sourceRange: callRange,
      properties: {
        callKind: input.kind,
        callee,
        astType: input.astNode.type,
        enclosingScopeId: input.enclosingScopeId,
        fileNodeId: input.fileNodeId,
      },
    });

    edges.push({
      id: `edge_call_site_of_${hash(`${input.enclosingScopeId}|${callSiteNodeId}`)}`,
      source: input.enclosingScopeId,
      target: callSiteNodeId,
      relationshipType: "CALL_SITE_OF",
      sourceRange: callRange,
      properties: {
        callKind: input.kind,
        callee,
      },
    });

    const argumentNodeIds = this.addArguments(input, callSiteNodeId, nodes, edges);
    const receiverNodeId = this.addReceiver(input, callSiteNodeId, nodes, edges);
    const returnValueNodeId = this.addReturnValue(input, callSiteNodeId, callee, nodes, edges);

    return {
      callSiteNodeId,
      argumentNodeIds,
      receiverNodeId,
      returnValueNodeId,
      nodes,
      edges,
    };
  }

  private addArguments(
    input: CallSiteBuildInput,
    callSiteNodeId: string,
    nodes: GraphNodeModel[],
    edges: GraphEdgeModel[],
  ): string[] {
    const args = argumentNodes(input.astNode);
    const argumentNodeIds: string[] = [];

    args.forEach((arg, index) => {
      const sourceRange = sourceRangeFromSyntaxNode(arg);
      const argumentNodeId = createStableId("arg", [
        callSiteNodeId,
        index,
        sourceRange.startByte,
        sourceRange.endByte,
        arg.text,
      ]);
      argumentNodeIds.push(argumentNodeId);

      nodes.push({
        id: argumentNodeId,
        label: compactLabel(arg.text, 80) || `arg${index}`,
        type: "Argument",
        filePath: input.uri.fsPath,
        lineNumber: sourceRange.startLine,
        sourceRange,
        properties: {
          index,
          callSiteId: callSiteNodeId,
          argumentKind: arg.type,
          enclosingScopeId: input.enclosingScopeId,
        },
      });

      edges.push({
        id: `edge_has_argument_${hash(`${callSiteNodeId}|${argumentNodeId}|${index}`)}`,
        source: callSiteNodeId,
        target: argumentNodeId,
        relationshipType: "HAS_ARGUMENT",
        sourceRange,
        properties: { index },
      });
    });

    return argumentNodeIds;
  }

  private addReceiver(
    input: CallSiteBuildInput,
    callSiteNodeId: string,
    nodes: GraphNodeModel[],
    edges: GraphEdgeModel[],
  ): string | undefined {
    const receiver = receiverNode(input.astNode, input.calleeNode, input.targetNode);
    if (!receiver || receiver.text === input.targetNode.text) return undefined;

    const sourceRange = sourceRangeFromSyntaxNode(receiver);
    const receiverNodeId = createStableId("receiver", [
      callSiteNodeId,
      sourceRange.startByte,
      sourceRange.endByte,
      receiver.text,
    ]);

    nodes.push({
      id: receiverNodeId,
      label: compactLabel(receiver.text, 80),
      type: "Receiver",
      filePath: input.uri.fsPath,
      lineNumber: sourceRange.startLine,
      sourceRange,
      properties: {
        callSiteId: callSiteNodeId,
        receiverKind: receiver.type,
        enclosingScopeId: input.enclosingScopeId,
      },
    });

    edges.push({
      id: `edge_receiver_of_${hash(`${callSiteNodeId}|${receiverNodeId}`)}`,
      source: callSiteNodeId,
      target: receiverNodeId,
      relationshipType: "RECEIVER_OF",
      sourceRange,
    });

    return receiverNodeId;
  }

  private addReturnValue(
    input: CallSiteBuildInput,
    callSiteNodeId: string,
    callee: string,
    nodes: GraphNodeModel[],
    edges: GraphEdgeModel[],
  ): string {
    const sourceRange = sourceRangeFromSyntaxNode(input.astNode);
    const returnValueNodeId = createStableId("return", [
      callSiteNodeId,
      sourceRange.startByte,
      sourceRange.endByte,
    ]);

    nodes.push({
      id: returnValueNodeId,
      label: compactLabel(`return ${callee}`, 80),
      type: "ReturnValue",
      filePath: input.uri.fsPath,
      lineNumber: sourceRange.startLine,
      sourceRange,
      properties: {
        callSiteId: callSiteNodeId,
        callKind: input.kind,
        callee,
        enclosingScopeId: input.enclosingScopeId,
      },
    });

    edges.push({
      id: `edge_return_flows_${hash(`${returnValueNodeId}|${input.enclosingScopeId}`)}`,
      source: returnValueNodeId,
      target: input.enclosingScopeId,
      relationshipType: "RETURN_FLOWS_TO_CALLER",
      sourceRange,
      properties: {
        callSiteNodeId,
        callerNodeId: input.enclosingScopeId,
        callKind: input.kind,
      },
    });

    return returnValueNodeId;
  }
}

function argumentNodes(callNode: SyntaxNode): SyntaxNode[] {
  const container =
    callNode.childForFieldName("arguments") ??
    callNode.namedChildren.find((child) =>
      ["arguments", "argument_list", "call_arguments"].includes(child.type),
    );
  if (!container) return [];

  return container.namedChildren.filter((child) =>
    ![
      "comment",
      "line_comment",
      "block_comment",
      "type_arguments",
      "type_parameters",
      "template_argument_list",
    ].includes(child.type),
  );
}

function receiverNode(
  callNode: SyntaxNode,
  calleeNode: SyntaxNode,
  targetNode: SyntaxNode,
): SyntaxNode | undefined {
  const direct =
    calleeNode.childForFieldName("object") ??
    calleeNode.childForFieldName("receiver") ??
    calleeNode.childForFieldName("expression") ??
    callNode.childForFieldName("object") ??
    callNode.childForFieldName("receiver");
  if (direct && !sameNode(direct, targetNode)) return direct;

  if (sameNode(calleeNode, targetNode)) return undefined;

  const beforeTarget = calleeNode.namedChildren
    .filter((child) => !sameNode(child, targetNode) && child.endIndex <= targetNode.startIndex)
    .sort((a, b) => b.startIndex - a.startIndex);

  return beforeTarget[0];
}

function sameNode(a: SyntaxNode, b: SyntaxNode): boolean {
  return a.type === b.type && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
}

function compactLabel(value: string, maxLength: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1)}...`;
}

function createStableId(prefix: string, parts: unknown[]): string {
  return `callsite:${prefix}:${hash(parts.map((part) => String(part ?? "")).join("|"))}`;
}

function hash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 20);
}

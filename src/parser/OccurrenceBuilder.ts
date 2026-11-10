import * as vscode from "vscode";
import { SyntaxNode } from "web-tree-sitter";
import {
  GraphEdgeModel,
  GraphNodeModel,
  ResolutionRequest,
  SourceRange,
} from "../models/Graph";
import { sourceRangeFromSyntaxNode } from "./SourceRange";
import {
  createDefinitionOccurrenceId,
  createReferenceOccurrenceId,
  createSymbolId,
  qualifiedName,
} from "./SymbolId";

export interface DefinitionOccurrenceInput {
  astNode: SyntaxNode;
  uri: vscode.Uri;
  name: string;
  kind: "Class" | "Method" | "Function" | "Interface";
  legacyNodeId: string;
  fileNodeId: string;
  scopePath: readonly string[];
  isAnonymous: boolean;
  nameOrigin: string;
}

export interface DefinitionOccurrenceResult {
  symbolId: string;
  occurrenceId: string;
  qualifiedName: string;
  sourceRange: SourceRange;
  relationshipType: "DEFINES" | "DECLARES";
  nodes: GraphNodeModel[];
  edges: GraphEdgeModel[];
}

export interface ReferenceOccurrenceInput {
  astNode: SyntaxNode;
  targetNode: SyntaxNode;
  uri: vscode.Uri;
  fileNodeId: string;
  enclosingScopeId: string;
  kind: ResolutionRequest["kind"];
  astType?: string;
}

export interface ReferenceOccurrenceResult {
  occurrenceId: string;
  sourceRange: SourceRange;
  request: ResolutionRequest;
  nodes: GraphNodeModel[];
  edges: GraphEdgeModel[];
}

export class OccurrenceBuilder {
  public buildDefinition(input: DefinitionOccurrenceInput): DefinitionOccurrenceResult {
    const sourceRange = sourceRangeFromSyntaxNode(input.astNode);
    const qName = qualifiedName(input.scopePath, input.name);
    const symbolId = createSymbolId({
      filePath: input.uri.fsPath,
      kind: input.kind,
      name: input.name,
      scopePath: input.scopePath,
      isAnonymous: input.isAnonymous,
      fallbackKey: input.legacyNodeId,
    });
    const occurrenceId = createDefinitionOccurrenceId(
      symbolId,
      sourceRange.startByte,
      sourceRange.endByte,
    );
    const occurrenceType = this.isDeclarationOnly(input.astNode)
      ? "Declaration"
      : "Definition";
    const relationshipType = occurrenceType === "Declaration" ? "DECLARES" : "DEFINES";

    const symbolNode: GraphNodeModel = {
      id: symbolId,
      label: input.name,
      type: "Symbol",
      filePath: input.uri.fsPath,
      lineNumber: sourceRange.startLine,
      sourceRange,
      properties: {
        symbolKind: input.kind,
        qualifiedName: qName,
        isAnonymous: input.isAnonymous,
        nameOrigin: input.nameOrigin,
        declarationNodeId: input.legacyNodeId,
        definitionOccurrenceId: occurrenceId,
      },
    };

    const occurrenceNode: GraphNodeModel = {
      id: occurrenceId,
      label: input.name,
      type: occurrenceType,
      filePath: input.uri.fsPath,
      lineNumber: sourceRange.startLine,
      sourceRange,
      properties: {
        symbolId,
        symbolKind: input.kind,
        qualifiedName: qName,
        legacyNodeId: input.legacyNodeId,
        astType: input.astNode.type,
      },
    };

    return {
      symbolId,
      occurrenceId,
      qualifiedName: qName,
      sourceRange,
      relationshipType,
      nodes: [symbolNode, occurrenceNode],
      edges: [
        {
          id: `edge_has_occurrence_${input.fileNodeId}__${occurrenceId}`,
          source: input.fileNodeId,
          target: occurrenceId,
          relationshipType: "HAS_OCCURRENCE",
        },
        {
          id: `edge_${relationshipType.toLowerCase()}_${symbolId}__${occurrenceId}`,
          source: symbolId,
          target: occurrenceId,
          relationshipType,
        },
        {
          id: `edge_${relationshipType.toLowerCase()}_${input.legacyNodeId}__${symbolId}`,
          source: input.legacyNodeId,
          target: symbolId,
          relationshipType,
        },
      ],
    };
  }

  public buildReference(input: ReferenceOccurrenceInput): ReferenceOccurrenceResult {
    const sourceRange = sourceRangeFromSyntaxNode(input.targetNode);
    const occurrenceId = createReferenceOccurrenceId({
      filePath: input.uri.fsPath,
      kind: input.kind,
      refText: input.targetNode.text,
      startByte: sourceRange.startByte,
      endByte: sourceRange.endByte,
      line: input.targetNode.startPosition.row,
      character: input.targetNode.startPosition.column,
    });

    const node: GraphNodeModel = {
      id: occurrenceId,
      label: input.targetNode.text,
      type: "Reference",
      filePath: input.uri.fsPath,
      lineNumber: sourceRange.startLine,
      sourceRange,
      properties: {
        referenceKind: input.kind,
        refText: input.targetNode.text,
        enclosingScopeId: input.enclosingScopeId,
        astType: input.astType ?? input.astNode.type,
      },
    };

    return {
      occurrenceId,
      sourceRange,
      request: {
        sourceNodeId: input.enclosingScopeId,
        occurrenceNodeId: occurrenceId,
        sourceUri: input.uri.toString(),
        refLine: input.targetNode.startPosition.row,
        refCharacter: input.targetNode.startPosition.column,
        refText: input.targetNode.text,
        kind: input.kind,
        sourceRange,
      },
      nodes: [node],
      edges: [
        {
          id: `edge_has_occurrence_${input.fileNodeId}__${occurrenceId}`,
          source: input.fileNodeId,
          target: occurrenceId,
          relationshipType: "HAS_OCCURRENCE",
        },
        {
          id: `edge_refers_to_${input.enclosingScopeId}__${occurrenceId}`,
          source: input.enclosingScopeId,
          target: occurrenceId,
          relationshipType: "REFERS_TO",
          sourceRange,
        },
      ],
    };
  }

  private isDeclarationOnly(astNode: SyntaxNode): boolean {
    if (["function_signature", "method_signature"].includes(astNode.type)) {
      return true;
    }
    if (["interface_declaration", "trait_item"].includes(astNode.type)) {
      return true;
    }
    if (astNode.type === "method_declaration") {
      return !this.hasImplementationBody(astNode);
    }
    return false;
  }

  private hasImplementationBody(astNode: SyntaxNode): boolean {
    return astNode.namedChildren.some((child) =>
      [
        "block",
        "statement_block",
        "compound_statement",
        "declaration_list",
      ].includes(child.type),
    );
  }
}
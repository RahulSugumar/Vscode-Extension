import * as vscode from "vscode";
import { createHash } from "crypto";
import { SyntaxNode } from "web-tree-sitter";
import { TreeSitterManager } from "./TreeSitterManager";
import { NameDeriver } from "./NameDeriver";
import { OccurrenceBuilder } from "./OccurrenceBuilder";
import { CallSiteBuildResult, CallSiteBuilder } from "./CallSiteBuilder";
import { FlowAnalyzer } from "./flow/FlowAnalyzer";
import { extractRichCodeNodes } from "./extractors";
import {
  GraphNodeModel,
  GraphEdgeModel,
  ResolutionRequest,
} from "../models/Graph";
import { LedgerEntrySymbol } from "../models/GraphLedger";

export interface FileAnalysisResult {
  nodes: GraphNodeModel[];
  edges: GraphEdgeModel[];
  resolutionRequests: ResolutionRequest[];
  /**
   * Symbols this file declares for ledger / cross-file impact tracking.
   * Empty for files that do not contribute Class/Method/Function/Interface nodes.
   */
  exportedSymbols: LedgerEntrySymbol[];
}

export class CodeAnalyzer {
  private nameDeriver = new NameDeriver();
  private occurrenceBuilder = new OccurrenceBuilder();
  private callSiteBuilder = new CallSiteBuilder();
  private flowAnalyzer = new FlowAnalyzer();

  constructor(private treeSitter: TreeSitterManager) {}

  public async analyzeFile(uri: vscode.Uri): Promise<FileAnalysisResult> {
    const parser = await this.treeSitter.getParser(uri.fsPath);
    if (!parser) {
      return {
        nodes: [],
        edges: [],
        resolutionRequests: [],
        exportedSymbols: [],
      };
    }

    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString("utf8");
    const tree = parser.parse(text);

    const nodes: GraphNodeModel[] = [];
    const edges: GraphEdgeModel[] = [];
    const includeFlow = this.shouldAnalyzeFlow();
    const resolutionRequests: ResolutionRequest[] = [];
    const exportedSymbols: LedgerEntrySymbol[] = [];

    const fileNodeId = uri.fsPath;
    this.pushNode(nodes, {
      id: fileNodeId,
      label: uri.path.split("/").pop() || uri.fsPath,
      type: "File",
      filePath: uri.fsPath,
    });

    this.traverse(
      tree.rootNode,
      fileNodeId,
      fileNodeId,
      fileNodeId,
      uri,
      nodes,
      edges,
      resolutionRequests,
      exportedSymbols,
      [],
      includeFlow,
    );

    return { nodes, edges, resolutionRequests, exportedSymbols };
  }

  private traverse(
    astNode: SyntaxNode,
    parentId: string,
    enclosingScopeId: string,
    fileNodeId: string,
    uri: vscode.Uri,
    nodes: GraphNodeModel[],
    edges: GraphEdgeModel[],
    resolutionRequests: ResolutionRequest[],
    exportedSymbols: LedgerEntrySymbol[],
    scopePath: string[],
    includeFlow: boolean,
  ): void {
    let currentScopeId = enclosingScopeId;
    let childScopePath = scopePath;
    const kind = this.classify(astNode);

    if (kind) {
      const { name, isAnonymous, origin } = this.nameDeriver.derive(astNode);
      const nodeId = `${uri.fsPath}:${astNode.startPosition.row}:${astNode.startPosition.column}:${name}`;
      const occurrence = this.occurrenceBuilder.buildDefinition({
        astNode,
        uri,
        name,
        kind,
        legacyNodeId: nodeId,
        fileNodeId,
        scopePath,
        isAnonymous,
        nameOrigin: origin,
      });

      this.pushNode(nodes, {
        id: nodeId,
        label: name,
        type: kind,
        filePath: uri.fsPath,
        lineNumber: astNode.startPosition.row + 1,
        sourceRange: occurrence.sourceRange,
        properties: {
          isAnonymous,
          nameOrigin: origin,
          astType: astNode.type,
          symbolId: occurrence.symbolId,
          definitionOccurrenceId: occurrence.occurrenceId,
          qualifiedName: occurrence.qualifiedName,
        },
      });

      this.pushEdge(edges, {
        id: `edge_contains_${parentId}__${nodeId}`,
        source: parentId,
        target: nodeId,
        relationshipType: "CONTAINS",
      });
      this.pushNodes(nodes, occurrence.nodes);
      this.pushEdges(edges, occurrence.edges);

      if (!isAnonymous) {
        exportedSymbols.push({
          name,
          nodeId,
          symbolId: occurrence.symbolId,
          definitionOccurrenceId: occurrence.occurrenceId,
          kind,
          signatureHash: this.computeSignatureHash(astNode),
          isExported: this.detectIsExported(astNode, uri.fsPath),
          lineNumber: astNode.startPosition.row + 1,
          sourceRange: occurrence.sourceRange,
        });
      }

      currentScopeId = nodeId;
      childScopePath = [...scopePath, name];

      if (kind === "Class" || kind === "Interface") {
        this.collectInheritanceRequests(
          astNode,
          nodeId,
          fileNodeId,
          uri,
          nodes,
          edges,
          resolutionRequests,
        );
      }
    }

    extractRichCodeNodes({
      astNode,
      uri,
      fileNodeId,
      enclosingScopeId,
      currentScopeId,
      scopePath: childScopePath,
      nodes,
      edges,
    });

    if (includeFlow && (kind === "Function" || kind === "Method")) {
      this.flowAnalyzer.analyzeFunction({
        astNode,
        uri,
        fileNodeId,
        ownerId: currentScopeId,
        nodes,
        edges,
      });
    }

    this.collectReferences(
      astNode,
      currentScopeId,
      fileNodeId,
      uri,
      nodes,
      edges,
      resolutionRequests,
    );

    for (const child of astNode.namedChildren) {
      this.traverse(
        child,
        parentId === enclosingScopeId ? currentScopeId : parentId,
        currentScopeId,
        fileNodeId,
        uri,
        nodes,
        edges,
        resolutionRequests,
        exportedSymbols,
        childScopePath,
        includeFlow,
      );
    }
  }

  private shouldAnalyzeFlow(): boolean {
    const depth = vscode.workspace
      .getConfiguration("selfEvolvingAgent")
      .get<string>("graph.analysisDepth", "framework");
    return depth === "flow" || depth === "security";
  }
  private classify(
    astNode: SyntaxNode,
  ): "Class" | "Method" | "Function" | "Interface" | null {
    switch (astNode.type) {
      case "class_definition":
      case "class_declaration":
      case "class_expression":
      case "class_specifier":
      case "struct_specifier":
      case "struct_item":
      case "enum_specifier":
      case "enum_item":
        return "Class";

      case "interface_declaration":
      case "trait_item":
        return "Interface";

      case "method_definition":
      case "method_declaration":
      case "method_signature":
      case "function_signature":
      case "constructor_declaration":
        return "Method";

      case "function_definition":
      case "function_declaration":
      case "function_item":
      case "function_expression":
      case "arrow_function":
      case "generator_function":
      case "generator_function_declaration":
        return "Function";

      default:
        return null;
    }
  }

  private computeSignatureHash(astNode: SyntaxNode): string {
    const parts: string[] = [astNode.type];

    const params =
      astNode.childForFieldName("parameters") ??
      astNode.namedChildren.find(
        (c) =>
          c.type === "formal_parameters" ||
          c.type === "parameters" ||
          c.type === "parameter_list",
      );

    if (params) {
      const paramItems = params.namedChildren.filter(
        (c) => c.type !== "comment",
      );
      parts.push(`p${paramItems.length}`);
      for (const p of paramItems) {
        parts.push(p.text.replace(/\s+/g, " ").trim());
      }
    } else {
      parts.push("p0");
    }

    const returnType =
      astNode.childForFieldName("return_type") ??
      astNode.childForFieldName("type");
    if (returnType?.text) {
      parts.push(`ret:${returnType.text.replace(/\s+/g, " ").trim()}`);
    }

    const modifierKeywords = [
      "async",
      "static",
      "public",
      "private",
      "protected",
      "pub",
    ];
    for (const child of astNode.children) {
      if (modifierKeywords.includes(child.type)) {
        parts.push(`mod:${child.type}`);
      }
    }
    const modifiersNode = astNode.namedChildren.find(
      (c) => c.type === "modifiers",
    );
    if (modifiersNode) {
      parts.push(`mods:${modifiersNode.text.replace(/\s+/g, " ").trim()}`);
    }

    return createHash("sha1")
      .update(parts.join("|"))
      .digest("hex")
      .slice(0, 12);
  }

  private detectIsExported(astNode: SyntaxNode, filePath: string): boolean {
    const ext = filePath.toLowerCase().slice(filePath.lastIndexOf("."));

    if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
      let cur: SyntaxNode | null = astNode.parent;
      let depth = 0;
      while (cur && depth < 4) {
        if (
          cur.type === "export_statement" ||
          cur.type === "export_default_declaration" ||
          cur.type === "export_specifier"
        ) {
          return true;
        }
        cur = cur.parent;
        depth++;
      }
      const parent = astNode.parent;
      if (parent) {
        for (const sib of parent.children) {
          if (sib.type === "export" && sib.startIndex < astNode.startIndex) {
            return true;
          }
        }
      }
      return false;
    }

    if (ext === ".py") {
      const isTopLevel = astNode.parent?.type === "module";
      if (!isTopLevel) return false;
      const nameNode = astNode.childForFieldName("name");
      if (!nameNode) return true;
      return !nameNode.text.startsWith("_");
    }

    if (
      [
        ".java",
        ".cs",
        ".c",
        ".h",
        ".cpp",
        ".cc",
        ".cxx",
        ".hpp",
        ".hh",
        ".hxx",
      ].includes(ext)
    ) {
      const modifiers = astNode.namedChildren.find(
        (c) => c.type === "modifiers",
      );
      if (modifiers && /\bpublic\b/.test(modifiers.text)) return true;
      for (const child of astNode.children) {
        if (child.type === "public") return true;
      }
      if ([".h", ".hpp", ".hh", ".hxx"].includes(ext)) return true;
      return false;
    }

    if (ext === ".rs") {
      const vis = astNode.namedChildren.find(
        (c) => c.type === "visibility_modifier",
      );
      return Boolean(vis);
    }

    if (ext === ".go") {
      const nameNode = astNode.childForFieldName("name");
      if (!nameNode) return true;
      const firstChar = nameNode.text.charAt(0);
      return firstChar === firstChar.toUpperCase() && /[A-Z]/.test(firstChar);
    }

    return true;
  }

  private collectReferences(
    astNode: SyntaxNode,
    enclosingScopeId: string,
    fileNodeId: string,
    uri: vscode.Uri,
    nodes: GraphNodeModel[],
    edges: GraphEdgeModel[],
    requests: ResolutionRequest[],
  ): void {
    if (
      astNode.type === "call_expression" ||
      astNode.type === "call" ||
      astNode.type === "method_invocation" ||
      astNode.type === "invocation_expression" ||
      astNode.type === "macro_invocation"
    ) {
      const fn =
        astNode.childForFieldName("function") ??
        astNode.childForFieldName("macro") ??
        astNode.childForFieldName("name") ??
        astNode.namedChildren.find((c) => this.isReferenceIdentifier(c));
      if (fn) {
        const target = this.callTargetNode(fn);
        const callSite = this.callSiteBuilder.build({
          astNode,
          calleeNode: fn,
          targetNode: target,
          uri,
          fileNodeId,
          enclosingScopeId,
          kind: "call",
        });
        this.pushNodes(nodes, callSite.nodes);
        this.pushEdges(edges, callSite.edges);
        this.pushReference(
          astNode,
          target,
          enclosingScopeId,
          fileNodeId,
          uri,
          "call",
          nodes,
          edges,
          requests,
          0,
          callSite,
        );
      }
    }

    if (
      astNode.type === "new_expression" ||
      astNode.type === "object_creation_expression"
    ) {
      const ctor =
        astNode.childForFieldName("constructor") ??
        astNode.childForFieldName("type") ??
        astNode.namedChildren.find(
          (c) =>
            this.isReferenceIdentifier(c) || c.type === "member_expression",
        );
      if (ctor) {
        const target = this.callTargetNode(ctor);
        const callSite = this.callSiteBuilder.build({
          astNode,
          calleeNode: ctor,
          targetNode: target,
          uri,
          fileNodeId,
          enclosingScopeId,
          kind: "new",
        });
        this.pushNodes(nodes, callSite.nodes);
        this.pushEdges(edges, callSite.edges);
        this.pushReference(
          astNode,
          target,
          enclosingScopeId,
          fileNodeId,
          uri,
          "new",
          nodes,
          edges,
          requests,
          0,
          callSite,
        );
      }
    }

    if (
      astNode.type === "import_statement" ||
      astNode.type === "import_declaration" ||
      astNode.type === "using_directive" ||
      astNode.type === "use_declaration" ||
      astNode.type === "preproc_include"
    ) {
      const source = astNode.childForFieldName("source");
      if (source) {
        this.pushReference(
          astNode,
          source,
          enclosingScopeId,
          fileNodeId,
          uri,
          "import",
          nodes,
          edges,
          requests,
          1,
        );
      }

      const names = astNode.namedChildren.filter(
        (c) =>
          c.type === "dotted_name" ||
          c.type === "aliased_import" ||
          c.type === "scoped_identifier" ||
          c.type === "qualified_name" ||
          c.type === "identifier" ||
          c.type === "string_literal" ||
          c.type === "system_lib_string" ||
          c.type === "raw_string_literal",
      );
      for (const name of names) {
        this.pushReference(
          astNode,
          name,
          enclosingScopeId,
          fileNodeId,
          uri,
          "import",
          nodes,
          edges,
          requests,
        );
      }
    }

    if (astNode.type === "import_from_statement") {
      const module =
        astNode.childForFieldName("module_name") ??
        astNode.namedChildren.find((c) => c.type === "dotted_name");
      if (module) {
        this.pushReference(
          astNode,
          module,
          enclosingScopeId,
          fileNodeId,
          uri,
          "import",
          nodes,
          edges,
          requests,
        );
      }
    }
  }

  private collectInheritanceRequests(
    classNode: SyntaxNode,
    sourceNodeId: string,
    fileNodeId: string,
    uri: vscode.Uri,
    nodes: GraphNodeModel[],
    edges: GraphEdgeModel[],
    requests: ResolutionRequest[],
  ): void {
    const heritage = classNode.namedChildren.find(
      (c) => c.type === "class_heritage",
    );
    if (heritage) {
      for (const clause of heritage.namedChildren) {
        const isExtends = clause.type === "extends_clause";
        const isImplements = clause.type === "implements_clause";
        if (!isExtends && !isImplements) continue;

        const idents = clause
          .descendantsOfType("identifier")
          .concat(clause.descendantsOfType("type_identifier"));
        for (const id of idents) {
          this.pushReference(
            clause,
            id,
            sourceNodeId,
            fileNodeId,
            uri,
            isExtends ? "extends" : "implements",
            nodes,
            edges,
            requests,
          );
        }
      }
    }

    for (const child of classNode.namedChildren) {
      const isExtends = [
        "superclass",
        "extends_clause",
        "base_class_clause",
        "base_list",
      ].includes(child.type);
      const isImplements = ["super_interfaces", "implements_clause"].includes(
        child.type,
      );
      if (!isExtends && !isImplements) continue;

      const idents = this.referenceDescendants(child);
      for (const id of idents) {
        this.pushReference(
          child,
          id,
          sourceNodeId,
          fileNodeId,
          uri,
          isImplements ? "implements" : "extends",
          nodes,
          edges,
          requests,
        );
      }
    }

    const argList = classNode.childForFieldName("superclasses");
    if (argList) {
      const idents = argList.descendantsOfType("identifier");
      for (const id of idents) {
        this.pushReference(
          argList,
          id,
          sourceNodeId,
          fileNodeId,
          uri,
          "extends",
          nodes,
          edges,
          requests,
        );
      }
    }
  }

  private pushReference(
    astNode: SyntaxNode,
    targetNode: SyntaxNode,
    enclosingScopeId: string,
    fileNodeId: string,
    uri: vscode.Uri,
    kind: ResolutionRequest["kind"],
    nodes: GraphNodeModel[],
    edges: GraphEdgeModel[],
    requests: ResolutionRequest[],
    refCharacterOffset = 0,
    callSite?: CallSiteBuildResult,
  ): void {
    const occurrence = this.occurrenceBuilder.buildReference({
      astNode,
      targetNode,
      uri,
      fileNodeId,
      enclosingScopeId,
      kind,
    });
    occurrence.request.refCharacter += refCharacterOffset;
    if (callSite) {
      occurrence.request.callSiteNodeId = callSite.callSiteNodeId;
      occurrence.request.argumentNodeIds = callSite.argumentNodeIds;
      occurrence.request.receiverNodeId = callSite.receiverNodeId;
      occurrence.request.returnValueNodeId = callSite.returnValueNodeId;
      for (const node of occurrence.nodes) {
        if (node.id === occurrence.occurrenceId) {
          node.properties = {
            ...(node.properties ?? {}),
            callSiteNodeId: callSite.callSiteNodeId,
          };
        }
      }
    }
    this.pushNodes(nodes, occurrence.nodes);
    this.pushEdges(edges, occurrence.edges);
    requests.push(occurrence.request);
  }

  private callTargetNode(astNode: SyntaxNode): SyntaxNode {
    if (
      [
        "member_expression",
        "member_access_expression",
        "attribute",
        "field_expression",
        "selector_expression",
        "scoped_identifier",
        "qualified_name",
      ].includes(astNode.type)
    ) {
      const fieldTarget =
        astNode.childForFieldName("property") ??
        astNode.childForFieldName("attribute") ??
        astNode.childForFieldName("field") ??
        astNode.childForFieldName("name");
      if (fieldTarget) return fieldTarget;

      const references = this.referenceDescendants(astNode).sort(
        (a, b) => b.startIndex - a.startIndex,
      );
      if (references[0]) return references[0];
    }

    return astNode;
  }

  private referenceDescendants(astNode: SyntaxNode): SyntaxNode[] {
    return [
      ...astNode.descendantsOfType("identifier"),
      ...astNode.descendantsOfType("type_identifier"),
      ...astNode.descendantsOfType("scoped_identifier"),
      ...astNode.descendantsOfType("qualified_name"),
      ...astNode.descendantsOfType("field_identifier"),
      ...astNode.descendantsOfType("property_identifier"),
    ];
  }

  private isReferenceIdentifier(astNode: SyntaxNode): boolean {
    return [
      "identifier",
      "type_identifier",
      "scoped_identifier",
      "qualified_name",
      "field_identifier",
      "property_identifier",
    ].includes(astNode.type);
  }

  private pushNodes(nodes: GraphNodeModel[], additions: GraphNodeModel[]): void {
    for (const node of additions) this.pushNode(nodes, node);
  }

  private pushNode(nodes: GraphNodeModel[], node: GraphNodeModel): void {
    if (nodes.some((existing) => existing.id === node.id)) return;
    nodes.push(node);
  }

  private pushEdges(edges: GraphEdgeModel[], additions: GraphEdgeModel[]): void {
    for (const edge of additions) this.pushEdge(edges, edge);
  }

  private pushEdge(edges: GraphEdgeModel[], edge: GraphEdgeModel): void {
    if (edges.some((existing) => existing.id === edge.id)) return;
    edges.push(edge);
  }
}

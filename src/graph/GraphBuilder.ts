import * as vscode from "vscode";
import * as path from "path";

import {
  Graph,
  GraphNodeModel,
  createGraph,
  GraphEdgeModel,
  ResolutionRequest,
} from "../models/Graph";
import { LedgerEntrySymbol } from "../models/GraphLedger";
import { CodeAnalyzer } from "../parser/CodeAnalyzer";
import { RepositoryScanner } from "../scanner/RepositoryScanner";
import { LspResolver, ResolvedLocation } from "../parser/LspResolver";
import { createExternalSymbolId } from "../parser/SymbolId";
import {
  containsZeroBasedPosition,
  rangeSize,
} from "../parser/SourceRange";

/**
 * Result of a single-file scoped build. Used by the incremental updater
 * to compute a GraphDelta against the previous ledger entry.
 */
export interface SingleFileBuildResult {
  filePath: string;
  nodes: GraphNodeModel[];
  edges: GraphEdgeModel[];
  exportedSymbols: LedgerEntrySymbol[];
  /**
   * Absolute fsPaths of workspace files this file imports from
   * (populated only when LSP was warm; empty when it fell back to
   * structural-only). Used to keep the ledger's dependents graph up to date.
   */
  importedFiles: string[];
  /** True if the LSP was warm enough to produce semantic cross-file edges. */
  usedLsp: boolean;
}

export class GraphBuilder {
  private lspResolver = new LspResolver();

  constructor(
    private scanner: RepositoryScanner,
    private analyzer: CodeAnalyzer,
  ) {}

  public async buildStructuralGraph(
    folder: vscode.WorkspaceFolder,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
  ): Promise<{
    graph: Graph;
    requests: ResolutionRequest[];
    files: vscode.Uri[];
  }> {
    const graph: Graph = createGraph({
      workspaceRoot: folder.uri.fsPath,
      analysisDepth: this.configuredAnalysisDepth(),
    });
    const allRequests: ResolutionRequest[] = [];

    progress?.report({ message: "Scanning repository..." });
    const files = await this.scanner.scan(folder);

    if (files.length === 0) {
      return { graph, requests: [], files: [] };
    }

    progress?.report({
      message: `Found ${files.length} project file${files.length === 1 ? "" : "s"}.`,
    });

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      progress?.report({
        message: `Parsing ${i + 1}/${files.length}: ${path.basename(file.fsPath)}`,
      });
      const result = await this.analyzer.analyzeFile(file);
      graph.nodes.push(...result.nodes);
      graph.edges.push(...result.edges);
      allRequests.push(...result.resolutionRequests);
      progress?.report({
        message: `Scanned ${i + 1} of ${files.length} project files.`,
        increment: 100 / files.length,
      });
    }

    const folderNodeId = folder.uri.fsPath;
    graph.nodes.push({
      id: folderNodeId,
      label: folder.name,
      type: "Folder",
      filePath: folderNodeId,
    });
    for (const file of files) {
      graph.edges.push({
        id: `edge_contains_${folderNodeId}__${file.fsPath}`,
        source: folderNodeId,
        target: file.fsPath,
        relationshipType: "CONTAINS",
      });
    }

    return { graph, requests: allRequests, files };
  }

  public async buildSemanticGraph(
    graph: Graph,
    requests: ResolutionRequest[],
    files: vscode.Uri[],
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
  ): Promise<Graph> {
    const useLsp = vscode.workspace
      .getConfiguration("selfEvolvingAgent")
      .get<boolean>("graph.useLsp", true);

    if (useLsp && requests.length > 0 && files.length > 0) {
      await this.runLspPass(files, requests, graph, progress);
    } else {
      progress?.report({
        message: "Project connections are ready.",
        increment: 90,
      });
    }

    progress?.report({ message: "Finalizing the Project Graph..." });
    this.addOverrideEdges(graph.nodes, graph.edges, graph.edges);
    this.addFrameworkSummaryEdges(graph.nodes, graph.edges, graph.edges);
    graph.edges = this.dedupeEdges(graph.edges);
    graph.metadata = { ...graph.metadata, analysisDepth: this.configuredAnalysisDepth() };
    progress?.report({
      message: `Project Graph contains ${graph.nodes.length} nodes and ${graph.edges.length} relationships.`,
      increment: 10,
    });

    return graph;
  }

  public async buildForFile(
    fileUri: vscode.Uri,
    existingGraph: Graph,
  ): Promise<SingleFileBuildResult> {
    const filePath = fileUri.fsPath;

    const analysis = await this.analyzer.analyzeFile(fileUri);

    if (analysis.nodes.length === 0) {
      return {
        filePath,
        nodes: [],
        edges: [],
        exportedSymbols: [],
        importedFiles: [],
        usedLsp: false,
      };
    }

    const nodes = analysis.nodes;
    const edges = analysis.edges;
    const requests = analysis.resolutionRequests;

    const useLsp = vscode.workspace
      .getConfiguration("selfEvolvingAgent")
      .get<boolean>("graph.useLsp", true);

    let usedLsp = false;
    const importedFiles = new Set<string>();

    if (useLsp && requests.length > 0) {
      const warm = await this.lspResolver.isLanguageServerWarm(fileUri, 800);
      if (warm) {
        usedLsp = true;
        await this.runScopedLspPass(
          existingGraph,
          nodes,
          edges,
          requests,
          importedFiles,
        );
      }
    }

    const existingNodes = existingGraph.nodes.filter(
      (node) => !node.filePath || node.filePath !== filePath,
    );
    const changedNodeIds = new Set(nodes.map((node) => node.id));
    this.addOverrideEdges(
      [...existingNodes, ...nodes],
      [...existingGraph.edges, ...edges],
      edges,
      changedNodeIds,
    );
    this.addFrameworkSummaryEdges(
      [...existingNodes, ...nodes],
      [...existingGraph.edges, ...edges],
      edges,
      changedNodeIds,
    );

    return {
      filePath,
      nodes,
      edges: this.dedupeEdges(edges),
      exportedSymbols: analysis.exportedSymbols,
      importedFiles: Array.from(importedFiles),
      usedLsp,
    };
  }

  private configuredAnalysisDepth(): Graph["metadata"]["analysisDepth"] {
    return vscode.workspace
      .getConfiguration("selfEvolvingAgent")
      .get<Graph["metadata"]["analysisDepth"]>("graph.analysisDepth", "framework");
  }
  private async runScopedLspPass(
    existingGraph: Graph,
    newNodes: GraphNodeModel[],
    edges: GraphEdgeModel[],
    requests: ResolutionRequest[],
    importedFiles: Set<string>,
  ): Promise<void> {
    const thisFilePath = requests[0]
      ? vscode.Uri.parse(requests[0].sourceUri).fsPath
      : undefined;

    const indexNodes: GraphNodeModel[] = [];
    for (const node of existingGraph.nodes) {
      if (node.filePath && node.filePath === thisFilePath) continue;
      indexNodes.push(node);
    }
    indexNodes.push(...newNodes);

    const nodeIndex = this.buildNodeIndex(indexNodes);
    const nodeById = this.buildNodeMap(indexNodes);

    const resolutions = await this.lspResolver.resolveBatch(requests, () => {
      /* silent for incremental updates */
    });

    for (const [req, location] of resolutions) {
      if (!location) continue;
      this.applyResolvedReference({
        req,
        location,
        nodeIndex,
        nodeById,
        graphNodes: newNodes,
        edges,
        importedFiles,
        thisFilePath,
      });
    }
  }

  private async runLspPass(
    files: vscode.Uri[],
    requests: ResolutionRequest[],
    graph: Graph,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
  ): Promise<void> {
    progress?.report({ message: "Preparing project language support..." });
    const sampleFile = await this.findLspReadyFile(files, progress);

    if (!sampleFile) {
      progress?.report({
        message: "Continuing with the available project connections.",
        increment: 70,
      });
      return;
    }

    const nodeIndex = this.buildNodeIndex(graph.nodes);
    const nodeById = this.buildNodeMap(graph.nodes);

    progress?.report({
      message: `Finding ${requests.length} project connections...`,
    });

    const total = requests.length;
    let lastCompleted = 0;
    const resolutions = await this.lspResolver.resolveBatch(
      requests,
      (done) => {
        const newlyCompleted = Math.max(0, done - lastCompleted);
        lastCompleted = done;
        progress?.report({
          message: `Found ${done} of ${total} project connections.`,
          increment: (newlyCompleted / total) * 70,
        });
      },
    );

    let createdEdges = 0;
    let externalEdges = 0;

    for (const [req, location] of resolutions) {
      if (!location) continue;
      const before = graph.edges.length;
      const result = this.applyResolvedReference({
        req,
        location,
        nodeIndex,
        nodeById,
        graphNodes: graph.nodes,
        edges: graph.edges,
      });
      createdEdges += Math.max(0, graph.edges.length - before);
      if (result === "external") externalEdges++;
    }

    vscode.window.showInformationMessage(
      `LSP resolved ${createdEdges} code graph relationships ` +
        `(${externalEdges} external targets represented).`,
    );
  }

  private applyResolvedReference(args: {
    req: ResolutionRequest;
    location: ResolvedLocation;
    nodeIndex: Map<string, GraphNodeModel[]>;
    nodeById: Map<string, GraphNodeModel>;
    graphNodes: GraphNodeModel[];
    edges: GraphEdgeModel[];
    importedFiles?: Set<string>;
    thisFilePath?: string;
  }): "internal" | "external" {
    const {
      req,
      location,
      nodeIndex,
      nodeById,
      graphNodes,
      edges,
      importedFiles,
      thisFilePath,
    } = args;

    const targetNode = this.findCodeNodeAtLocation(nodeIndex, location);
    if (!targetNode) {
      const external = this.createExternalSymbol(req, location);
      this.pushNodeIfAbsent(graphNodes, external);
      nodeById.set(external.id, external);
      this.pushCoarseEdge(edges, req, external.id);
      this.pushOccurrenceResolutionEdges(edges, req, external.id, external.id);
      this.pushCallSiteResolutionEdges(edges, req, external.id, nodeById);
      return "external";
    }

    if (req.kind === "import") {
      const targetPath = vscode.Uri.parse(location.targetUri).fsPath;
      if (targetPath && targetPath !== thisFilePath) {
        importedFiles?.add(targetPath);
      }
    }

    const targetNodeId = targetNode.id;
    const targetSymbolId = this.symbolTargetFor(targetNode);
    const targetOccurrenceId =
      this.findDefinitionOccurrenceAtLocation(nodeIndex, location) ??
      targetSymbolId ??
      targetNodeId;

    this.pushOccurrenceResolutionEdges(
      edges,
      req,
      targetOccurrenceId,
      targetSymbolId ?? targetNodeId,
    );
    this.pushCallSiteResolutionEdges(edges, req, targetNodeId, nodeById);

    if (targetNodeId !== req.sourceNodeId) {
      this.pushCoarseEdge(edges, req, targetNodeId);
    }

    return "internal";
  }

  private pushCoarseEdge(
    edges: GraphEdgeModel[],
    req: ResolutionRequest,
    targetNodeId: string,
  ): void {
    this.pushEdgeIfAbsent(edges, {
      id: `edge_${this.edgeKind(req.kind)}_${req.sourceNodeId}__${targetNodeId}`,
      source: req.sourceNodeId,
      target: targetNodeId,
      relationshipType: this.edgeKind(req.kind),
      sourceRange: req.sourceRange,
      properties: { refText: req.refText, line: req.refLine + 1 },
    });
  }

  private pushOccurrenceResolutionEdges(
    edges: GraphEdgeModel[],
    req: ResolutionRequest,
    resolvedTargetId: string,
    callTargetId: string,
  ): void {
    if (!req.occurrenceNodeId) return;

    this.pushEdgeIfAbsent(edges, {
      id: `edge_resolves_to_${req.occurrenceNodeId}__${resolvedTargetId}`,
      source: req.occurrenceNodeId,
      target: resolvedTargetId,
      relationshipType: "RESOLVES_TO",
      sourceRange: req.sourceRange,
      properties: { refText: req.refText, referenceKind: req.kind },
    });

    if (req.kind === "call") {
      this.pushEdgeIfAbsent(edges, {
        id: `edge_ref_call_${req.occurrenceNodeId}__${callTargetId}`,
        source: req.occurrenceNodeId,
        target: callTargetId,
        relationshipType: "REF_CALL",
        sourceRange: req.sourceRange,
        properties: { refText: req.refText },
      });
    }
  }

  private pushCallSiteResolutionEdges(
    edges: GraphEdgeModel[],
    req: ResolutionRequest,
    targetNodeId: string,
    nodeById: Map<string, GraphNodeModel>,
  ): void {
    if (!req.callSiteNodeId) return;
    if (req.kind !== "call" && req.kind !== "new") return;

    this.pushEdgeIfAbsent(edges, {
      id: `edge_callsite_calls_${req.callSiteNodeId}__${targetNodeId}`,
      source: req.callSiteNodeId,
      target: targetNodeId,
      relationshipType: "CALLS",
      sourceRange: req.sourceRange,
      properties: {
        exact: true,
        refText: req.refText,
        referenceKind: req.kind,
        occurrenceNodeId: req.occurrenceNodeId,
      },
    });

    this.pushArgumentFlowEdges(edges, req, targetNodeId, nodeById);
  }

  private pushArgumentFlowEdges(
    edges: GraphEdgeModel[],
    req: ResolutionRequest,
    targetNodeId: string,
    nodeById: Map<string, GraphNodeModel>,
  ): void {
    const argumentNodeIds = req.argumentNodeIds ?? [];
    for (let index = 0; index < argumentNodeIds.length; index++) {
      const argumentNodeId = argumentNodeIds[index];
      const parameter = this.findParameterForTarget(nodeById, targetNodeId, index);
      if (!parameter) continue;
      const argumentNode = nodeById.get(argumentNodeId);

      this.pushEdgeIfAbsent(edges, {
        id: `edge_argument_flows_${argumentNodeId}__${parameter.id}`,
        source: argumentNodeId,
        target: parameter.id,
        relationshipType: "ARGUMENT_FLOWS_TO_PARAMETER",
        sourceRange: argumentNode?.sourceRange ?? req.sourceRange,
        properties: {
          index,
          callSiteNodeId: req.callSiteNodeId,
          targetNodeId,
        },
      });
    }
  }

  private findParameterForTarget(
    nodeById: Map<string, GraphNodeModel>,
    targetNodeId: string,
    index: number,
  ): GraphNodeModel | undefined {
    for (const node of nodeById.values()) {
      if (node.type !== "Parameter") continue;
      const props = node.properties;
      if (!props || typeof props !== "object") continue;
      if (props["ownerId"] !== targetNodeId) continue;
      const rawIndex = props["index"];
      const parameterIndex =
        typeof rawIndex === "number" ? rawIndex : Number(rawIndex);
      if (parameterIndex === index) return node;
    }
    return undefined;
  }
  private createExternalSymbol(
    req: ResolutionRequest,
    location: ResolvedLocation,
  ): GraphNodeModel {
    let filePath: string | undefined;
    try {
      const uri = vscode.Uri.parse(location.targetUri);
      if (uri.scheme === "file") filePath = uri.fsPath;
    } catch {
      filePath = undefined;
    }

    return {
      id: createExternalSymbolId({
        targetUri: location.targetUri,
        refText: req.refText,
        line: location.targetLine,
        character: location.targetCharacter,
      }),
      label: req.refText,
      type: "ExternalSymbol",
      filePath,
      lineNumber: location.targetLine + 1,
      sourceRange: location.targetRange,
      properties: {
        targetUri: location.targetUri,
        targetLine: location.targetLine + 1,
        targetCharacter: location.targetCharacter,
        referenceKind: req.kind,
        refText: req.refText,
      },
    };
  }

  private async findLspReadyFile(
    files: vscode.Uri[],
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
  ): Promise<vscode.Uri | null> {
    const preferredExtensions = [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".py",
      ".java",
      ".cs",
      ".cpp",
      ".cc",
      ".cxx",
      ".hpp",
      ".hh",
      ".hxx",
      ".c",
      ".h",
      ".rs",
      ".go",
    ];
    const orderedFiles = [...files].sort((a, b) => {
      const aRank = preferredExtensions.indexOf(
        path.extname(a.fsPath).toLowerCase(),
      );
      const bRank = preferredExtensions.indexOf(
        path.extname(b.fsPath).toLowerCase(),
      );
      return (
        (aRank === -1 ? preferredExtensions.length : aRank) -
        (bRank === -1 ? preferredExtensions.length : bRank)
      );
    });

    const candidates = orderedFiles.slice(0, 8);
    const deadline = Date.now() + 12000;
    const warmupProgressTotal = 20;
    let warmupProgressReported = 0;

    for (let i = 0; i < candidates.length; i++) {
      const file = candidates[i];
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      progress?.report({
        message: `Checking language support ${i + 1}/${candidates.length}: ${path.basename(file.fsPath)}`,
      });

      const ready = await this.lspResolver.waitForLanguageServer(
        file,
        Math.min(2000, remaining),
      );
      const checkIncrement = warmupProgressTotal / candidates.length;
      warmupProgressReported += checkIncrement;
      progress?.report({
        message: `Checked language support ${i + 1} of ${candidates.length}.`,
        increment: checkIncrement,
      });

      if (ready) {
        const remainingProgress =
          warmupProgressTotal - warmupProgressReported;
        if (remainingProgress > 0) {
          progress?.report({
            message: "Project language support is ready.",
            increment: remainingProgress,
          });
        }
        return file;
      }
    }

    const remainingProgress = warmupProgressTotal - warmupProgressReported;
    if (remainingProgress > 0) {
      progress?.report({
        message: "Language support check is complete.",
        increment: remainingProgress,
      });
    }

    return null;
  }

  private buildNodeIndex(
    nodes: GraphNodeModel[],
  ): Map<string, GraphNodeModel[]> {
    const idx = new Map<string, GraphNodeModel[]>();
    for (const node of nodes) {
      if (!node.filePath) continue;
      const key = node.filePath;
      if (!idx.has(key)) idx.set(key, []);
      idx.get(key)!.push(node);
    }
    for (const list of idx.values()) {
      list.sort((a, b) => (a.lineNumber ?? 0) - (b.lineNumber ?? 0));
    }
    return idx;
  }

  private buildNodeMap(nodes: GraphNodeModel[]): Map<string, GraphNodeModel> {
    return new Map(nodes.map((node) => [node.id, node]));
  }

  private findCodeNodeAtLocation(
    index: Map<string, GraphNodeModel[]>,
    loc: ResolvedLocation,
  ): GraphNodeModel | null {
    const targetPath = vscode.Uri.parse(loc.targetUri).fsPath;
    const candidates = index.get(targetPath);
    if (!candidates || candidates.length === 0) return null;

    const contained = candidates
      .filter(
        (node) =>
          this.isLegacyCodeNode(node) &&
          containsZeroBasedPosition(
            node.sourceRange,
            loc.targetLine,
            loc.targetCharacter,
          ),
      )
      .sort((a, b) => rangeSize(a.sourceRange) - rangeSize(b.sourceRange));
    if (contained[0]) return contained[0];

    const targetLine = loc.targetLine + 1;
    let bestFile: GraphNodeModel | null = null;
    let bestCode: GraphNodeModel | null = null;
    for (const node of candidates) {
      if (node.type === "File" && !bestFile) {
        bestFile = node;
        continue;
      }
      if (!this.isLegacyCodeNode(node)) continue;
      if (node.lineNumber !== undefined && node.lineNumber <= targetLine) {
        bestCode = node;
      } else if (
        node.lineNumber !== undefined &&
        node.lineNumber > targetLine
      ) {
        break;
      }
    }
    return bestCode ?? bestFile;
  }

  private findDefinitionOccurrenceAtLocation(
    index: Map<string, GraphNodeModel[]>,
    loc: ResolvedLocation,
  ): string | null {
    const targetPath = vscode.Uri.parse(loc.targetUri).fsPath;
    const candidates = index.get(targetPath);
    if (!candidates || candidates.length === 0) return null;

    const contained = candidates
      .filter(
        (node) =>
          (node.type === "Definition" || node.type === "Declaration") &&
          containsZeroBasedPosition(
            node.sourceRange,
            loc.targetLine,
            loc.targetCharacter,
          ),
      )
      .sort((a, b) => rangeSize(a.sourceRange) - rangeSize(b.sourceRange));
    if (contained[0]) return contained[0].id;

    const targetLine = loc.targetLine + 1;
    let best: GraphNodeModel | null = null;
    for (const node of candidates) {
      if (node.type !== "Definition" && node.type !== "Declaration") continue;
      if (node.lineNumber !== undefined && node.lineNumber <= targetLine) {
        best = node;
      } else if (
        node.lineNumber !== undefined &&
        node.lineNumber > targetLine
      ) {
        break;
      }
    }
    return best?.id ?? null;
  }

  private symbolTargetFor(node: GraphNodeModel): string | undefined {
    if (node.type === "Symbol" || node.type === "ExternalSymbol") return node.id;
    const props = node.properties;
    if (!props || typeof props !== "object") return undefined;
    const value = props["symbolId"];
    return typeof value === "string" ? value : undefined;
  }

  private isLegacyCodeNode(node: GraphNodeModel): boolean {
    return (
      node.type === "Class" ||
      node.type === "Method" ||
      node.type === "Function" ||
      node.type === "Interface"
    );
  }


  private addFrameworkSummaryEdges(
    allNodes: GraphNodeModel[],
    allEdges: GraphEdgeModel[],
    edgesToAdd: GraphEdgeModel[],
    sourceNodeIds?: Set<string>,
  ): void {
    const nodeById = this.buildNodeMap(allNodes);
    const rolesByOwner = this.buildFrameworkRoleIndex(allNodes);
    const routeTargets = new Map<string, GraphEdgeModel[]>();

    for (const edge of [...allEdges, ...edgesToAdd]) {
      if (edge.relationshipType !== "ROUTES_TO" && edge.relationshipType !== "HANDLES") continue;
      if (!routeTargets.has(edge.target)) routeTargets.set(edge.target, []);
      routeTargets.get(edge.target)!.push(edge);
    }

    for (const edge of [...allEdges, ...edgesToAdd]) {
      if (edge.relationshipType !== "CALLS") continue;
      const sourceOwner = this.frameworkOwnerId(edge.source, nodeById);
      const targetOwner = this.frameworkOwnerId(edge.target, nodeById);
      if (!sourceOwner || !targetOwner || sourceOwner === targetOwner) continue;
      if (sourceNodeIds && !sourceNodeIds.has(sourceOwner) && !sourceNodeIds.has(edge.source)) continue;

      const sourceRoles = rolesByOwner.get(sourceOwner) ?? new Set<string>();
      const targetRoles = rolesByOwner.get(targetOwner) ?? new Set<string>();

      if (sourceRoles.has("Controller") && this.hasAnyRole(targetRoles, ["Service", "AngularService"])) {
        this.pushFrameworkEdge(allEdges, edgesToAdd, {
          source: sourceOwner,
          target: targetOwner,
          relationshipType: "CALLS_SERVICE",
          sourceRange: edge.sourceRange,
          properties: {
            derivedFrom: edge.id,
            sourceRole: "Controller",
            targetRole: this.firstRole(targetRoles, ["Service", "AngularService"]),
          },
        });
      }

      if (this.hasAnyRole(sourceRoles, ["Controller", "Service", "AngularService"]) && this.hasAnyRole(targetRoles, ["Repository", "ORMModel", "DatabaseTable"])) {
        this.pushFrameworkEdge(allEdges, edgesToAdd, {
          source: sourceOwner,
          target: targetOwner,
          relationshipType: "QUERIES_TABLE",
          sourceRange: edge.sourceRange,
          properties: {
            derivedFrom: edge.id,
            sourceRole: this.firstRole(sourceRoles, ["Controller", "Service", "AngularService"]),
            targetRole: this.firstRole(targetRoles, ["Repository", "ORMModel", "DatabaseTable"]),
          },
        });
      }

      const routeEdges = routeTargets.get(sourceOwner) ?? [];
      for (const routeEdge of routeEdges) {
        this.pushFrameworkEdge(allEdges, edgesToAdd, {
          source: routeEdge.source,
          target: targetOwner,
          relationshipType: "AFFECTS",
          sourceRange: edge.sourceRange ?? routeEdge.sourceRange,
          properties: { derivedFrom: edge.id, viaHandlerId: sourceOwner },
        });
        this.pushFrameworkEdge(allEdges, edgesToAdd, {
          source: routeEdge.source,
          target: targetOwner,
          relationshipType: "IMPACT_PATH",
          sourceRange: edge.sourceRange ?? routeEdge.sourceRange,
          properties: { derivedFrom: edge.id, viaHandlerId: sourceOwner },
        });
      }
    }
  }

  private buildFrameworkRoleIndex(nodes: GraphNodeModel[]): Map<string, Set<string>> {
    const rolesByOwner = new Map<string, Set<string>>();
    for (const node of nodes) {
      const ownerId = this.frameworkRoleOwnerId(node);
      if (!ownerId) continue;
      if (!rolesByOwner.has(ownerId)) rolesByOwner.set(ownerId, new Set<string>());
      rolesByOwner.get(ownerId)!.add(String(node.type));
      const props = node.properties;
      if (props && typeof props === "object" && typeof props["frameworkRole"] === "string") {
        rolesByOwner.get(ownerId)!.add(String(props["frameworkRole"]));
      }
    }
    return rolesByOwner;
  }

  private frameworkRoleOwnerId(node: GraphNodeModel): string | undefined {
    const props = node.properties;
    if (!props || typeof props !== "object") return undefined;
    const ownerId = props["roleOwnerId"] ?? props["handlerId"];
    return typeof ownerId === "string" ? ownerId : undefined;
  }

  private frameworkOwnerId(
    nodeId: string,
    nodeById: Map<string, GraphNodeModel>,
  ): string | undefined {
    const node = nodeById.get(nodeId);
    if (!node) return undefined;
    const props = node.properties;
    if (props && typeof props === "object") {
      const ownerId = props["roleOwnerId"] ?? props["enclosingScopeId"] ?? props["handlerId"];
      if (typeof ownerId === "string") return ownerId;
    }
    return node.id;
  }

  private hasAnyRole(roles: Set<string>, candidates: readonly string[]): boolean {
    return candidates.some((candidate) => roles.has(candidate));
  }

  private firstRole(roles: Set<string>, candidates: readonly string[]): string | undefined {
    return candidates.find((candidate) => roles.has(candidate));
  }

  private pushFrameworkEdge(
    existingEdges: GraphEdgeModel[],
    edgesToAdd: GraphEdgeModel[],
    edge: Omit<GraphEdgeModel, "id">,
  ): void {
    this.pushEdgeIfAbsentAcross(existingEdges, edgesToAdd, {
      ...edge,
      id: `edge_${String(edge.relationshipType).toLowerCase()}_${edge.source}__${edge.target}`,
    });
  }

  private addOverrideEdges(
    allNodes: GraphNodeModel[],
    allEdges: GraphEdgeModel[],
    edgesToAdd: GraphEdgeModel[],
    sourceNodeIds?: Set<string>,
  ): void {
    const nodeById = this.buildNodeMap(allNodes);
    const parentByChild = new Map<string, string>();
    const inheritedTypes = new Map<string, Set<string>>();

    for (const edge of allEdges) {
      if (edge.relationshipType === "CONTAINS") {
        parentByChild.set(edge.target, edge.source);
      }
      if (edge.relationshipType === "EXTENDS" || edge.relationshipType === "IMPLEMENTS") {
        if (!inheritedTypes.has(edge.source)) inheritedTypes.set(edge.source, new Set());
        inheritedTypes.get(edge.source)!.add(edge.target);
      }
    }

    const methodsByOwner = new Map<string, GraphNodeModel[]>();
    for (const node of allNodes) {
      if (node.type !== "Method") continue;
      const ownerId = this.findOwningTypeId(node.id, parentByChild, nodeById);
      if (!ownerId) continue;
      if (!methodsByOwner.has(ownerId)) methodsByOwner.set(ownerId, []);
      methodsByOwner.get(ownerId)!.push(node);
    }

    for (const [ownerId, methods] of methodsByOwner) {
      const ancestors = this.collectInheritedTypes(ownerId, inheritedTypes);
      if (ancestors.length === 0) continue;

      for (const method of methods) {
        if (sourceNodeIds && !sourceNodeIds.has(method.id)) continue;
        for (const ancestorId of ancestors) {
          const baseMethods = methodsByOwner.get(ancestorId) ?? [];
          for (const baseMethod of baseMethods) {
            if (baseMethod.label !== method.label) continue;
            this.pushEdgeIfAbsentAcross(allEdges, edgesToAdd, {
              id: `edge_overrides_${method.id}__${baseMethod.id}`,
              source: method.id,
              target: baseMethod.id,
              relationshipType: "OVERRIDES",
              sourceRange: method.sourceRange,
              properties: { methodName: method.label, ownerId, ancestorId },
            });
          }
        }
      }
    }

    const overridesByBase = new Map<string, GraphNodeModel[]>();
    for (const edge of [...allEdges, ...edgesToAdd]) {
      if (edge.relationshipType !== "OVERRIDES") continue;
      const overrideMethod = nodeById.get(edge.source);
      if (!overrideMethod) continue;
      if (!overridesByBase.has(edge.target)) overridesByBase.set(edge.target, []);
      overridesByBase.get(edge.target)!.push(overrideMethod);
    }

    for (const edge of [...allEdges, ...edgesToAdd]) {
      if (edge.relationshipType !== "CALLS") continue;
      if (!this.isExactCallEdge(edge)) continue;
      if (sourceNodeIds && !sourceNodeIds.has(edge.source)) continue;
      const overrides = overridesByBase.get(edge.target) ?? [];
      for (const overrideMethod of overrides) {
        this.pushEdgeIfAbsentAcross(allEdges, edgesToAdd, {
          id: `edge_calls_override_${edge.source}__${overrideMethod.id}`,
          source: edge.source,
          target: overrideMethod.id,
          relationshipType: "CALLS_OVERRIDE",
          sourceRange: edge.sourceRange,
          properties: { baseTargetId: edge.target },
        });
      }
    }
  }

  private findOwningTypeId(
    nodeId: string,
    parentByChild: Map<string, string>,
    nodeById: Map<string, GraphNodeModel>,
  ): string | undefined {
    let current = parentByChild.get(nodeId);
    while (current) {
      const node = nodeById.get(current);
      if (node?.type === "Class" || node?.type === "Interface") return node.id;
      current = parentByChild.get(current);
    }
    return undefined;
  }

  private collectInheritedTypes(
    ownerId: string,
    inheritedTypes: Map<string, Set<string>>,
  ): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    const pending = Array.from(inheritedTypes.get(ownerId) ?? []);
    while (pending.length > 0) {
      const current = pending.shift();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      result.push(current);
      pending.push(...Array.from(inheritedTypes.get(current) ?? []));
    }
    return result;
  }

  private isExactCallEdge(edge: GraphEdgeModel): boolean {
    const props = edge.properties;
    return Boolean(props && typeof props === "object" && props["exact"] === true);
  }

  private pushEdgeIfAbsentAcross(
    existingEdges: GraphEdgeModel[],
    edgesToAdd: GraphEdgeModel[],
    edge: GraphEdgeModel,
  ): void {
    if (existingEdges.some((existing) => existing.id === edge.id)) return;
    if (edgesToAdd.some((existing) => existing.id === edge.id)) return;
    edgesToAdd.push(edge);
  }
  private edgeKind(
    kind: ResolutionRequest["kind"],
  ): GraphEdgeModel["relationshipType"] {
    switch (kind) {
      case "call":
        return "CALLS";
      case "import":
        return "IMPORTS_FROM";
      case "extends":
        return "EXTENDS";
      case "implements":
        return "IMPLEMENTS";
      case "new":
        return "INSTANTIATES";
    }
  }

  private pushNodeIfAbsent(nodes: GraphNodeModel[], node: GraphNodeModel): void {
    if (nodes.some((existing) => existing.id === node.id)) return;
    nodes.push(node);
  }

  private pushEdgeIfAbsent(edges: GraphEdgeModel[], edge: GraphEdgeModel): void {
    if (edges.some((existing) => existing.id === edge.id)) return;
    edges.push(edge);
  }

  private dedupeEdges(edges: GraphEdgeModel[]): GraphEdgeModel[] {
    const seen = new Set<string>();
    const out: GraphEdgeModel[] = [];
    for (const edge of edges) {
      const key = edge.id || `${edge.source}|${edge.target}|${edge.relationshipType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(edge);
    }
    return out;
  }
}

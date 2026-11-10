import * as vscode from "vscode";
import * as path from "path";
import {
  DEFAULT_GRAPH_ANALYZER_VERSION,
  GRAPH_SCHEMA_VERSION,
  Graph,
  normalizeGraph,
} from "../models/Graph";

export class JsonExporter {
  /**
   * Writes the graph to <workspace>/<fileName> silently (no save dialog).
   * Returns the URI of the written file.
   */
  public async exportSilently(
    graph: Graph,
    folder: vscode.WorkspaceFolder,
    fileName: string,
  ): Promise<vscode.Uri> {
    const target = vscode.Uri.file(path.join(folder.uri.fsPath, fileName));
    const exportGraph = this.prepareForExport(graph, folder);
    const json = JSON.stringify(exportGraph, null, 2);
    await vscode.workspace.fs.writeFile(target, Buffer.from(json, "utf8"));
    return target;
  }

  /**
   * Reads a previously-exported graph from disk. Returns undefined if missing.
   */
  public async tryLoad(
    folder: vscode.WorkspaceFolder,
    fileName: string,
  ): Promise<Graph | undefined> {
    const target = vscode.Uri.file(path.join(folder.uri.fsPath, fileName));
    try {
      const bytes = await vscode.workspace.fs.readFile(target);
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
      return normalizeGraph(parsed, { workspaceRoot: folder.uri.fsPath });
    } catch {
      return undefined;
    }
  }

  private prepareForExport(
    graph: Graph,
    folder: vscode.WorkspaceFolder,
  ): Graph {
    const normalized =
      normalizeGraph(graph, { workspaceRoot: folder.uri.fsPath }) ?? graph;

    return {
      ...normalized,
      schemaVersion: GRAPH_SCHEMA_VERSION,
      metadata: {
        analyzerVersion: DEFAULT_GRAPH_ANALYZER_VERSION,
        analysisDepth: "structural",
        ...normalized.metadata,
        workspaceRoot: folder.uri.fsPath,
        generatedAt: new Date().toISOString(),
      },
    };
  }
}
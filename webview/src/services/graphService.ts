import { request } from "./host";
import { GraphNode, GraphEdge } from "../types";

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export async function ensureBackendStarted(): Promise<void> {
  await request<{ command: "backend.ready"; requestId: string }>({
    command: "backend.ensureStarted",
  });
}

export async function getGraph(): Promise<GraphData> {
  const res = await request<{
    command: "graph.data";
    requestId: string;
    nodes: GraphNode[];
    edges: GraphEdge[];
  }>({ command: "graph.get" });
  return { nodes: res.nodes, edges: res.edges };
}

export async function regenerateGraph(): Promise<
  | { type: "data"; nodes: GraphNode[]; edges: GraphEdge[] }
  | { type: "lspCheckRequired"; missing: any[] }
  | { type: "lspCheckPassed" }
> {
  const res = await request<
    | {
        command: "graph.data";
        requestId: string;
        nodes: GraphNode[];
        edges: GraphEdge[];
      }
    | { command: "graph.lspCheckRequired"; requestId: string; missing: any[] }
    | { command: "graph.lspCheckPassed"; requestId: string }
  >({ command: "graph.regenerate" });

  if (res.command === "graph.data") {
    return { type: "data", nodes: res.nodes, edges: res.edges };
  } else if (res.command === "graph.lspCheckRequired") {
    return { type: "lspCheckRequired", missing: res.missing };
  } else {
    return { type: "lspCheckPassed" };
  }
}

export async function installLsp(missing: any[]): Promise<boolean> {
  const res = await request<{
    command: "lsp.installSuccess";
    requestId: string;
  }>({ command: "lsp.install", missing });
  return res.command === "lsp.installSuccess";
}

export async function proceedWithLsp(): Promise<GraphData> {
  const res = await request<{
    command: "graph.data";
    requestId: string;
    nodes: GraphNode[];
    edges: GraphEdge[];
  }>({ command: "graph.proceedWithLsp" });
  return { nodes: res.nodes, edges: res.edges };
}

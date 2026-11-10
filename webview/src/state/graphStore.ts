import { create } from "zustand";
import { GraphNode, GraphEdge } from "../types";
import {
  regenerateGraph,
  getGraph,
  installLsp,
  proceedWithLsp,
} from "../services/graphService";
import { request } from "../services/host";

export type Status =
  | "idle"
  | "hydrating"
  | "loading"
  | "error"
  | "backend_starting"
  | "structural_analysis"
  | "lsp_missing"
  | "lsp_detected"
  | "lsp_installing"
  | "lsp_installed"
  | "semantic_analysis"
  | "neo4j_export";

interface GraphState {
  status: Status;
  isGenerating: boolean;
  hasGraph: boolean;
  hasHydrated: boolean;
  error: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  missingLsp: any[];
  generateGraph: () => Promise<void>;
  installMissingLsp: () => Promise<void>;
  proceedWithSemanticAnalysis: () => Promise<void>;
  refreshGraph: () => Promise<void>;
  hydrate: () => Promise<void>;
  applyGraphData: (nodes: GraphNode[], edges: GraphEdge[]) => void;
}

/**
 * Distinguishes the host's "user cancelled" error code from real failures.
 * The host wraps errors as `[CODE] message` — see services/host.ts.
 */
function isSoftCancellation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.startsWith("[CANCELLED]");
}

export const useGraphStore = create<GraphState>((set, get) => ({
  status: "idle",
  isGenerating: false,
  hasGraph: false,
  hasHydrated: false,
  error: null,
  nodes: [],
  edges: [],
  missingLsp: [],

  applyGraphData: (nodes, edges) => {
    set({
      isGenerating: false,
      status: "idle",
      hasGraph: true,
      hasHydrated: true,
      error: null,
      nodes,
      edges,
    });
  },

  generateGraph: async () => {
    set({
      isGenerating: true,
      status: "structural_analysis",
      error: null,
      missingLsp: [],
    });
    try {
      const res = await regenerateGraph();
      if (res.type === "data") {
        set({
          isGenerating: false,
          status: "idle",
          hasGraph: true,
          nodes: res.nodes,
          edges: res.edges,
        });
      } else if (res.type === "lspCheckRequired") {
        set({ status: "lsp_installing", missingLsp: res.missing });
        const success = await installLsp(res.missing);
        if (!success) {
          set({
            isGenerating: false,
            status: "error",
            error: "Project support installation failed",
          });
          return;
        }

        set({ status: "semantic_analysis" });
        const { nodes, edges } = await proceedWithLsp();
        set({
          isGenerating: false,
          status: "idle",
          hasGraph: true,
          nodes,
          edges,
        });
      } else if (res.type === "lspCheckPassed") {
        set({ status: "semantic_analysis" });
        const { nodes, edges } = await proceedWithLsp();
        set({
          isGenerating: false,
          status: "idle",
          hasGraph: true,
          nodes,
          edges,
        });
      }
    } catch (e) {
      if (isSoftCancellation(e)) {
        set({ isGenerating: false, status: "idle", error: null });
        return;
      }
      set({
        isGenerating: false,
        status: "error",
        error: e instanceof Error ? e.message : "Failed to generate graph",
      });
    }
  },

  installMissingLsp: async () => {
    set({ status: "lsp_installing", error: null });
    try {
      const success = await installLsp(get().missingLsp);
      if (success) {
        set({ status: "lsp_installed" });
      } else {
        set({ status: "error", error: "Language server installation failed" });
      }
    } catch (e) {
      set({
        status: "error",
        error: e instanceof Error ? e.message : "Failed to install extensions",
      });
    }
  },

  proceedWithSemanticAnalysis: async () => {
    set({ status: "semantic_analysis", error: null });
    try {
      const { nodes, edges } = await proceedWithLsp();
      set({
        isGenerating: false,
        status: "idle",
        hasGraph: true,
        nodes,
        edges,
      });
    } catch (e) {
      set({
        isGenerating: false,
        status: "error",
        error: e instanceof Error ? e.message : "Semantic analysis failed",
      });
    }
  },

  refreshGraph: async () => {
    set({ status: "loading", error: null });
    try {
      const { nodes, edges } = await getGraph();
      set({ status: "idle", hasGraph: true, nodes, edges });
    } catch (e) {
      set({
        status: "error",
        error: e instanceof Error ? e.message : "Failed to load graph",
      });
    }
  },

  hydrate: async () => {
    if (get().hasHydrated || get().status === "hydrating") return;
    set({ status: "hydrating", error: null });
    try {
      const res = await request<{
        command: "state.hydrated";
        requestId: string;
        hasGraph: boolean;
      }>({ command: "state.hydrate" });
      if (res.hasGraph) {
        const { nodes, edges } = await getGraph();
        set({
          hasGraph: true,
          nodes,
          edges,
          status: "idle",
          hasHydrated: true,
        });
      } else {
        set({ status: "idle", hasHydrated: true });
      }
    } catch {
      set({ status: "idle", hasHydrated: true });
    }
  },
}));

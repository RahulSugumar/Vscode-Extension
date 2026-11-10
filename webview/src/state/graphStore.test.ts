import { beforeEach, describe, expect, it, vi } from "vitest";
import { graphEdge, graphNode } from "../test/fixtures";

const mocks = vi.hoisted(() => ({
  regenerateGraph: vi.fn(),
  getGraph: vi.fn(),
  installLsp: vi.fn(),
  proceedWithLsp: vi.fn(),
  request: vi.fn(),
}));

vi.mock("../services/graphService", () => ({
  regenerateGraph: mocks.regenerateGraph,
  getGraph: mocks.getGraph,
  installLsp: mocks.installLsp,
  proceedWithLsp: mocks.proceedWithLsp,
}));
vi.mock("../services/host", () => ({ request: mocks.request }));

import { useGraphStore } from "./graphStore";

const initialState = useGraphStore.getState();
const graphData = { nodes: [graphNode], edges: [graphEdge] };

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  useGraphStore.setState({
    ...initialState,
    status: "idle",
    isGenerating: false,
    hasGraph: false,
    hasHydrated: false,
    error: null,
    nodes: [],
    edges: [],
    missingLsp: [],
  });
});

describe("graphStore", () => {
  it("applies pushed graph data as a fully hydrated graph", () => {
    useGraphStore.setState({ status: "error", error: "old", isGenerating: true });
    useGraphStore.getState().applyGraphData(graphData.nodes, graphData.edges);
    expect(useGraphStore.getState()).toMatchObject({
      status: "idle",
      isGenerating: false,
      hasGraph: true,
      hasHydrated: true,
      error: null,
      ...graphData,
    });
  });

  it("creates a local graph without waiting for the backend", async () => {
    mocks.regenerateGraph.mockResolvedValue({ type: "data", ...graphData });

    await useGraphStore.getState().generateGraph();
    expect(mocks.regenerateGraph).toHaveBeenCalledOnce();
    expect(useGraphStore.getState()).toMatchObject({
      status: "idle",
      isGenerating: false,
      hasGraph: true,
      ...graphData,
    });
  });

  it("installs required language support and continues semantic analysis", async () => {
    const missing = [{ id: "typescript", displayName: "TypeScript" }];
    mocks.regenerateGraph.mockResolvedValue({ type: "lspCheckRequired", missing });
    mocks.installLsp.mockResolvedValue(true);
    mocks.proceedWithLsp.mockResolvedValue(graphData);

    await useGraphStore.getState().generateGraph();
    expect(mocks.installLsp).toHaveBeenCalledWith(missing);
    expect(mocks.proceedWithLsp).toHaveBeenCalledOnce();
    expect(useGraphStore.getState()).toMatchObject({
      status: "idle",
      hasGraph: true,
      missingLsp: missing,
      ...graphData,
    });
  });

  it("stops when automatic language support installation returns false", async () => {
    mocks.regenerateGraph.mockResolvedValue({
      type: "lspCheckRequired",
      missing: [{ id: "python" }],
    });
    mocks.installLsp.mockResolvedValue(false);

    await useGraphStore.getState().generateGraph();
    expect(useGraphStore.getState()).toMatchObject({
      isGenerating: false,
      status: "error",
      error: "Project support installation failed",
    });
    expect(mocks.proceedWithLsp).not.toHaveBeenCalled();
  });

  it("continues immediately after a passed language-support check", async () => {
    mocks.regenerateGraph.mockResolvedValue({ type: "lspCheckPassed" });
    mocks.proceedWithLsp.mockResolvedValue(graphData);
    await useGraphStore.getState().generateGraph();
    expect(useGraphStore.getState()).toMatchObject({ hasGraph: true, ...graphData });
  });

  it.each([
    [new Error("[CANCELLED] User stopped"), "idle", null],
    [new Error("generation broke"), "error", "generation broke"],
    ["bad", "error", "Failed to generate graph"],
  ])("handles generation failures and soft cancellation", async (failure, status, error) => {
    mocks.regenerateGraph.mockRejectedValue(failure);
    await useGraphStore.getState().generateGraph();
    expect(useGraphStore.getState()).toMatchObject({
      isGenerating: false,
      status,
      error,
    });
  });

  it("installs missing language support on demand", async () => {
    const missing = [{ id: "java" }];
    useGraphStore.setState({ missingLsp: missing });
    mocks.installLsp.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await useGraphStore.getState().installMissingLsp();
    expect(mocks.installLsp).toHaveBeenCalledWith(missing);
    expect(useGraphStore.getState().status).toBe("lsp_installed");

    await useGraphStore.getState().installMissingLsp();
    expect(useGraphStore.getState()).toMatchObject({
      status: "error",
      error: "Language server installation failed",
    });
  });

  it.each([
    [new Error("install broke"), "install broke"],
    ["bad", "Failed to install extensions"],
  ])("records installation exceptions", async (failure, error) => {
    mocks.installLsp.mockRejectedValue(failure);
    await useGraphStore.getState().installMissingLsp();
    expect(useGraphStore.getState()).toMatchObject({ status: "error", error });
  });

  it("proceeds with semantic analysis and stores its graph", async () => {
    useGraphStore.setState({ isGenerating: true });
    mocks.proceedWithLsp.mockResolvedValue(graphData);
    await useGraphStore.getState().proceedWithSemanticAnalysis();
    expect(useGraphStore.getState()).toMatchObject({
      status: "idle",
      isGenerating: false,
      hasGraph: true,
      ...graphData,
    });
  });

  it.each([
    [new Error("semantic broke"), "semantic broke"],
    [null, "Semantic analysis failed"],
  ])("records semantic failures", async (failure, error) => {
    mocks.proceedWithLsp.mockRejectedValue(failure);
    await useGraphStore.getState().proceedWithSemanticAnalysis();
    expect(useGraphStore.getState()).toMatchObject({ status: "error", error });
  });

  it("refreshes the graph and reports refresh failures", async () => {
    mocks.getGraph.mockResolvedValueOnce(graphData);
    await useGraphStore.getState().refreshGraph();
    expect(useGraphStore.getState()).toMatchObject({ status: "idle", hasGraph: true, ...graphData });

    mocks.getGraph.mockRejectedValueOnce("bad");
    await useGraphStore.getState().refreshGraph();
    expect(useGraphStore.getState()).toMatchObject({
      status: "error",
      error: "Failed to load graph",
    });
  });

  it("hydrates an existing graph", async () => {
    mocks.request.mockResolvedValue({ hasGraph: true });
    mocks.getGraph.mockResolvedValue(graphData);
    await useGraphStore.getState().hydrate();
    expect(mocks.request).toHaveBeenCalledWith({ command: "state.hydrate" });
    expect(useGraphStore.getState()).toMatchObject({
      hasHydrated: true,
      hasGraph: true,
      status: "idle",
      ...graphData,
    });
  });

  it("hydrates an empty graph and treats host failures as an empty state", async () => {
    mocks.request.mockResolvedValueOnce({ hasGraph: false });
    await useGraphStore.getState().hydrate();
    expect(useGraphStore.getState()).toMatchObject({ hasHydrated: true, hasGraph: false });

    useGraphStore.setState({ hasHydrated: false });
    mocks.request.mockRejectedValueOnce(new Error("host unavailable"));
    await useGraphStore.getState().hydrate();
    expect(useGraphStore.getState()).toMatchObject({ hasHydrated: true, status: "idle" });
  });

  it("does not hydrate twice or while hydration is active", async () => {
    useGraphStore.setState({ hasHydrated: true });
    await useGraphStore.getState().hydrate();
    useGraphStore.setState({ hasHydrated: false, status: "hydrating" });
    await useGraphStore.getState().hydrate();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});

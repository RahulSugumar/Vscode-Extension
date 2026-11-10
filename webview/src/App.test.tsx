import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configuredRuntime, graphEdge, graphNode } from "./test/fixtures";

const graphStoreMock = vi.hoisted(() => ({ useGraphStore: vi.fn() }));
const configStoreMock = vi.hoisted(() => ({ useConfigStore: vi.fn() }));
const hostMocks = vi.hoisted(() => ({
  onPush: vi.fn(),
  postRequest: vi.fn(),
  request: vi.fn(),
  handlers: new Map<string, (message: any) => void>(),
}));

vi.mock("./state/graphStore", () => graphStoreMock);
vi.mock("./state/configStore", () => configStoreMock);
vi.mock("./services/host", () => ({
  onPush: hostMocks.onPush,
  postRequest: hostMocks.postRequest,
  request: hostMocks.request,
}));
vi.mock("./pages/ChatPage", () => ({
  default: ({ disabled }: { disabled?: boolean }) => (
    <div data-testid="chat-page">Chat page {disabled ? "disabled" : "ready"}</div>
  ),
}));
vi.mock("./pages/SuggestionsPage", () => ({
  default: ({ disabled }: { disabled?: boolean }) => (
    <div data-testid="suggestions-page">
      Suggestions page {disabled ? "disabled" : "ready"}
    </div>
  ),
}));
vi.mock("./pages/SessionsPage", () => ({
  default: () => <div>Sessions page</div>,
}));
vi.mock("./pages/ConfigPage", () => ({
  default: ({
    mode,
    onSaved,
  }: {
    mode?: string;
    onSaved?: (details: { neo4jConfigChanged: boolean }) => void;
  }) =>
    mode === "settings" ? (
      <>
        <button onClick={() => onSaved?.({ neo4jConfigChanged: false })}>
          Save settings
        </button>
        <button onClick={() => onSaved?.({ neo4jConfigChanged: true })}>
          Save Neo4j settings
        </button>
      </>
    ) : (
      <button onClick={() => onSaved?.({ neo4jConfigChanged: false })}>
        Complete setup
      </button>
    ),
}));

import App from "./App";

const graphActions = {
  generateGraph: vi.fn(),
  applyGraphData: vi.fn(),
  hydrate: vi.fn(),
};
const configActions = {
  hydrateConfig: vi.fn(),
  startBackend: vi.fn(),
  markBackendReady: vi.fn(),
};
let graphState: any;
let configState: any;

beforeEach(() => {
  vi.useRealTimers();
  Object.values(graphActions).forEach((mock) => mock.mockReset());
  Object.values(configActions).forEach((mock) => mock.mockReset());
  hostMocks.onPush.mockReset();
  hostMocks.postRequest.mockReset();
  hostMocks.request.mockReset();
  hostMocks.handlers.clear();
  hostMocks.onPush.mockImplementation((command, handler) => {
    hostMocks.handlers.set(command, handler);
    return vi.fn();
  });
  hostMocks.request.mockResolvedValue({
    command: "ui.graphSidebarState",
    isCollapsed: false,
  });
  graphState = {
    isGenerating: false,
    hasGraph: true,
    hasHydrated: true,
    status: "idle",
    error: null,
    missingLsp: [],
    nodes: [graphNode],
    edges: [
      graphEdge,
      { id: "edge-2", source: "node-1", target: "node-3", label: "CUSTOM_EDGE" },
    ],
    ...graphActions,
  };
  configState = {
    status: "ready",
    config: configuredRuntime,
    hydrate: configActions.hydrateConfig,
    startBackend: configActions.startBackend,
    markBackendReady: configActions.markBackendReady,
  };
  graphStoreMock.useGraphStore.mockImplementation(() => graphState);
  configStoreMock.useConfigStore.mockImplementation(() => configState);
});

afterEach(() => {
  vi.useRealTimers();
});

async function completeSetup() {
  await userEvent.click(screen.getByRole("button", { name: "Complete setup" }));
}

function push(command: string, message: Record<string, unknown>) {
  const handler = hostMocks.handlers.get(command);
  expect(handler, `missing ${command} push handler`).toBeTypeOf("function");
  act(() => handler?.({ command, ...message }));
}

describe("App", () => {
  it("hydrates configuration, completes setup, and opens utility panels", async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(configActions.hydrateConfig).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Complete setup" })).toBeInTheDocument();

    await completeSetup();
    expect(screen.getByRole("heading", { name: "Graph" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByRole("dialog", { name: "History" })).toHaveTextContent("Sessions page");
    await user.click(screen.getAllByRole("button", { name: "Close panel" })[1]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toHaveTextContent("Save settings");
    const syncCountBeforeSave = hostMocks.postRequest.mock.calls.filter(
      ([message]) => message.command === "graph.syncForChat",
    ).length;
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      hostMocks.postRequest.mock.calls.filter(
        ([message]) => message.command === "graph.syncForChat",
      ),
    ).toHaveLength(syncCountBeforeSave);
  });

  it("navigates from host pushes among ask, graph, and improve", async () => {
    render(<App />);
    await completeSetup();
    push("ui.navigate", { target: "graph" });
    expect(screen.getByRole("heading", { name: "Graph" })).toBeInTheDocument();
    push("ui.navigate", { target: "improve" });
    expect(screen.getByTestId("suggestions-page")).toHaveTextContent("ready");
    push("ui.navigate", { target: "ask" });
    expect(screen.getByTestId("chat-page")).toBeInTheDocument();
  });

  it("renders graph counts, selection details, legend, and graph actions", async () => {
    const user = userEvent.setup();
    render(<App />);
    await completeSetup();
    push("ui.navigate", { target: "graph" });
    expect(screen.getByText("1 nodes, 2 relationships")).toBeInTheDocument();
    expect(screen.getByText("Select a node in the Project Graph panel to inspect its name, line, and location.")).toBeInTheDocument();
    expect(screen.getByText("Class").closest(".graph-legend-item")).toHaveTextContent("1");

    push("ui.graphSelectionChanged", {
      node: {
        id: "selected",
        type: "Method",
        filePath: "C:\\project\\src\\selected.ts",
        lineNumber: 42,
      },
    });
    expect(screen.getByText("selected.ts")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByTitle("C:\\project\\src\\selected.ts")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Scan Again" }));
    expect(graphActions.generateGraph).toHaveBeenCalledWith();
    await user.click(screen.getByRole("button", { name: "Open Graph" }));
    expect(hostMocks.postRequest).toHaveBeenCalledWith({ command: "ui.openGraphPanel" });
    await user.click(screen.getByRole("button", { name: "Show Details" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Hide Details" })).toBeInTheDocument());
    expect(hostMocks.request).toHaveBeenCalledWith({ command: "ui.toggleGraphSidebar" });
  });

  it("filters graph relationships, expands dependencies, and supports search/all/none", async () => {
    const user = userEvent.setup();
    render(<App />);
    await completeSetup();
    push("ui.navigate", { target: "graph" });

    const calls = screen.getByRole("button", { name: /Calls 1/ });
    await user.click(calls);
    expect(hostMocks.postRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: "ui.setGraphRelationshipFilters",
        enabledRelationships: expect.arrayContaining(["CONTAINS", "CALLS"]),
      }),
    );
    expect(screen.getByText("Other")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Custom Edge 1/ })).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Find graph filters" }), "custom");
    expect(screen.queryByRole("button", { name: /Calls 1/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "All" }));
    await user.click(screen.getByRole("button", { name: "None" }));

    push("ui.graphRelationshipFiltersChanged", {
      enabledRelationships: ["CONTAINS"],
      requestedRelationships: ["REF_CALL"],
    });
    expect(hostMocks.postRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabledRelationships: expect.arrayContaining([
          "REF_CALL",
          "HAS_OCCURRENCE",
          "REFERS_TO",
          "RESOLVES_TO",
          "DEFINES",
          "DECLARES",
        ]),
      }),
    );
  });

  it("applies graph data received as an uncorrelated push", async () => {
    render(<App />);
    await completeSetup();
    push("graph.data", { nodes: [{ ...graphNode, id: "new" }], edges: [] });
    expect(graphActions.applyGraphData).toHaveBeenCalledWith(
      [{ ...graphNode, id: "new" }],
      [],
    );
  });

  it("shows graph-creation progress, clamps its percentage, then hides completed progress", async () => {
    vi.useFakeTimers();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Complete setup" }));
    push("graph.progress", {
      phase: "structural_analysis",
      message: "Scanning project files",
      percent: 140,
    });
    expect(screen.getByRole("status")).toHaveTextContent("Creating Project Graph");
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByText("Scanning project files")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(900));
    expect(screen.queryByText("Scanning project files")).not.toBeInTheDocument();
  });

  it("starts graph-creation progress at zero before the first host update", async () => {
    graphState.isGenerating = true;
    graphState.hasGraph = false;
    graphState.status = "structural_analysis";
    graphState.nodes = [];
    graphState.edges = [];
    render(<App />);
    await completeSetup();

    expect(screen.getByRole("status")).toHaveTextContent(
      "Creating Project Graph",
    );
    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it("keeps a 100% stage visible until the host marks the whole operation complete", async () => {
    vi.useFakeTimers();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Complete setup" }));
    push("ui.navigate", { target: "ask" });
    push("graph.progress", {
      phase: "backend_starting",
      message: "Project Assistant is ready.",
      percent: 100,
      complete: false,
    });
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByText("Project Assistant is ready.")).toBeInTheDocument();

    push("graph.progress", {
      phase: "neo4j_export",
      message: "Project Graph upload to Neo4j is complete.",
      percent: 100,
      complete: true,
    });
    act(() => vi.advanceTimersByTime(900));
    expect(
      screen.queryByText("Project Graph upload to Neo4j is complete."),
    ).not.toBeInTheDocument();
  });

  it("hydrates a configured graph before showing the dashboard", async () => {
    configState.status = "configured";
    graphState.hasHydrated = false;
    graphState.hasGraph = false;
    graphState.nodes = [];
    graphState.edges = [];
    render(<App />);
    await completeSetup();
    expect(graphActions.hydrate).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("Loading Project Graph");
  });

  it("starts the backend only after a graph is ready", async () => {
    configState.status = "configured";
    graphState.hasGraph = false;
    graphState.nodes = [];
    graphState.edges = [];
    const view = render(<App />);
    await completeSetup();
    expect(configActions.startBackend).not.toHaveBeenCalled();

    graphState.hasGraph = true;
    graphState.nodes = [graphNode];
    view.rerender(<App />);
    expect(configActions.startBackend).toHaveBeenCalledOnce();
  });

  it("keeps Graph usable while backend loading blocks Ask and Improve", async () => {
    configState.status = "starting";
    render(<App />);
    await completeSetup();

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scan Again" })).toBeEnabled();

    push("ui.navigate", { target: "ask" });
    expect(screen.getByRole("status")).toHaveTextContent("Starting assistant");
    expect(screen.getByTestId("chat-page")).toHaveTextContent("disabled");

    push("ui.navigate", { target: "improve" });
    expect(screen.getByRole("status")).toHaveTextContent("Starting assistant");
    expect(screen.getByTestId("suggestions-page")).toHaveTextContent("disabled");

    push("ui.navigate", { target: "graph" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the loading modal in Ask while graph changes are patched to Neo4j", async () => {
    render(<App />);
    await completeSetup();
    push("ui.navigate", { target: "ask" });

    push("graph.progress", {
      phase: "incremental_sync",
      message: "Sending 3 node changes and 2 relationship changes to Neo4j...",
      percent: 72,
      complete: false,
    });

    expect(screen.getByRole("status")).toHaveTextContent(
      "Updating Project Graph",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Sending 3 node changes and 2 relationship changes to Neo4j",
    );
    expect(screen.getByTestId("chat-page")).toHaveTextContent("disabled");
  });

  it("syncs a ready graph only when chat configuration is complete", async () => {
    render(<App />);
    await completeSetup();
    expect(hostMocks.postRequest).toHaveBeenCalledWith({
      command: "graph.syncForChat",
    });
  });

  it("does not trigger a full Neo4j upload for incremental graph updates", async () => {
    const view = render(<App />);
    await completeSetup();
    const initialSyncCount = hostMocks.postRequest.mock.calls.filter(
      ([message]) => message.command === "graph.syncForChat",
    ).length;

    push("graph.data", {
      nodes: [graphNode, { ...graphNode, id: "incremental-node" }],
      edges: [],
    });
    graphState.nodes = [graphNode, { ...graphNode, id: "incremental-node" }];
    graphState.edges = [];
    view.rerender(<App />);

    await waitFor(() =>
      expect(screen.getByText("2 nodes, 0 relationships")).toBeInTheDocument(),
    );
    expect(
      hostMocks.postRequest.mock.calls.filter(
        ([message]) => message.command === "graph.syncForChat",
      ),
    ).toHaveLength(initialSyncCount);
  });

  it("resyncs the graph after Neo4j settings change", async () => {
    const user = userEvent.setup();
    render(<App />);
    await completeSetup();
    const initialSyncCount = hostMocks.postRequest.mock.calls.filter(
      ([message]) => message.command === "graph.syncForChat",
    ).length;

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Save Neo4j settings" }));

    await waitFor(() =>
      expect(
        hostMocks.postRequest.mock.calls.filter(
          ([message]) => message.command === "graph.syncForChat",
        ),
      ).toHaveLength(initialSyncCount + 1),
    );
  });

  it("blocks chat and directs users to settings when OpenAI is not configured", async () => {
    const user = userEvent.setup();
    configState.config = {
      ...configuredRuntime,
      isChatConfigured: false,
      chatMissing: ["OpenAI API key"],
      hasOpenAiApiKey: false,
    };
    render(<App />);
    await completeSetup();
    expect(hostMocks.postRequest).not.toHaveBeenCalledWith({
      command: "graph.syncForChat",
    });
    expect(screen.getByRole("heading", { name: "Graph" })).toBeInTheDocument();
    expect(screen.queryByTestId("chat-page")).not.toBeInTheDocument();
    push("ui.navigate", { target: "ask" });
    expect(screen.getByTestId("chat-page")).toHaveTextContent("disabled");
    expect(screen.getByRole("dialog", { name: "Chat setup required" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it("blocks Improve with the chat setup message and does not load suggestions", async () => {
    configState.config = {
      ...configuredRuntime,
      isChatConfigured: false,
      isNeo4jConfigured: false,
      chatMissing: ["Neo4j password", "OpenAI API key"],
      hasOpenAiApiKey: false,
      hasNeo4jPassword: false,
    };
    render(<App />);
    await completeSetup();
    push("ui.navigate", { target: "improve" });
    expect(screen.getByRole("dialog", { name: "Chat setup required" })).toBeInTheDocument();
    expect(screen.getByText(/Missing: Neo4j password, OpenAI API key/)).toBeInTheDocument();
    expect(screen.getByTestId("suggestions-page")).toHaveTextContent("disabled");
  });

  it("automatically generates the first graph before starting the backend", async () => {
    graphState.hasGraph = false;
    graphState.nodes = [];
    graphState.edges = [];
    render(<App />);
    await completeSetup();
    expect(graphActions.generateGraph).toHaveBeenCalledWith();
    expect(configActions.startBackend).not.toHaveBeenCalled();
  });

  it("opens settings when a configured graph has a configuration error", async () => {
    const view = render(<App />);
    await completeSetup();
    configState.status = "error";
    view.rerender(<App />);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it("keeps setup visible for missing or unconfigured runtime state", () => {
    configState.status = "missing";
    configState.config = { ...configuredRuntime, isConfigured: false };
    render(<App />);
    expect(screen.getByRole("button", { name: "Complete setup" })).toBeInTheDocument();
    expect(screen.queryByTestId("chat-page")).not.toBeInTheDocument();
  });
});

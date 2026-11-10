import React, {
  useCallback,
  useState,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { useGraphStore } from "./state/graphStore";
import { useConfigStore } from "./state/configStore";
import ChatPage from "./pages/ChatPage";
import ConfigPage from "./pages/ConfigPage";
import SuggestionsPage from "./pages/SuggestionsPage";
import SessionsPage from "./pages/SessionsPage";
import { Loader2, X } from "lucide-react";
import { onPush, postRequest, request } from "./services/host";
import type {
  GraphSelectionPayload,
  HostResponse,
  NavigationTarget,
} from "./types/messaging";
import "./App.css";

type TabId = "ask" | "graph" | "improve";
type UtilityId = "history" | "settings";
type GraphSidebarStateResponse = Extract<
  HostResponse,
  { command: "ui.graphSidebarState" }
>;
type GraphSelectionChangedResponse = Extract<
  HostResponse,
  { command: "ui.graphSelectionChanged" }
>;
type GraphRelationshipFiltersChangedResponse = Extract<
  HostResponse,
  { command: "ui.graphRelationshipFiltersChanged" }
>;
type NavigateResponse = Extract<HostResponse, { command: "ui.navigate" }>;
type GraphProgressResponse = Extract<
  HostResponse,
  { command: "graph.progress" }
>;
type GraphDataResponse = Extract<HostResponse, { command: "graph.data" }>;

type LoadingDetails = {
  title: string;
  message: string;
  phase: string;
  percent: number;
};

type RelationshipFilterItem = {
  id: string;
  label: string;
  relationships: string[];
  alwaysVisible?: boolean;
};

type RelationshipFilterGroup = {
  id: string;
  title: string;
  items: RelationshipFilterItem[];
};

const relationshipFilterGroups: RelationshipFilterGroup[] = [
  {
    id: "core",
    title: "Core",
    items: [
      { id: "CONTAINS", label: "Contains", relationships: ["CONTAINS"], alwaysVisible: true },
      { id: "DEEP_DEPENDENCIES", label: "Deep Links", relationships: ["DEEP_DEPENDENCIES"], alwaysVisible: true },
      { id: "CALLS", label: "Calls", relationships: ["CALLS"] },
      { id: "IMPORTS_FROM", label: "Imports", relationships: ["IMPORTS_FROM"] },
      { id: "EXTENDS", label: "Extends", relationships: ["EXTENDS"] },
      { id: "IMPLEMENTS", label: "Implements", relationships: ["IMPLEMENTS"] },
      { id: "INSTANTIATES", label: "Instantiates", relationships: ["INSTANTIATES"] },
    ],
  },
  {
    id: "symbols",
    title: "Symbols",
    items: [
      { id: "SYMBOL_DEFINITIONS", label: "Definitions", relationships: ["DEFINES", "DECLARES"] },
      { id: "SYMBOL_REFERENCES", label: "References", relationships: ["REFERS_TO", "RESOLVES_TO"] },
      { id: "REF_CALL", label: "Reference Calls", relationships: ["REF_CALL"] },
    ],
  },
  {
    id: "code",
    title: "Code Details",
    items: [
      { id: "CODE_MEMBERS", label: "Members", relationships: ["HAS_PARAM", "HAS_FIELD", "HAS_PROPERTY", "HAS_TYPE_PARAM"] },
      { id: "CODE_TYPES", label: "Types", relationships: ["TYPE_OF", "RETURNS"] },
      { id: "MODULE_IO", label: "Imports/Exports", relationships: ["IMPORTS", "EXPORTS", "REEXPORTS", "ALIASES"] },
      { id: "DOCS_DECORATORS", label: "Docs/Decorators", relationships: ["DOCUMENTS", "ANNOTATED_BY"] },
    ],
  },
  {
    id: "calls",
    title: "Calls",
    items: [
      { id: "CALL_DETAILS", label: "Call Details", relationships: ["CALL_SITE_OF", "HAS_ARGUMENT", "RECEIVER_OF"] },
      { id: "CALL_FLOWS", label: "Call Flows", relationships: ["ARGUMENT_FLOWS_TO_PARAMETER", "RETURN_FLOWS_TO_CALLER"] },
      { id: "OVERRIDE_FLOW", label: "Overrides", relationships: ["OVERRIDES", "CALLS_OVERRIDE"] },
    ],
  },
  {
    id: "framework",
    title: "Framework",
    items: [
      { id: "FRAMEWORK_ROUTES", label: "Routes/Handlers", relationships: ["ROUTES_TO", "HANDLES"] },
      { id: "FRAMEWORK_SERVICES", label: "Services/Models", relationships: ["CALLS_SERVICE", "USES_MODEL"] },
      { id: "FRAMEWORK_DATA", label: "Database", relationships: ["QUERIES_TABLE"] },
      { id: "FRAMEWORK_UI", label: "UI Components", relationships: ["RENDERS", "USES_HOOK", "UPDATES_STATE", "BINDS_TEMPLATE"] },
      { id: "FRAMEWORK_EVENTS", label: "Events", relationships: ["EMITS_EVENT", "SUBSCRIBES_TO"] },
      { id: "FRAMEWORK_DEPENDS", label: "Dependencies", relationships: ["DEPENDS_ON"] },
      { id: "FRAMEWORK_IMPACT", label: "Impact", relationships: ["AFFECTS", "IMPACT_PATH", "CHANGES_PUBLIC_API"] },
    ],
  },
  {
    id: "flow",
    title: "Flow",
    items: [
      { id: "FLOW_CONTROL", label: "Control Flow", relationships: ["CFG_NEXT", "BRANCH_TRUE", "BRANCH_FALSE", "LOOP_BACK", "EXCEPTION_FLOW", "RETURNS_TO", "CONTROL_DEPENDS_ON"] },
      { id: "FLOW_DATA", label: "Data Flow", relationships: ["READS", "WRITES", "ASSIGNS", "USES_VALUE", "DEFINES_VALUE", "REACHING_DEF", "FLOWS_TO"] },
      { id: "FLOW_CALLS", label: "Call Flow", relationships: ["PARAM_FLOWS_TO_ARG", "ARG_FLOWS_TO_PARAM", "RETURN_FLOWS_TO"] },
      { id: "FLOW_FIELDS", label: "Field Access", relationships: ["FIELD_READ", "FIELD_WRITE", "CAPTURES"] },
      { id: "FLOW_DOMINANCE", label: "Dominance", relationships: ["DOMINATES", "POST_DOMINATES"] },
    ],
  },
];

const relationshipFilterItems = relationshipFilterGroups.flatMap((group) => group.items);
const relationshipFilterItemById = new Map(
  relationshipFilterItems.map((item) => [item.id, item]),
);
const relationshipDependencies: Record<string, string[]> = {
  REF_CALL: [
    "HAS_OCCURRENCE",
    "REFERS_TO",
    "RESOLVES_TO",
    "DEFINES",
    "DECLARES",
  ],
  RESOLVES_TO: ["HAS_OCCURRENCE", "REFERS_TO", "DEFINES", "DECLARES"],
  REFERS_TO: ["HAS_OCCURRENCE"],
  DEFINES: ["HAS_OCCURRENCE"],
  DECLARES: ["HAS_OCCURRENCE"],
  TYPE_OF: ["HAS_PARAM", "HAS_FIELD", "HAS_PROPERTY", "HAS_TYPE_PARAM"],
  ALIASES: ["IMPORTS", "EXPORTS"],
  REEXPORTS: ["IMPORTS", "EXPORTS"],
  CALL_SITE_OF: ["CALLS"],
  HAS_ARGUMENT: ["CALL_SITE_OF"],
  ARGUMENT_FLOWS_TO_PARAMETER: ["CALL_SITE_OF", "HAS_ARGUMENT"],
  RECEIVER_OF: ["CALL_SITE_OF"],
  RETURN_FLOWS_TO_CALLER: ["CALL_SITE_OF"],
  OVERRIDES: ["EXTENDS", "IMPLEMENTS"],
  CALLS_OVERRIDE: ["CALL_SITE_OF", "CALLS", "OVERRIDES"],
  ROUTES_TO: ["CONTAINS"],
  HANDLES: ["ROUTES_TO"],
  CALLS_SERVICE: ["CALLS", "USED_BY"],
  QUERIES_TABLE: ["CALLS", "USED_BY"],
  USES_MODEL: ["USED_BY"],
  RENDERS: ["USED_BY"],
  USES_HOOK: ["CALL_SITE_OF"],
  UPDATES_STATE: ["USES_HOOK"],
  BINDS_TEMPLATE: ["USED_BY"],
  DEPENDS_ON: ["USED_BY"],
  AFFECTS: ["ROUTES_TO", "IMPACT_PATH"],
  IMPACT_PATH: ["ROUTES_TO", "CALLS"],
  CHANGES_PUBLIC_API: ["ROUTES_TO"],
  CFG_NEXT: [
    "CONTAINS",
    "BRANCH_TRUE",
    "BRANCH_FALSE",
    "LOOP_BACK",
    "EXCEPTION_FLOW",
    "CONTROL_DEPENDS_ON",
    "RETURNS_TO",
  ],
  BRANCH_TRUE: ["CFG_NEXT", "CONTROL_DEPENDS_ON"],
  BRANCH_FALSE: ["CFG_NEXT", "CONTROL_DEPENDS_ON"],
  LOOP_BACK: ["CFG_NEXT", "BRANCH_TRUE"],
  EXCEPTION_FLOW: ["CFG_NEXT"],
  RETURNS_TO: ["CFG_NEXT", "RETURN_FLOWS_TO"],
  CONTROL_DEPENDS_ON: ["CFG_NEXT"],
  READS: ["CFG_NEXT", "USES_VALUE"],
  WRITES: ["CFG_NEXT", "DEFINES_VALUE"],
  ASSIGNS: ["WRITES", "FLOWS_TO"],
  USES_VALUE: ["READS"],
  DEFINES_VALUE: ["WRITES"],
  REACHING_DEF: ["READS", "WRITES"],
  FLOWS_TO: ["READS", "WRITES"],
  PARAM_FLOWS_TO_ARG: ["CALL_SITE_OF", "HAS_ARGUMENT"],
  ARG_FLOWS_TO_PARAM: ["ARGUMENT_FLOWS_TO_PARAMETER"],
  RETURN_FLOWS_TO: ["CFG_NEXT"],
  FIELD_READ: ["READS"],
  FIELD_WRITE: ["WRITES"],
  CAPTURES: ["READS"],
};

function expandRelationshipFilters(relationships: Iterable<string>): Set<string> {
  const expanded = new Set<string>();
  const pending = Array.from(relationships);

  while (pending.length > 0) {
    const relationship = pending.shift();
    if (!relationship || expanded.has(relationship)) continue;
    expanded.add(relationship);
    relationshipDependencies[relationship]?.forEach((dependency) => {
      if (!expanded.has(dependency)) pending.push(dependency);
    });
  }

  return expanded;
}
function expandFilterIds(filterIds: Iterable<string>): Set<string> {
  const relationships = new Set<string>();
  Array.from(filterIds).forEach((filterId) => {
    const item = relationshipFilterItemById.get(filterId);
    if (item) {
      item.relationships.forEach((relationship) => relationships.add(relationship));
    } else if (filterId) {
      relationships.add(filterId);
    }
  });
  return expandRelationshipFilters(relationships);
}

function inferFilterIdsFromRelationships(relationships: Iterable<string>): Set<string> {
  const enabled = new Set(relationships);
  const inferred = new Set<string>();
  relationshipFilterItems.forEach((item) => {
    if (item.relationships.some((relationship) => enabled.has(relationship))) {
      inferred.add(item.id);
    }
  });
  enabled.forEach((relationship) => {
    const represented = relationshipFilterItems.some((item) =>
      item.relationships.includes(relationship),
    );
    if (!represented) inferred.add(relationship);
  });
  return inferred;
}

function relationshipFilterCount(
  item: RelationshipFilterItem,
  relationshipCounts: Map<string, number>,
): number {
  if (item.id === "DEEP_DEPENDENCIES") {
    return relationshipCounts.get("DEEP_DEPENDENCIES") ?? 0;
  }
  return item.relationships.reduce(
    (sum, relationship) => sum + (relationshipCounts.get(relationship) ?? 0),
    0,
  );
}

function relationshipFilterHasData(
  item: RelationshipFilterItem,
  relationshipCounts: Map<string, number>,
  nodeCount: number,
  active: boolean,
): boolean {
  if (active) return true;
  if (item.alwaysVisible && nodeCount > 0) return true;
  return relationshipFilterCount(item, relationshipCounts) > 0;
}

const defaultEnabledRelationships = ["CONTAINS"];

const legendItems = [
  { label: "Folder", color: "#D9B24C" },
  { label: "File", color: "#4FB6A9" },
  { label: "Class", color: "#A78BFA" },
  { label: "Method", color: "#8CCB7E" },
  { label: "Interface", color: "#5DADE2" },
  { label: "Function", color: "#F59E72" },
  { label: "Route", color: "#4FA3D8" },
  { label: "Endpoint", color: "#4FA3D8" },
  { label: "Controller", color: "#E6B450" },
  { label: "Service", color: "#58B482" },
  { label: "Repository", color: "#6D9DE8" },
  { label: "ReactComponent", color: "#B58AE2" },
  { label: "AngularComponent", color: "#B58AE2" },
  { label: "Hook", color: "#D88A6A" },
  { label: "ORMModel", color: "#6D9DE8" },];

function App() {
  const {
    isGenerating,
    hasGraph,
    hasHydrated,
    status,
    generateGraph,
    applyGraphData,
    error,
    hydrate,
    missingLsp,
    nodes,
    edges,
  } = useGraphStore();
  const {
    status: configStatus,
    config: runtimeConfig,
    hydrate: hydrateConfig,
    startBackend,
  } = useConfigStore();
  const [activeTab, setActiveTab] = useState<TabId>("ask");
  const [activeUtility, setActiveUtility] = useState<UtilityId | null>(null);
  const [hasCompletedInitialSetup, setHasCompletedInitialSetup] =
    useState(false);
  const [isGraphSidebarCollapsed, setIsGraphSidebarCollapsed] = useState(true);
  const [selectedGraphNode, setSelectedGraphNode] =
    useState<GraphSelectionPayload>(null);
  const [activeRelationships, setActiveRelationships] = useState<Set<string>>(
    () => new Set(defaultEnabledRelationships),
  );
  const [relationshipFilterSearch, setRelationshipFilterSearch] = useState("");
  const [neo4jSyncRevision, setNeo4jSyncRevision] = useState(0);
  const [graphProgress, setGraphProgress] =
    useState<GraphProgressResponse | null>(null);
  const [isHostProgressActive, setIsHostProgressActive] = useState(false);
  const progressHideTimer = useRef<number | null>(null);
  const openedGraphForCurrentLoad = useRef(false);
  const autoGraphStarted = useRef(false);
  const graphSyncKey = useRef<string | null>(null);

  const openGraph = useCallback(() => {
    if (!hasGraph || isGenerating) return;
    postRequest({ command: "ui.openGraphPanel" });
  }, [hasGraph, isGenerating]);

  const createGraph = useCallback(async () => {
    graphSyncKey.current = null;
    openedGraphForCurrentLoad.current = false;
    await generateGraph();
  }, [generateGraph]);

  const navigateTo = useCallback((target: NavigationTarget) => {
    setActiveTab(target);
    setActiveUtility(null);
  }, []);

  const handleInitialSetupSaved = useCallback(() => {
    setHasCompletedInitialSetup(true);
    setActiveTab("graph");
    setActiveUtility(null);
  }, []);

  const handleSettingsSaved = useCallback((details?: { neo4jConfigChanged: boolean }) => {
    if (details?.neo4jConfigChanged) {
      graphSyncKey.current = null;
      setNeo4jSyncRevision((current) => current + 1);
    }
    setActiveUtility(null);
  }, []);

  useEffect(
    () =>
      onPush<GraphProgressResponse>("graph.progress", (msg) => {
        if (progressHideTimer.current) {
          window.clearTimeout(progressHideTimer.current);
          progressHideTimer.current = null;
        }
        setGraphProgress(msg);
        setIsHostProgressActive(true);
        if (msg.complete ?? msg.percent >= 100) {
          progressHideTimer.current = window.setTimeout(() => {
            setIsHostProgressActive(false);
            setGraphProgress(null);
            progressHideTimer.current = null;
          }, 900);
        }
      }),
    [],
  );
  useEffect(
    () =>
      onPush<GraphDataResponse>("graph.data", (msg) => {
        applyGraphData(msg.nodes, msg.edges);
      }),
    [applyGraphData],
  );
  useEffect(
    () => () => {
      if (progressHideTimer.current) {
        window.clearTimeout(progressHideTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    hydrateConfig();
  }, [hydrateConfig]);
  useEffect(() => {
    const canHydrateGraph =
      hasCompletedInitialSetup &&
      Boolean(runtimeConfig?.isConfigured) &&
      (configStatus === "configured" || configStatus === "ready");
    if (canHydrateGraph && !hasHydrated && status !== "hydrating") {
      void hydrate();
    }
  }, [
    configStatus,
    hasCompletedInitialSetup,
    hasHydrated,
    hydrate,
    runtimeConfig?.isConfigured,
    status,
  ]);
  useEffect(() => {
    if (
      !hasCompletedInitialSetup ||
      configStatus !== "configured" ||
      !hasHydrated ||
      !hasGraph ||
      isGenerating
    )
      return;
    void startBackend();
  }, [
    configStatus,
    hasCompletedInitialSetup,
    hasGraph,
    hasHydrated,
    isGenerating,
    startBackend,
  ]);
  useEffect(() => {
    if (configStatus === "error" && runtimeConfig?.isConfigured && hasGraph) {
      setActiveUtility("settings");
    }
  }, [configStatus, hasGraph, runtimeConfig?.isConfigured]);
  useEffect(
    () =>
      onPush<GraphSelectionChangedResponse>(
        "ui.graphSelectionChanged",
        (msg) => {
          setSelectedGraphNode(msg.node);
        },
      ),
    [],
  );
  useEffect(
    () =>
      onPush<GraphRelationshipFiltersChangedResponse>(
        "ui.graphRelationshipFiltersChanged",
        (msg) => {
          setActiveRelationships(
            inferFilterIdsFromRelationships(
              msg.requestedRelationships ?? msg.enabledRelationships,
            ),
          );
        },
      ),
    [],
  );
  useEffect(
    () =>
      onPush<NavigateResponse>("ui.navigate", (msg) => {
        navigateTo(msg.target);
      }),
    [navigateTo],
  );
  const relationshipCounts = useMemo(() => {
    const counts = new Map<string, number>();
    edges.forEach((edge) => {
      const type = graphEdgeType(edge);
      counts.set(type, (counts.get(type) ?? 0) + 1);
    });
    if (nodes.length > 0) {
      counts.set(
        "DEEP_DEPENDENCIES",
        counts.get("DEEP_DEPENDENCIES") ?? nodes.length,
      );
    }
    return counts;
  }, [edges, nodes.length]);

  const nodeTypeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    nodes.forEach((node) => {
      const type = node.type || "Unknown";
      counts.set(type, (counts.get(type) ?? 0) + 1);
    });
    return counts;
  }, [nodes]);

  const extraRelationshipItems = useMemo<RelationshipFilterItem[]>(() => {
    const knownRelationships = new Set(
      relationshipFilterItems.flatMap((item) => item.relationships),
    );
    return Array.from(relationshipCounts.keys())
      .filter((value) => !knownRelationships.has(value))
      .sort()
      .map((value) => ({
        id: value,
        label: labelFromRelationship(value),
        relationships: [value],
      }));
  }, [relationshipCounts]);

  const displayedRelationshipGroups = useMemo(() => {
    const filterQuery = relationshipFilterSearch.trim().toLowerCase();
    const matchesSearch = (item: RelationshipFilterItem) =>
      !filterQuery ||
      `${item.label} ${item.id} ${item.relationships.join(" ")}`
        .toLowerCase()
        .includes(filterQuery);

    const groups = relationshipFilterGroups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          matchesSearch(item) &&
          relationshipFilterHasData(
            item,
            relationshipCounts,
            nodes.length,
            activeRelationships.has(item.id),
          ),
        ),
      }))
      .filter((group) => group.items.length > 0);

    const extraItems = extraRelationshipItems.filter((item) =>
      matchesSearch(item) &&
      relationshipFilterHasData(
        item,
        relationshipCounts,
        nodes.length,
        activeRelationships.has(item.id),
      ),
    );
    if (extraItems.length > 0) {
      groups.push({ id: "other", title: "Other", items: extraItems });
    }

    return groups;
  }, [
    activeRelationships,
    extraRelationshipItems,
    relationshipCounts,
    relationshipFilterSearch,
    nodes.length,
  ]);
  useEffect(() => {
    if (!relationshipCounts.size) return;
    setActiveRelationships((current) => {
      const next = new Set<string>();
      current.forEach((filterId) => {
        const item = relationshipFilterItemById.get(filterId) ??
          extraRelationshipItems.find((extra) => extra.id === filterId);
        if (!item) {
          next.add(filterId);
          return;
        }
        if (
          relationshipFilterHasData(
            item,
            relationshipCounts,
            nodes.length,
            current.has(filterId),
          )
        ) {
          next.add(filterId);
        }
      });
      if (!next.size && relationshipCounts.has("CONTAINS")) {
        next.add("CONTAINS");
      }
      return next;
    });
  }, [extraRelationshipItems, relationshipCounts, nodes.length]);
  useEffect(() => {
    if (!hasCompletedInitialSetup || !hasHydrated) return;
    if (!hasGraph) {
      openedGraphForCurrentLoad.current = false;
      if (!autoGraphStarted.current && !isGenerating) {
        autoGraphStarted.current = true;
        void createGraph();
      }
      return;
    }
    autoGraphStarted.current = false;
    if (openedGraphForCurrentLoad.current) return;
    openedGraphForCurrentLoad.current = true;
    postRequest({ command: "ui.openGraphPanel" });
  }, [
    createGraph,
    hasCompletedInitialSetup,
    hasGraph,
    hasHydrated,
    isGenerating,
  ]);

  useEffect(() => {
    if (
      !hasCompletedInitialSetup ||
      configStatus !== "ready" ||
      !hasGraph ||
      isGenerating ||
      !runtimeConfig?.isChatConfigured
    )
      return;

    const key = [
      runtimeConfig.values.neo4jUri,
      runtimeConfig.values.neo4jUser,
      runtimeConfig.values.neo4jDatabase,
    ].join("|");
    if (graphSyncKey.current === key) return;
    graphSyncKey.current = key;
    postRequest({ command: "graph.syncForChat" });
  }, [
    configStatus,
    edges.length,
    hasCompletedInitialSetup,
    hasGraph,
    isGenerating,
    neo4jSyncRevision,
    nodes.length,
    runtimeConfig,
  ]);

  useEffect(() => {
    if (!hasGraph) return;
    postRequest({
      command: "ui.setGraphRelationshipFilters",
      enabledRelationships: Array.from(expandFilterIds(activeRelationships)),
    });
  }, [activeRelationships, hasGraph]);

  const shouldHydrateGraph =
    hasCompletedInitialSetup &&
    Boolean(runtimeConfig?.isConfigured) &&
    configStatus !== "missing" &&
    configStatus !== "error";
  const progressPhase = graphProgress?.phase ?? "";
  const isGraphProgress = [
    "startup_seed",
    "structural_analysis",
    "lsp_check",
    "lsp_installing",
    "lsp_installed",
    "semantic_analysis",
    "complete",
  ].includes(progressPhase);
  const isBackendProgress = [
    "backend_starting",
    "neo4j_export",
    "incremental_sync",
  ].includes(progressPhase);
  const isGraphLoading =
    (shouldHydrateGraph && (!hasHydrated || status === "hydrating")) ||
    (shouldHydrateGraph && hasHydrated && !hasGraph && status !== "error") ||
    isGenerating ||
    (isHostProgressActive && isGraphProgress);
  const isBackendLoading =
    configStatus === "saving" ||
    configStatus === "configured" ||
    configStatus === "starting" ||
    (isHostProgressActive && isBackendProgress);
  const isActivePageLoading =
    isGraphLoading || (activeTab !== "graph" && isBackendLoading);
  const isChatBlocked = Boolean(
    runtimeConfig && !runtimeConfig.isChatConfigured,
  );
  const loadingDetails = getLoadingDetails({
    configStatus,
    graphStatus: status,
    isGenerating,
    isHostProgressActive,
    graphProgress,
    missingLsp,
    hasHydrated,
  });
  useEffect(() => {
    if (isGraphLoading) {
      setActiveUtility(null);
    }
  }, [isGraphLoading]);

  if (
    !hasCompletedInitialSetup ||
    configStatus === "missing" ||
    (configStatus !== "loading" && !runtimeConfig?.isConfigured)
  ) {
    return <ConfigPage onSaved={handleInitialSetupSaved} />;
  }

  const toggleGraphSidebar = async () => {
    if (!hasGraph || isGraphLoading) return;

    try {
      const response = await request<GraphSidebarStateResponse>({
        command: "ui.toggleGraphSidebar",
      });
      setIsGraphSidebarCollapsed(response.isCollapsed);
    } catch {
    }
  };

  const renderSelectionDetails = () => {
    if (!selectedGraphNode) {
      return (
        <div className="graph-selection-empty">
          Select a node in the Project Graph panel to inspect its name, line,
          and location.
        </div>
      );
    }

    const filePath = selectedGraphNode.filePath || "";
    const fileName = graphFileName(filePath);
    const displayName =
      selectedGraphNode.label ||
      fileName ||
      selectedGraphNode.id ||
      "Not available";
    const lineNumber = selectedGraphNode.lineNumber
      ? String(selectedGraphNode.lineNumber)
      : "Not available";

    return (
      <div className="graph-selection-card">
        <div className="graph-file-strip">
          <div className="graph-file-meta">
            <span>{selectedGraphNode.type || "Name"}</span>
            <strong>{displayName}</strong>
          </div>
          <div className="graph-file-meta compact">
            <span>Line</span>
            <strong>{lineNumber}</strong>
          </div>
          <div className="graph-file-meta graph-location-meta">
            <span>Location</span>
            <strong title={filePath || undefined}>
              {filePath || "Not available"}
            </strong>
          </div>
        </div>
      </div>
    );
  };

  const toggleRelationship = (filterId: string) => {
    if (isGraphLoading) return;
    setActiveRelationships((current) => {
      const next = new Set(current);
      if (next.has(filterId)) {
        next.delete(filterId);
      } else {
        next.add(filterId);
      }
      return next;
    });
  };

  const selectAllRelationships = () => {
    if (isGraphLoading) return;
    setActiveRelationships(
      new Set(
        displayedRelationshipGroups.flatMap((group) =>
          group.items.map((item) => item.id),
        ),
      ),
    );
  };
  const clearRelationships = () => {
    if (isGraphLoading) return;
    setActiveRelationships(new Set());
  };

  const renderLoadingOverlay = () => {
    if (!isActivePageLoading) return null;

    return (
      <LoadingOverlay
        details={loadingDetails}
        hasGraph={hasGraph}
        nodesLength={nodes.length}
      />
    );
  };

  const renderGraphControlPane = () => (
    <aside className="graph-controls-pane" aria-label="Graph controls">
      <section className="graph-control-section">
        <h3>Selection</h3>
        <div
          className={`graph-details-box ${selectedGraphNode ? "" : "empty"}`}
        >
          {renderSelectionDetails()}
        </div>
      </section>

      <section className="graph-control-section">
        <div className="graph-section-header">
          <h3>Filters</h3>
          <div className="graph-section-actions">
            <button
              className="graph-text-btn"
              type="button"
              onClick={selectAllRelationships}
              disabled={isGraphLoading || !hasGraph}
            >
              All
            </button>
            <button
              className="graph-text-btn"
              type="button"
              onClick={clearRelationships}
              disabled={isGraphLoading || !hasGraph}
            >
              None
            </button>
          </div>
        </div>
        <input
          className="graph-filter-search"
          type="search"
          placeholder="Find filters"
          aria-label="Find graph filters"
          value={relationshipFilterSearch}
          onChange={(event) => setRelationshipFilterSearch(event.target.value)}
          disabled={!hasGraph || isGraphLoading}
        />
        <div className="graph-filter-groups">
          {displayedRelationshipGroups.map((group) => (
            <section className="graph-filter-group" key={group.id}>
              <div className="graph-filter-group-title">{group.title}</div>
              <div className="graph-filter-list">
                {group.items.map((item) => {
                  const active = activeRelationships.has(item.id);
                  return (
                    <button
                      className={`graph-filter-chip ${active ? "active" : ""}`}
                      key={item.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleRelationship(item.id)}
                      disabled={!hasGraph || isGraphLoading}
                      title={item.relationships.join(", ")}
                    >
                      <span>{item.label}</span>
                      <span className="graph-filter-count">
                        {relationshipFilterCount(item, relationshipCounts)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </section>

      <section className="graph-control-section">
        <h3>Legend</h3>
        <div className="graph-legend-list">
          {legendItems.map((item) => (
            <div className="graph-legend-item" key={item.label}>
              <span
                className="graph-legend-color"
                style={{ background: item.color }}
              />
              <span>{item.label}</span>
              <span className="graph-legend-count">
                {nodeTypeCounts.get(item.label) ?? 0}
              </span>
            </div>
          ))}
        </div>
      </section>
    </aside>
  );

  const renderGraphPage = () => (
    <div className="graph-page">
      <div className="graph-page-main">
        <div className="graph-page-header">
          <div>
            <h2>Graph</h2>
            <p>
              {hasGraph
                ? `${nodes.length} nodes, ${edges.length} relationships`
                : "Scan this project to create the graph."}
            </p>
          </div>
        </div>

        {error && <div className="scan-error">{error}</div>}
        <div className="graph-actions-panel">
          <button
            className="primary-btn graph-action-btn"
            onClick={() => void createGraph()}
            disabled={isGraphLoading}
          >
            {isGenerating
              ? "Scanning"
              : hasGraph
                ? "Scan Again"
                : "Scan Project"}
          </button>
          <button
            className="secondary-btn graph-action-btn"
            onClick={openGraph}
            disabled={!hasGraph || isGraphLoading}
          >
            Open Graph
          </button>
          <button
            className="secondary-btn graph-action-btn"
            onClick={toggleGraphSidebar}
            disabled={!hasGraph || isGraphLoading}
          >
            {isGraphSidebarCollapsed ? "Show Details" : "Hide Details"}
          </button>
        </div>
      </div>

      {renderGraphControlPane()}
    </div>
  );

  const utilityTitle = activeUtility === "history" ? "History" : "Settings";

  const renderChatSetupGate = () => (
    <div className="chat-config-backdrop">
      <section
        className="chat-config-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-config-title"
      >
        <h2 id="chat-config-title">Chat setup required</h2>
        <p>
          Complete the missing chat settings to enable GraphRAG chat and the
          Improve page. Local graph scanning and visualization remain
          available without them.
        </p>
        {runtimeConfig?.chatMissing?.length ? (
          <p>Missing: {runtimeConfig.chatMissing.join(", ")}</p>
        ) : null}
        <button
          type="button"
          className="primary-btn"
          onClick={() => setActiveUtility("settings")}
        >
          Open Settings
        </button>
      </section>
    </div>
  );

  return (
    <div className="dashboard">
      <div className="dashboard-body">
        <main
          className={`content-area content-area-${activeTab} ${isActivePageLoading ? "loading-active" : ""}`}
        >
          {renderLoadingOverlay()}
          {activeTab === "ask" && (
            <div className="chat-gate-container">
              <ChatPage
                disabled={isActivePageLoading || isChatBlocked}
                hideEmptyState={isActivePageLoading || isChatBlocked}
              />
              {isChatBlocked && !isActivePageLoading && renderChatSetupGate()}
            </div>
          )}
          {activeTab === "graph" && renderGraphPage()}
          {activeTab === "improve" && (
            <div className="chat-gate-container">
              <SuggestionsPage disabled={isActivePageLoading || isChatBlocked} />
              {isChatBlocked && !isActivePageLoading && renderChatSetupGate()}
            </div>
          )}
        </main>
      </div>
      <footer className="dashboard-footer">
        <div className="utility-actions" aria-label="Utilities">
          <button
            className={`utility-btn ${activeUtility === "history" ? "active" : ""}`}
            onClick={() =>
              setActiveUtility(activeUtility === "history" ? null : "history")
            }
            aria-label="History"
            title="History"
            disabled={isGraphLoading}
          >
            History
          </button>
          <button
            className={`utility-btn ${activeUtility === "settings" ? "active" : ""}`}
            onClick={() =>
              setActiveUtility(activeUtility === "settings" ? null : "settings")
            }
            aria-label="Settings"
            title="Settings"
            disabled={isGraphLoading}
          >
            Settings
          </button>
        </div>
      </footer>
      {activeUtility && (
        <div
          className="utility-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={utilityTitle}
        >
          <button
            className="utility-scrim"
            aria-label="Close panel"
            onClick={() => setActiveUtility(null)}
          />
          <aside className="utility-panel">
            <div className="utility-panel-header">
              <h2>{utilityTitle}</h2>
              <button
                className="utility-close"
                onClick={() => setActiveUtility(null)}
                aria-label="Close panel"
              >
                <X size={16} />
              </button>
            </div>
            <div className="utility-panel-body">
              {activeUtility === "history" ? (
                <SessionsPage />
              ) : (
                <ConfigPage mode="settings" onSaved={handleSettingsSaved} />
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function LoadingOverlay({
  details,
  hasGraph,
  nodesLength,
}: {
  details: LoadingDetails;
  hasGraph: boolean;
  nodesLength: number;
}) {
  const percent = Math.max(0, Math.min(100, details.percent));

  return (
    <div className="app-loading-overlay" aria-live="polite" aria-busy="true">
      <div className="app-loading-scrim" />
      <section className="startup-loading-card" role="status">
        <div className="startup-loading-icon">
          <Loader2 className="spinner-inline" size={18} />
        </div>
        <div className="startup-loading-content">
          <div className="startup-loading-header">
            <h2>{details.title}</h2>
            <span>{percent}%</span>
          </div>
          <p>{details.message}</p>
          <div className="startup-progress-track" aria-label="Startup progress">
            <div
              className="startup-progress-fill"
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="startup-loading-meta">
            <span>{details.phase}</span>
            {hasGraph ? (
              <span>{nodesLength} nodes ready</span>
            ) : (
              <span>Project Graph pending</span>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function graphEdgeType(edge: any): string {
  return String(
    edge.relationshipType ||
      edge.data?.relationshipType ||
      edge.label ||
      "RELATED",
  );
}

function graphFileName(filePath: string): string {
  if (!filePath) return "Not available";
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || filePath;
}

function labelFromRelationship(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function graphProgressText(status: string, missingLsp: any[]): string {
  switch (status) {
    case "backend_starting":
      return "Starting Project Assistant.";
    case "structural_analysis":
      return "Scanning project files and building the structural map.";
    case "lsp_installing":
      return missingLsp.length
        ? `Installing project support: ${missingLsp.map((item: any) => item.displayName ?? item.extensionId ?? item.id).join(", ")}.`
        : "Installing project support.";
    case "semantic_analysis":
      return "Finding connections between project items.";
    case "neo4j_export":
      return "Making the Project Graph available to chat through Neo4j.";
    case "lsp_installed":
      return "Project support installed; continuing graph creation.";
    default:
      return "Preparing the Project Graph in the background.";
  }
}

function getLoadingDetails({
  configStatus,
  graphStatus,
  isGenerating,
  isHostProgressActive,
  graphProgress,
  missingLsp,
  hasHydrated,
}: {
  configStatus: string;
  graphStatus: string;
  isGenerating: boolean;
  isHostProgressActive: boolean;
  graphProgress: GraphProgressResponse | null;
  missingLsp: any[];
  hasHydrated: boolean;
}): LoadingDetails {
  if (
    (graphProgress || isHostProgressActive) &&
    graphProgress?.phase !== "local_graph"
  ) {
    const fallbackPercent = graphStatusPercent(graphStatus);
    return {
      title: loadingTitleFromPhase(graphProgress?.phase),
      message:
        graphProgress?.message || graphProgressText(graphStatus, missingLsp),
      phase: loadingPhaseLabel(graphProgress?.phase || graphStatus),
      percent: graphProgress?.percent ?? fallbackPercent,
    };
  }

  if (configStatus === "loading") {
    return {
      title: "Opening assistant",
      message: "Loading your project and assistant settings.",
      phase: "Startup",
      percent: 6,
    };
  }

  if (!hasHydrated || graphStatus === "hydrating") {
    return {
      title: "Loading Project Graph",
      message: "Checking for an existing Project Graph.",
      phase: "Loading graph",
      percent: 12,
    };
  }

  if (configStatus === "saving") {
    return {
      title: "Saving settings",
      message: "Applying your updated configuration.",
      phase: "Settings",
      percent: 18,
    };
  }

  if (configStatus === "configured" || configStatus === "starting") {
    return {
      title: "Starting assistant",
      message: "Preparing Project Assistant.",
      phase: "Starting",
      percent: configStatus === "starting" ? 18 : 8,
    };
  }

  if (isGenerating) {
    return {
      title: "Creating Project Graph",
      message: graphProgressText(graphStatus, missingLsp),
      phase: loadingPhaseLabel(graphStatus),
      percent: 0,
    };
  }

  return {
    title: "Preparing assistant",
    message: "Loading project context.",
    phase: "Startup",
    percent: 0,
  };
}

function loadingTitleFromPhase(phase?: string): string {
  switch (phase) {
    case "startup_seed":
      return "Loading Project Graph";
    case "neo4j_export":
      return "Syncing Project Graph";
    case "local_graph":
      return "Preparing Local Graph";
    case "incremental_update":
    case "incremental_sync":
      return "Updating Project Graph";
    case "backend_starting":
      return "Starting assistant";
    default:
      return "Creating Project Graph";
  }
}

function loadingPhaseLabel(phase: string): string {
  switch (phase) {
    case "backend_starting":
      return "Starting";
    case "neo4j_export":
      return "Neo4j sync";
    case "incremental_sync":
      return "Updating Neo4j";
    case "incremental_update":
      return "Updating graph";
    case "startup_seed":
    case "local_graph":
      return "Loading graph";
    case "structural_analysis":
      return "Scanning code";
    case "semantic_analysis":
      return "Finding connections";
    case "lsp_check":
    case "lsp_installing":
    case "lsp_installed":
      return "Project support";
    default:
      return labelFromRelationship(phase);
  }
}

function graphStatusPercent(status: string): number {
  switch (status) {
    case "backend_starting":
      return 10;
    case "structural_analysis":
      return 34;
    case "lsp_missing":
      return 60;
    case "lsp_installing":
      return 68;
    case "lsp_installed":
      return 74;
    case "semantic_analysis":
      return 84;
    case "neo4j_export":
      return 96;
    default:
      return 5;
  }
}

export default App;

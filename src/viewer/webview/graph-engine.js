const GraphEngine = (() => {
  let dependencyFocusNodeId = null;

  function initialize(graph) {
    GraphState.setGraph(graph.nodes, graph.edges);
    showInitialGraph();
  }

  function getRootNodes() {
    const roots = [];
    for (const node of GraphState.state.nodes) {
      if (GraphTypes.isEvidenceNode(node)) continue;
      if (!GraphState.state.parentMap.has(node.id)) roots.push(node);
    }
    return roots;
  }

  const flowRelationshipTypes = new Set([
    "CFG_NEXT",
    "BRANCH_TRUE",
    "BRANCH_FALSE",
    "LOOP_BACK",
    "EXCEPTION_FLOW",
    "RETURNS_TO",
    "CONTROL_DEPENDS_ON",
    "READS",
    "WRITES",
    "ASSIGNS",
    "USES_VALUE",
    "DEFINES_VALUE",
    "REACHING_DEF",
    "FLOWS_TO",
    "PARAM_FLOWS_TO_ARG",
    "ARG_FLOWS_TO_PARAM",
    "RETURN_FLOWS_TO",
    "FIELD_READ",
    "FIELD_WRITE",
    "CAPTURES",
  ]);

  function hasAnyFlowRelationshipEnabled() {
    for (const type of flowRelationshipTypes) {
      if (GraphState.isRelationshipVisible(type)) return true;
    }
    return false;
  }

  function isFlowNode(node) {
    return Boolean(node?.properties?.flowNode);
  }

  function isFlowOwnerNode(node) {
    return ["Class", "Interface", "Function", "Method"].includes(node?.type || "");
  }

  function showContainsChildren(nodeId) {
    const state = GraphState.state;
    const children = state.childrenMap.get(nodeId) || [];
    for (const childId of children) {
      const child = state.nodeMap.get(childId);
      if (GraphTypes.isEvidenceNode(child)) continue;
      GraphState.showNode(childId);
      for (const edge of state.edges) {
        if (
          edge.relationshipType === "CONTAINS" &&
          edge.source === nodeId &&
          edge.target === childId
        ) {
          GraphState.showEdge(edge.id);
        }
      }
    }
  }

  function showInitialGraph() {
    const state = GraphState.state;
    dependencyFocusNodeId = null;
    GraphState.clearVisibleGraph();
    state.expandedNodes.clear();

    for (const root of getRootNodes()) {
      GraphState.showNode(root.id);
      GraphState.expand(root.id);
      showContainsChildren(root.id);
    }

    showDetailsForVisibleStructure();
    refreshRelationshipVisibility();
  }

  function showDeepOverviewGraph() {
    const state = GraphState.state;
    dependencyFocusNodeId = null;
    GraphState.clearVisibleGraph();
    state.expandedNodes.clear();

    for (const node of state.nodes) {
      if (GraphTypes.isEvidenceNode(node)) continue;
      GraphState.showNode(node.id);
      GraphState.expand(node.id);
    }

    showDetailsForVisibleStructure();

    if (GraphState.isPreciseReferencesEnabled()) {
      showEvidenceForVisibleStructure();
    }

    refreshRelationshipVisibility();
  }

  function showOverviewForCurrentFilters() {
    if (GraphState.isRelationshipVisible("DEEP_DEPENDENCIES")) {
      showDeepOverviewGraph();
    } else {
      showInitialGraph();
    }
  }

  function expandNode(nodeId) {
    GraphState.expand(nodeId);
    showContainsChildren(nodeId);
    refreshRelationshipVisibility();
  }

  function collapseNode(nodeId) {
    GraphState.collapse(nodeId);
    collapseChildren(nodeId);
    refreshRelationshipVisibility();
  }

  function collapseChildren(parentId) {
    const state = GraphState.state;
    const children = state.childrenMap.get(parentId) || [];
    for (const childId of children) {
      const child = state.nodeMap.get(childId);
      if (GraphTypes.isEvidenceNode(child)) continue;
      collapseChildren(childId);
      GraphState.hideNode(childId);
      GraphState.collapse(childId);
      for (const edge of state.edges) {
        if (
          edge.relationshipType === "CONTAINS" &&
          edge.source === parentId &&
          edge.target === childId
        ) {
          GraphState.hideEdge(edge.id);
        }
      }
    }
  }

  function toggleNode(nodeId) {
    if (GraphState.isExpanded(nodeId)) collapseNode(nodeId);
    else expandNode(nodeId);
  }

  function getVisibleGraph() {
    const state = GraphState.state;
    return {
      nodes: state.nodes.filter((n) => state.visibleNodes.has(n.id)),
      edges: state.edges.filter((e) => state.visibleEdges.has(e.id)),
    };
  }

  function setRelationshipFilter(type, enabled) {
    GraphState.setRelationshipFilter(type, enabled);
    if (dependencyFocusNodeId) {
      showDependencyGraph(dependencyFocusNodeId);
    } else if (type === "DEEP_DEPENDENCIES" || GraphTypes.isDetailRelationship(type)) {
      showOverviewForCurrentFilters();
    } else if (GraphState.isRelationshipVisible("DEEP_DEPENDENCIES")) {
      showDeepOverviewGraph();
    } else {
      refreshRelationshipVisibility();
    }
  }

  function setRelationshipFilters(enabledRelationships) {
    GraphState.setEnabledRelationships(enabledRelationships);
    if (dependencyFocusNodeId) {
      showDependencyGraph(dependencyFocusNodeId);
    } else {
      showOverviewForCurrentFilters();
    }
  }

  function refreshRelationshipVisibility() {
    const state = GraphState.state;
    const precise = GraphState.isPreciseReferencesEnabled();

    for (const edge of state.edges) {
      const type = edge.relationshipType;
      const bothVisible =
        state.visibleNodes.has(edge.source) && state.visibleNodes.has(edge.target);

      if (!bothVisible) {
        GraphState.hideEdge(edge.id);
        continue;
      }

      if (GraphTypes.isEvidenceRelationship(type) && !precise) {
        GraphState.hideEdge(edge.id);
        continue;
      }

      if (GraphState.isRelationshipVisible(type)) {
        GraphState.showEdge(edge.id);
      } else {
        GraphState.hideEdge(edge.id);
      }
    }
  }

  function getNeighbours(nodeId) {
    const neighbours = new Set();
    for (const edge of GraphState.state.edges) {
      if (edge.source === nodeId) neighbours.add(edge.target);
      if (edge.target === nodeId) neighbours.add(edge.source);
    }
    return Array.from(neighbours);
  }

  function search(text) {
    const keyword = text.trim().toLowerCase();
    if (!keyword) return [];

    const state = GraphState.state;
    const searchableRelationshipsByNode = new Map();
    for (const edge of state.edges) {
      const relationshipType = edge.relationshipType || edge.label || "";
      if (!GraphState.isRelationshipVisible(relationshipType)) continue;
      if (
        GraphTypes.isEvidenceRelationship(relationshipType) &&
        !GraphState.isPreciseReferencesEnabled()
      ) {
        continue;
      }
      for (const nodeId of [edge.source, edge.target]) {
        if (!searchableRelationshipsByNode.has(nodeId)) {
          searchableRelationshipsByNode.set(nodeId, []);
        }
        searchableRelationshipsByNode.get(nodeId).push(relationshipType);
      }
    }

    return state.nodes.filter((node) => {
      const enabledRelationships = searchableRelationshipsByNode.get(node.id) || [];
      const isEnabledByFilter =
        GraphTypes.isStructureNode(node) || enabledRelationships.length > 0;
      if (!isEnabledByFilter) return false;

      const values = [];
      collectSearchableValues(node, values);
      values.push(...enabledRelationships);
      return values.some((value) => value.toLowerCase().includes(keyword));
    });
  }

  function collectSearchableValues(value, output, depth = 0) {
    if (value === null || value === undefined || depth > 6) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collectSearchableValues(item, output, depth + 1));
      return;
    }
    if (typeof value === "object") {
      Object.entries(value).forEach(([key, item]) => {
        output.push(key);
        collectSearchableValues(item, output, depth + 1);
      });
    }
  }

  function expandPathToNode(nodeId) {
    let current = nodeId;
    while (GraphState.state.parentMap.has(current)) {
      const parent = GraphState.state.parentMap.get(current);
      expandNode(parent);
      current = parent;
    }
  }

  function getAllDescendants(nodeId) {
    const state = GraphState.state;
    const result = new Set();
    const stack = [nodeId];
    while (stack.length) {
      const current = stack.pop();
      const children = state.childrenMap.get(current) || [];
      for (const childId of children) {
        const child = state.nodeMap.get(childId);
        if (GraphTypes.isEvidenceNode(child)) continue;
        if (!result.has(childId)) {
          result.add(childId);
          stack.push(childId);
        }
      }
    }
    return result;
  }

  function showDependencyGraph(nodeId) {
    const state = GraphState.state;
    dependencyFocusNodeId = nodeId;
    GraphState.clearVisibleGraph();

    GraphState.showNode(nodeId);

    const showDeepDependencies =
      GraphState.isRelationshipVisible("DEEP_DEPENDENCIES");

    if (!showDeepDependencies) {
      for (const edge of state.edges) {
        if (GraphTypes.isEvidenceRelationship(edge.relationshipType)) continue;
        if (!GraphState.isRelationshipVisible(edge.relationshipType)) continue;
        if (edge.source === nodeId || edge.target === nodeId) {
          GraphState.showNode(edge.source);
          GraphState.showNode(edge.target);
        }
      }
    } else {
      const descendants = getAllDescendants(nodeId);
      for (const descendantId of descendants) GraphState.showNode(descendantId);

      const focusSet = new Set([nodeId, ...descendants]);
      for (const edge of state.edges) {
        if (edge.relationshipType === "CONTAINS") continue;
        if (GraphTypes.isEvidenceRelationship(edge.relationshipType)) continue;
        if (!GraphState.isRelationshipVisible(edge.relationshipType)) continue;
        if (focusSet.has(edge.source) || focusSet.has(edge.target)) {
          GraphState.showNode(edge.source);
          GraphState.showNode(edge.target);
        }
      }

      let cursor = nodeId;
      while (state.parentMap.has(cursor)) {
        const parent = state.parentMap.get(cursor);
        GraphState.showNode(parent);
        cursor = parent;
      }
    }

    showDetailsForVisibleStructure();

    if (GraphState.isPreciseReferencesEnabled()) {
      showEvidenceAround(nodeId, showDeepDependencies);
    }

    refreshRelationshipVisibility();
  }

  function showEvidenceAround(nodeId, includeDescendants) {
    const focusSet = new Set([nodeId]);
    if (includeDescendants) {
      for (const descendantId of getAllDescendants(nodeId)) focusSet.add(descendantId);
    }
    showEvidenceForFocusSet(focusSet);
  }

  function showEvidenceForVisibleStructure() {
    const state = GraphState.state;
    const focusSet = new Set(
      Array.from(state.visibleNodes).filter((id) =>
        !GraphTypes.isEvidenceNode(state.nodeMap.get(id)),
      ),
    );
    showEvidenceForFocusSet(focusSet);
  }

  function showDetailsForVisibleStructure() {
    const flowEnabled = hasAnyFlowRelationshipEnabled();
    if (!GraphState.hasAnyDetailRelationshipEnabled() && !flowEnabled) return;
    const state = GraphState.state;
    const maxPasses = flowEnabled ? 80 : 3;

    for (let pass = 0; pass < maxPasses; pass++) {
      const visibleSnapshot = new Set(state.visibleNodes);
      let changed = false;

      for (const edge of state.edges) {
        const sourceNode = state.nodeMap.get(edge.source);
        const targetNode = state.nodeMap.get(edge.target);
        const isVisibleDetailEdge =
          GraphTypes.isDetailRelationship(edge.relationshipType) &&
          GraphState.isRelationshipVisible(edge.relationshipType);
        const isFlowContainmentBridge =
          flowEnabled &&
          edge.relationshipType === "CONTAINS" &&
          GraphState.isRelationshipVisible("CONTAINS") &&
          (isFlowNode(sourceNode) ||
            isFlowNode(targetNode) ||
            isFlowOwnerNode(sourceNode) ||
            isFlowOwnerNode(targetNode));

        if (!isVisibleDetailEdge && !isFlowContainmentBridge) continue;

        const sourceVisible = visibleSnapshot.has(edge.source);
        const targetVisible = visibleSnapshot.has(edge.target);
        const canRevealTarget =
          GraphTypes.isDetailNode(targetNode) ||
          (isFlowContainmentBridge && isFlowOwnerNode(targetNode));
        const canRevealSource =
          GraphTypes.isDetailNode(sourceNode) ||
          (isFlowContainmentBridge && isFlowOwnerNode(sourceNode));

        if (sourceVisible && canRevealTarget) {
          GraphState.showNode(edge.target);
          changed = true;
        }
        if (targetVisible && canRevealSource) {
          GraphState.showNode(edge.source);
          changed = true;
        }
      }

      if (!changed) break;
    }

    showTargetsForVisibleCallSites();
  }

  function showTargetsForVisibleCallSites() {
    const state = GraphState.state;
    if (GraphState.isRelationshipVisible("CALLS")) {
      for (const edge of state.edges) {
        if (edge.relationshipType !== "CALLS") continue;
        if (!isExactCallEdge(edge)) continue;
        if (state.visibleNodes.has(edge.source)) GraphState.showNode(edge.target);
      }
    }

    if (GraphState.isRelationshipVisible("CALLS_OVERRIDE")) {
      for (const edge of state.edges) {
        if (edge.relationshipType !== "CALLS_OVERRIDE") continue;
        if (state.visibleNodes.has(edge.source)) GraphState.showNode(edge.target);
      }
    }
  }

  function isExactCallEdge(edge) {
    const props = edge.properties || {};
    return props.exact === true;
  }

  function showEvidenceForFocusSet(focusSet) {
    const state = GraphState.state;
    for (const focusId of Array.from(focusSet)) {
      const occurrences = state.occurrenceMap.get(focusId) || [];
      for (const occurrenceId of occurrences) {
        showEvidenceNode(occurrenceId);
      }
    }

    for (const edge of state.edges) {
      if (!GraphTypes.isEvidenceRelationship(edge.relationshipType)) continue;
      if (focusSet.has(edge.source) || focusSet.has(edge.target)) {
        showEvidenceNode(edge.source);
        showEvidenceNode(edge.target);
      }
    }

    for (let i = 0; i < 2; i++) {
      const visibleEvidence = new Set(
        Array.from(state.visibleNodes).filter((id) =>
          GraphTypes.isEvidenceNode(state.nodeMap.get(id)),
        ),
      );
      for (const edge of state.edges) {
        if (!GraphTypes.isEvidenceRelationship(edge.relationshipType)) continue;
        if (visibleEvidence.has(edge.source) || visibleEvidence.has(edge.target)) {
          showEvidenceNode(edge.source);
          showEvidenceNode(edge.target);
        }
      }
    }
  }

  function showEvidenceNode(id) {
    const node = GraphState.state.nodeMap.get(id);
    if (!node) return;
    GraphState.showNode(id);
  }

  function restoreHierarchyView() {
    dependencyFocusNodeId = null;
    showOverviewForCurrentFilters();
  }

  function refresh() {
    if (dependencyFocusNodeId) showDependencyGraph(dependencyFocusNodeId);
    else showOverviewForCurrentFilters();
  }

  return {
    initialize,
    getRootNodes,
    expandNode,
    collapseNode,
    toggleNode,
    getVisibleGraph,
    setRelationshipFilter,
    setRelationshipFilters,
    refreshRelationshipVisibility,
    getNeighbours,
    search,
    expandPathToNode,
    showDependencyGraph,
    restoreHierarchyView,
    refresh,
  };
})();

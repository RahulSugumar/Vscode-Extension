const GraphTypes = (() => {
  const structureNodeTypes = new Set([
    "Folder",
    "File",
    "Class",
    "Interface",
    "Function",
    "Method",
  ]);

  const evidenceNodeTypes = new Set([
    "Symbol",
    "Definition",
    "Declaration",
    "Reference",
    "ExternalSymbol",
  ]);

  const detailNodeTypes = new Set([
    "Module",
    "Package",
    "Namespace",
    "Variable",
    "Local",
    "Parameter",
    "Field",
    "Property",
    "Constant",
    "Import",
    "Export",
    "TypeAlias",
    "Enum",
    "EnumMember",
    "Decorator",
    "Annotation",
    "Comment",
    "DocBlock",
    "ConfigFile",
    "Dependency",
    "CallExpression",
    "Argument",
    "Receiver",
    "ReturnValue",
    "Route",
    "Endpoint",
    "Controller",
    "Service",
    "Repository",
    "ReactComponent",
    "AngularComponent",
    "AngularService",
    "FrameworkModule",
    "Hook",
    "StateVariable",
    "EventHandler",
    "ORMModel",
    "DatabaseTable",
    "MessageTopic",
    "Template",
    "BasicBlock",
    "IfStatement",
    "Loop",
    "SwitchCase",
    "TryCatch",
    "ReturnStatement",
    "ThrowStatement",
    "BreakStatement",
    "ContinueStatement",
    "Value",
    "Assignment",
    "Expression",
    "SourceExpression",
    "SinkExpression",
  ]);

  const structureRelationships = new Set([
    "CONTAINS",
    "CALLS",
    "IMPORTS_FROM",
    "EXTENDS",
    "IMPLEMENTS",
    "INSTANTIATES",
  ]);

  const evidenceRelationships = new Set([
    "HAS_OCCURRENCE",
    "DEFINES",
    "DECLARES",
    "REFERS_TO",
    "RESOLVES_TO",
    "REF_CALL",
  ]);

  const detailRelationships = new Set([
    "HAS_PARAM",
    "HAS_FIELD",
    "HAS_PROPERTY",
    "HAS_TYPE_PARAM",
    "TYPE_OF",
    "RETURNS",
    "IMPORTS",
    "EXPORTS",
    "REEXPORTS",
    "ALIASES",
    "DOCUMENTS",
    "ANNOTATED_BY",
    "CALL_SITE_OF",
    "HAS_ARGUMENT",
    "ARGUMENT_FLOWS_TO_PARAMETER",
    "RECEIVER_OF",
    "RETURN_FLOWS_TO_CALLER",
    "OVERRIDES",
    "CALLS_OVERRIDE",
    "ROUTES_TO",
    "HANDLES",
    "CALLS_SERVICE",
    "QUERIES_TABLE",
    "USES_MODEL",
    "EMITS_EVENT",
    "SUBSCRIBES_TO",
    "RENDERS",
    "USES_HOOK",
    "UPDATES_STATE",
    "BINDS_TEMPLATE",
    "DEPENDS_ON",
    "USED_BY",
    "AFFECTS",
    "IMPACT_PATH",
    "CHANGES_PUBLIC_API",
    "CFG_NEXT",
    "BRANCH_TRUE",
    "BRANCH_FALSE",
    "LOOP_BACK",
    "EXCEPTION_FLOW",
    "RETURNS_TO",
    "DOMINATES",
    "POST_DOMINATES",
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

  return {
    structureNodeTypes,
    evidenceNodeTypes,
    detailNodeTypes,
    structureRelationships,
    evidenceRelationships,
    detailRelationships,
    isEvidenceNode(nodeOrType) {
      const type = typeof nodeOrType === "string" ? nodeOrType : nodeOrType?.type;
      return evidenceNodeTypes.has(type || "") || detailNodeTypes.has(type || "");
    },
    isDetailNode(nodeOrType) {
      const type = typeof nodeOrType === "string" ? nodeOrType : nodeOrType?.type;
      return detailNodeTypes.has(type || "");
    },
    isStructureNode(nodeOrType) {
      const type = typeof nodeOrType === "string" ? nodeOrType : nodeOrType?.type;
      return structureNodeTypes.has(type || "");
    },
    isEvidenceRelationship(type) {
      return evidenceRelationships.has(type || "");
    },
    isDetailRelationship(type) {
      return detailRelationships.has(type || "");
    },
    isStructureRelationship(type) {
      return structureRelationships.has(type || "");
    },
  };
})();

window.GraphTypes = GraphTypes;

const GraphState = (() => {
  const DEFAULT_RELATIONSHIP_FILTERS = Object.freeze({
    CONTAINS: true,
    CALLS: false,
    IMPORTS_FROM: false,
    EXTENDS: false,
    IMPLEMENTS: false,
    INSTANTIATES: false,
    HAS_OCCURRENCE: false,
    DEFINES: false,
    DECLARES: false,
    REFERS_TO: false,
    RESOLVES_TO: false,
    REF_CALL: false,
    HAS_PARAM: false,
    HAS_FIELD: false,
    HAS_PROPERTY: false,
    HAS_TYPE_PARAM: false,
    TYPE_OF: false,
    RETURNS: false,
    IMPORTS: false,
    EXPORTS: false,
    REEXPORTS: false,
    ALIASES: false,
    DOCUMENTS: false,
    ANNOTATED_BY: false,
    CALL_SITE_OF: false,
    HAS_ARGUMENT: false,
    ARGUMENT_FLOWS_TO_PARAMETER: false,
    RECEIVER_OF: false,
    RETURN_FLOWS_TO_CALLER: false,
    OVERRIDES: false,
    CALLS_OVERRIDE: false,
    ROUTES_TO: false,
    HANDLES: false,
    CALLS_SERVICE: false,
    QUERIES_TABLE: false,
    USES_MODEL: false,
    EMITS_EVENT: false,
    SUBSCRIBES_TO: false,
    RENDERS: false,
    USES_HOOK: false,
    UPDATES_STATE: false,
    BINDS_TEMPLATE: false,
    DEPENDS_ON: false,
    USED_BY: false,
    AFFECTS: false,
    IMPACT_PATH: false,
    CHANGES_PUBLIC_API: false,
    CFG_NEXT: false,
    BRANCH_TRUE: false,
    BRANCH_FALSE: false,
    LOOP_BACK: false,
    EXCEPTION_FLOW: false,
    RETURNS_TO: false,
    DOMINATES: false,
    POST_DOMINATES: false,
    CONTROL_DEPENDS_ON: false,
    READS: false,
    WRITES: false,
    ASSIGNS: false,
    USES_VALUE: false,
    DEFINES_VALUE: false,
    REACHING_DEF: false,
    FLOWS_TO: false,
    PARAM_FLOWS_TO_ARG: false,
    ARG_FLOWS_TO_PARAM: false,
    RETURN_FLOWS_TO: false,
    FIELD_READ: false,
    FIELD_WRITE: false,
    CAPTURES: false,
    DEEP_DEPENDENCIES: false,
  });

  const state = {
    nodes: [],
    edges: [],

    nodeMap: new Map(),
    edgeMap: new Map(),

    parentMap: new Map(),
    childrenMap: new Map(),
    occurrenceMap: new Map(),

    visibleNodes: new Set(),
    visibleEdges: new Set(),

    expandedNodes: new Set(),

    selectedNode: null,
    searchText: "",
    preciseReferences: false,

    relationshipFilters: { ...DEFAULT_RELATIONSHIP_FILTERS },

    cy: null,
  };

  function setGraph(nodes, edges) {
    state.nodes = Array.isArray(nodes) ? nodes : [];
    state.edges = Array.isArray(edges) ? edges : [];
    buildIndexes();
  }

  function getNodes() {
    return state.nodes;
  }

  function getEdges() {
    return state.edges;
  }

  function buildIndexes() {
    state.nodeMap.clear();
    state.edgeMap.clear();
    state.parentMap.clear();
    state.childrenMap.clear();
    state.occurrenceMap.clear();

    state.nodes.forEach((node) => {
      state.nodeMap.set(node.id, node);
    });

    state.edges.forEach((edge) => {
      state.edgeMap.set(edge.id, edge);

      if (edge.relationshipType === "CONTAINS") {
        state.parentMap.set(edge.target, edge.source);
        if (!state.childrenMap.has(edge.source)) state.childrenMap.set(edge.source, []);
        state.childrenMap.get(edge.source).push(edge.target);
      }

      if (edge.relationshipType === "HAS_OCCURRENCE") {
        if (!state.occurrenceMap.has(edge.source)) state.occurrenceMap.set(edge.source, []);
        state.occurrenceMap.get(edge.source).push(edge.target);
      }
    });
  }

  function showNode(id) {
    state.visibleNodes.add(id);
  }

  function hideNode(id) {
    state.visibleNodes.delete(id);
  }

  function showEdge(id) {
    state.visibleEdges.add(id);
  }

  function hideEdge(id) {
    state.visibleEdges.delete(id);
  }

  function clearVisibleGraph() {
    state.visibleNodes.clear();
    state.visibleEdges.clear();
  }

  function expand(id) {
    state.expandedNodes.add(id);
  }

  function collapse(id) {
    state.expandedNodes.delete(id);
  }

  function isExpanded(id) {
    return state.expandedNodes.has(id);
  }

  function setSelected(id) {
    state.selectedNode = id;
  }

  function getSelected() {
    return state.selectedNode;
  }

  function setSearch(text) {
    state.searchText = String(text || "").trim();
  }

  function getSearch() {
    return state.searchText;
  }

  function setPreciseReferencesEnabled(enabled) {
    state.preciseReferences = Boolean(enabled);
  }

  function isPreciseReferencesEnabled() {
    return state.preciseReferences === true;
  }

  function resetToDefaultRelationshipFilters() {
    state.relationshipFilters = { ...DEFAULT_RELATIONSHIP_FILTERS };
    state.preciseReferences = false;
  }

  function setRelationshipFilter(type, enabled) {
    state.relationshipFilters[type] = Boolean(enabled);
  }

  function setEnabledRelationships(enabledRelationships) {
    const enabled = new Set(Array.isArray(enabledRelationships) ? enabledRelationships : []);
    Object.keys(state.relationshipFilters).forEach((type) => {
      state.relationshipFilters[type] = enabled.has(type);
    });
  }

  function getEnabledRelationships() {
    return Object.keys(state.relationshipFilters).filter(
      (type) => state.relationshipFilters[type] === true,
    );
  }

  function isRelationshipVisible(type) {
    return state.relationshipFilters[type] === true;
  }

  function hasAnyEvidenceRelationshipEnabled() {
    for (const type of GraphTypes.evidenceRelationships) {
      if (state.relationshipFilters[type]) return true;
    }
    return false;
  }

  function enableDefaultEvidenceRelationships() {
    for (const type of GraphTypes.evidenceRelationships) {
      state.relationshipFilters[type] = true;
    }
  }

  function hasAnyDetailRelationshipEnabled() {
    for (const type of GraphTypes.detailRelationships) {
      if (state.relationshipFilters[type]) return true;
    }
    return false;
  }

  function setCy(cy) {
    state.cy = cy;
  }

  function getCy() {
    return state.cy;
  }

  return {
    state,
    setGraph,
    getNodes,
    getEdges,
    showNode,
    hideNode,
    showEdge,
    hideEdge,
    clearVisibleGraph,
    expand,
    collapse,
    isExpanded,
    setSelected,
    getSelected,
    setSearch,
    getSearch,
    setPreciseReferencesEnabled,
    isPreciseReferencesEnabled,
    resetToDefaultRelationshipFilters,
    setRelationshipFilter,
    setEnabledRelationships,
    getEnabledRelationships,
    isRelationshipVisible,
    hasAnyEvidenceRelationshipEnabled,
    enableDefaultEvidenceRelationships,
    hasAnyDetailRelationshipEnabled,
    setCy,
    getCy,
  };
})();

const GraphUI = (() => {
  let initialized = false;
  let currentMode = "overview"; // "overview" | "isolated"
  let isolatedNodeLabel = null;
  const allowedLayouts = new Set([
    "fcose",
    "breadthfirst",
    "cose",
    "concentric",
  ]);
  const vscode = (() => {
    try {
      return acquireVsCodeApi();
    } catch {
      return null;
    }
  })();
  const supportingRelationshipFilters = Object.freeze({
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
  });

  const relationshipFilterGroups = Object.freeze([
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
      includePreciseToggle: true,
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
  ]);

  const relationshipFilterItems = relationshipFilterGroups.flatMap((group) =>
    group.items.map((item) => ({ ...item, groupId: group.id })),
  );
  const relationshipFilterItemMap = new Map(
    relationshipFilterItems.map((item) => [item.id, item]),
  );
  const relationshipFilterIds = new Set(
    relationshipFilterItems.map((item) => item.id),
  );
  const defaultRequestedFilterIds = Object.freeze(["CONTAINS"]);
  let requestedRelationshipFilterIds = new Set(defaultRequestedFilterIds);
  function expandRelationshipFilters(relationships) {
    const expanded = new Set();
    const pending = Array.isArray(relationships)
      ? [...relationships]
      : Array.from(relationships || []);

    while (pending.length > 0) {
      const type = pending.shift();
      if (!type || expanded.has(type)) continue;
      expanded.add(type);
      const dependencies = supportingRelationshipFilters[type] || [];
      dependencies.forEach((dependency) => {
        if (!expanded.has(dependency)) pending.push(dependency);
      });
    }

    return expanded;
  }

  function initialize() {
    if (initialized) return;
    initialized = true;
    initializeToolbar();
    initializeFilters();
    initializePreciseReferencesToggle();
    initializeGraphEvents();
    initializeLeftPanelResizer();
    syncRelationshipCheckboxes();
    updateInspectorCounts();
    updateIsolateButtonState();
    updateModeStatus();
  }

  function forceLayoutOptions(overrides = {}) {
    return {
      padding: 90,
      idealEdgeLength: 220,
      nodeRepulsion: 12000,
      ...overrides,
    };
  }

  function focusOnNode(nodeId) {
    if (!nodeId) return;
    const selectedNode = GraphState.state.nodeMap.get(nodeId);
    if (!selectedNode) return;

    GraphState.setSelected(nodeId);
    updateDetails(selectedNode);
    isolatedNodeLabel = selectedNode.label || nodeId;

    GraphEngine.showDependencyGraph(nodeId);
    GraphRenderer.clearHighlight();
    GraphRenderer.render(GraphEngine.getVisibleGraph(), {
      layoutName: "fcose",
      randomize: true,
      forceLayout: true,
      layoutOptions: forceLayoutOptions({
        padding: 120,
        idealEdgeLength: 240,
        nodeRepulsion: 15000,
      }),
    });
    const cy = GraphRenderer.getCy();
    if (cy) {
      cy.one("layoutstop", () => {
        syncSelectionToCy();
        const neighbours = GraphEngine.getNeighbours(nodeId);
        GraphRenderer.highlightNodeAndNeighbours(nodeId, neighbours);
        GraphRenderer.focusNode(nodeId);
        updateModeStatus();
      });
    }

    currentMode = "isolated";
    updateModeStatus();
  }

  function initializePreciseReferencesToggle() {
    const toggle = document.getElementById("preciseReferencesToggle");
    if (!toggle) return;

    syncPreciseReferencesToggle();
    toggle.addEventListener("change", () => {
      const evidenceFilterIds = relationshipFilterItems
        .filter((item) =>
          item.relationships.some((relationship) =>
            GraphTypes.evidenceRelationships.has(relationship),
          ),
        )
        .map((item) => item.id);

      if (toggle.checked) {
        evidenceFilterIds.forEach((id) => requestedRelationshipFilterIds.add(id));
      } else {
        evidenceFilterIds.forEach((id) => requestedRelationshipFilterIds.delete(id));
      }

      GraphEngine.setRelationshipFilters(
        normalizeRequestedRelationships(Array.from(requestedRelationshipFilterIds)),
      );
      syncPreciseReferencesToggle();
      syncRelationshipCheckboxes();
      renderAfterEvidenceModeChange();
    });
  }

  function syncPreciseReferencesToggle() {
    const toggle = document.getElementById("preciseReferencesToggle");
    if (!toggle) return;
    const enabled = GraphState.isPreciseReferencesEnabled();
    toggle.checked = enabled;
    const chip = toggle.closest(".filterItem");
    chip?.classList.toggle("active", enabled);
    const stateLabel = chip?.querySelector(".filterCount");
    if (stateLabel) stateLabel.textContent = enabled ? "On" : "Off";
  }

  /**
   * Keep Cytoscape's :selected state in sync with GraphState.selectedNode
   * after every render() (because remove+add drops native selection).
   */
  function syncSelectionToCy() {
    const cy = GraphRenderer.getCy();
    if (!cy) return;
    const selectedId = GraphState.getSelected();
    cy.nodes().unselect();
    if (selectedId) {
      const n = cy.$id(selectedId);
      if (!n.empty()) n.select();
    }
    updateIsolateButtonState();
  }

  function initializeToolbar() {
    const searchButton = document.getElementById("searchBtn");
    const searchBox = document.getElementById("searchBox");
    const layoutSelect = document.getElementById("layoutSelect");
    const fitButton = document.getElementById("fitBtn");
    const resetButton = document.getElementById("resetBtn");
    const isolateButton = document.getElementById("isolateBtn");

    if (searchButton) {
      searchButton.addEventListener("click", () => {
        const text = searchBox ? searchBox.value : "";
        if (!text) return;
        const results = GraphEngine.search(text);
        if (results.length === 0) {
          updateStatus("No matching item found.");
          return;
        }

        const node = results[0];
        focusOnNode(node.id);
        updateStatus(
          results.length === 1
            ? `Focused on the matching item: ${node.label || node.id}`
            : `Focused on the first of ${results.length} matches: ${node.label || node.id}`,
        );
      });
    }

    if (searchBox && searchButton) {
      searchBox.addEventListener("keydown", (e) => {
        if (e.key === "Enter") searchButton.click();
      });
    }

    if (layoutSelect) {
      layoutSelect.addEventListener("change", (e) => {
        const name = e.target.value;
        if (!allowedLayouts.has(name)) {
          e.target.value = "fcose";
          return;
        }
        GraphRenderer.runLayout(name, true);
      });
    }

    if (fitButton) {
      fitButton.addEventListener("click", () => GraphRenderer.fit());
    }

    if (resetButton) {
      resetButton.addEventListener("click", () => {
        GraphEngine.restoreHierarchyView();
        GraphRenderer.clearHighlight();
        GraphState.setSelected(null);
        clearDetails();
        if (layoutSelect) layoutSelect.value = "fcose";
        GraphRenderer.render(GraphEngine.getVisibleGraph(), {
          layoutName: "fcose",
          randomize: true,
          layoutOptions: forceLayoutOptions(),
        });
        const cy = GraphRenderer.getCy();
        cy.one("layoutstop", syncSelectionToCy);

        currentMode = "overview";
        isolatedNodeLabel = null;
        updateModeStatus();
      });
    }

    if (isolateButton) {
      isolateButton.addEventListener("click", () => {
        const selectedNodeId = GraphState.getSelected();
        if (!selectedNodeId) return;
        focusOnNode(selectedNodeId);
      });
    }
  }

  function initializeFilters() {
    renderRelationshipFilters();

    document
      .querySelectorAll("#leftPanel input[data-relationship-filter='true']")
      .forEach((box) => {
        box.addEventListener("change", () => {
          if (box.checked) {
            requestedRelationshipFilterIds.add(box.value);
          } else {
            requestedRelationshipFilterIds.delete(box.value);
          }

          const normalizedRelationships = normalizeRequestedRelationships(
            Array.from(requestedRelationshipFilterIds),
          );
          GraphEngine.setRelationshipFilters(normalizedRelationships);
          syncPreciseReferencesToggle();
          syncRelationshipCheckboxes();
          renderAfterRelationshipFilterChange();
        });
      });

    const searchBox = document.getElementById("relationshipFilterSearch");
    if (searchBox) {
      searchBox.addEventListener("input", applyRelationshipFilterSearch);
    }

    const allButton = document.getElementById("relationshipsAllBtn");
    const noneButton = document.getElementById("relationshipsNoneBtn");

    if (allButton) {
      allButton.addEventListener("click", () => {
        requestedRelationshipFilterIds = new Set(
          Array.from(
            document.querySelectorAll("#leftPanel input[data-relationship-filter='true']"),
          )
            .filter((box) => !box.closest(".filterItem")?.classList.contains("noData"))
            .map((box) => box.value),
        );
        GraphEngine.setRelationshipFilters(
          normalizeRequestedRelationships(Array.from(requestedRelationshipFilterIds)),
        );
        syncPreciseReferencesToggle();
        syncRelationshipCheckboxes();
        renderAfterRelationshipFilterChange();
      });
    }

    if (noneButton) {
      noneButton.addEventListener("click", () => {
        requestedRelationshipFilterIds = new Set();
        GraphEngine.setRelationshipFilters(normalizeRequestedRelationships([]));
        syncPreciseReferencesToggle();
        syncRelationshipCheckboxes();
        renderAfterRelationshipFilterChange();
      });
    }
  }

  function renderRelationshipFilters() {
    const content = document.getElementById("leftPanelContent");
    const existingAllButton = document.getElementById("relationshipsAllBtn");
    const filterSection = existingAllButton?.closest(".inspectorSection");
    if (!content || !filterSection || filterSection.dataset.generatedFilters === "true") {
      return;
    }

    const sections = Array.from(content.children).filter((child) =>
      child.classList?.contains("inspectorSection"),
    );
    const filterIndex = sections.indexOf(filterSection);
    const legendIndex = sections.findIndex((section) =>
      Boolean(section.querySelector(".legendGrid")),
    );
    sections.forEach((section, index) => {
      if (index > filterIndex && (legendIndex < 0 || index < legendIndex)) {
        section.remove();
      }
    });

    filterSection.dataset.generatedFilters = "true";
    filterSection.innerHTML = `
      <div class="sectionTitleRow">
        <div class="sectionTitle">Filters</div>
        <div class="relationshipActions">
          <button class="inspectorTextButton" id="relationshipsAllBtn" type="button">All</button>
          <button class="inspectorTextButton" id="relationshipsNoneBtn" type="button">None</button>
        </div>
      </div>
      <input id="relationshipFilterSearch" class="filterSearch" type="search" placeholder="Find filters" aria-label="Find graph filters" />
      <div id="relationshipFilterGroups" class="filterGroupList">
        ${relationshipFilterGroups.map(renderRelationshipFilterGroup).join("")}
      </div>
    `;
  }

  function renderRelationshipFilterGroup(group) {
    const preciseToggle = group.includePreciseToggle
      ? `
        <label class="filterItem modeFilter" title="Show symbol occurrence nodes when symbol filters are enabled">
          <input id="preciseReferencesToggle" type="checkbox" />
          <span class="filterLabel">Evidence Nodes</span>
          <span class="filterCount">Off</span>
        </label>
      `
      : "";
    return `
      <details class="filterGroup" data-filter-group="${escapeHtml(group.id)}" open>
        <summary>
          <span>${escapeHtml(group.title)}</span>
          <span class="filterGroupCount" data-filter-group-count="${escapeHtml(group.id)}">0</span>
        </summary>
        <div class="relationshipChipList">
          ${preciseToggle}
          ${group.items.map(renderRelationshipFilterItem).join("")}
        </div>
      </details>
    `;
  }

  function renderRelationshipFilterItem(item) {
    const searchText = `${item.label} ${item.id} ${item.relationships.join(" ")}`.toLowerCase();
    return `
      <label class="filterItem" data-filter-id="${escapeHtml(item.id)}" data-filter-search="${escapeHtml(searchText)}" title="${escapeHtml(buildFilterTitle(item))}">
        <input data-relationship-filter="true" type="checkbox" value="${escapeHtml(item.id)}" />
        <span class="filterLabel">${escapeHtml(item.label)}</span>
        <span class="filterCount" data-filter-count="${escapeHtml(item.id)}">0</span>
        <span class="filterAuto" hidden>Auto</span>
      </label>
    `;
  }

  function buildFilterTitle(item) {
    const relationships = item.relationships.join(", ");
    const dependencies = new Set();
    item.relationships.forEach((relationship) => {
      (supportingRelationshipFilters[relationship] || []).forEach((dependency) => {
        if (!item.relationships.includes(dependency)) dependencies.add(dependency);
      });
    });
    if (!dependencies.size) return `${item.label}: ${relationships}`;
    return `${item.label}: ${relationships}. Auto enables: ${Array.from(dependencies).join(", ")}`;
  }

  function expandFilterIds(filterIds) {
    const relationships = new Set();
    (Array.isArray(filterIds) ? filterIds : []).forEach((filterId) => {
      const item = relationshipFilterItemMap.get(filterId);
      if (item) {
        item.relationships.forEach((relationship) => relationships.add(relationship));
      } else if (typeof filterId === "string" && filterId.trim()) {
        relationships.add(filterId.trim());
      }
    });
    return expandRelationshipFilters(relationships);
  }

  function inferRequestedFilterIds(enabledRelationships) {
    const enabled = new Set(Array.isArray(enabledRelationships) ? enabledRelationships : []);
    const inferred = new Set();
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

  function normalizeRequestedRelationships(filterIds) {
    const enabled = expandFilterIds(Array.isArray(filterIds) ? filterIds : []);
    let hasEvidence = false;
    for (const type of GraphTypes.evidenceRelationships) {
      if (enabled.has(type)) {
        hasEvidence = true;
        break;
      }
    }

    GraphState.setPreciseReferencesEnabled(hasEvidence);
    return Array.from(enabled);
  }

  function relationshipFilterCount(item, relationshipCounts) {
    if (item.id === "DEEP_DEPENDENCIES") {
      return relationshipCounts.get("DEEP_DEPENDENCIES") || 0;
    }
    return item.relationships.reduce(
      (total, relationship) => total + (relationshipCounts.get(relationship) || 0),
      0,
    );
  }

  function updateRelationshipFilterCounts(relationshipCounts) {
    document.querySelectorAll("[data-filter-count]").forEach((el) => {
      const item = relationshipFilterItemMap.get(el.getAttribute("data-filter-count"));
      const count = item ? relationshipFilterCount(item, relationshipCounts) : 0;
      el.textContent = String(count);
      const chip = el.closest(".filterItem");
      const active = chip?.classList.contains("active");
      chip?.classList.toggle("noData", count === 0 && !active && !item?.alwaysVisible);
    });

    relationshipFilterGroups.forEach((group) => {
      const total = group.items.reduce(
        (sum, item) => sum + relationshipFilterCount(item, relationshipCounts),
        0,
      );
      const countEl = document.querySelector(`[data-filter-group-count="${group.id}"]`);
      if (countEl) countEl.textContent = String(total);
      const groupEl = document.querySelector(`[data-filter-group="${group.id}"]`);
      const hasVisibleItem = Array.from(
        groupEl?.querySelectorAll(".filterItem[data-filter-id]") || [],
      ).some((itemEl) => !itemEl.classList.contains("noData"));
      groupEl?.classList.toggle("noData", !hasVisibleItem);
    });

    applyRelationshipFilterSearch();
  }

  function applyRelationshipFilterSearch() {
    const searchBox = document.getElementById("relationshipFilterSearch");
    const query = String(searchBox?.value || "").trim().toLowerCase();
    document.querySelectorAll(".filterItem[data-filter-id]").forEach((chip) => {
      const matches = !query || String(chip.dataset.filterSearch || "").includes(query);
      chip.classList.toggle("searchHidden", !matches);
    });
    document.querySelectorAll(".filterGroup").forEach((group) => {
      const hasVisibleItem = Array.from(group.querySelectorAll(".filterItem")).some(
        (chip) =>
          !chip.classList.contains("noData") &&
          !chip.classList.contains("searchHidden"),
      );
      group.classList.toggle("searchHidden", !hasVisibleItem);
    });
  }
  function renderAfterRelationshipFilterChange() {
    notifyRelationshipFilters();
    GraphRenderer.render(GraphEngine.getVisibleGraph(), {
      layoutName: "fcose",
      randomize: true,
      forceLayout: true,
      layoutOptions: forceLayoutOptions({
        padding: 120,
        idealEdgeLength: 260,
        nodeRepulsion: 18000,
        nodeSeparation: 120,
      }),
    });
    updateModeStatus();
    const cy = GraphRenderer.getCy();
    if (!cy) return;
    cy.one("layoutstop", () => {
      syncSelectionToCy();
      const selectedId = GraphState.getSelected();
      if (selectedId) {
        GraphRenderer.highlightNodeAndNeighbours(
          selectedId,
          GraphEngine.getNeighbours(selectedId),
        );
      }
      updateModeStatus();
    });
  }

  function renderAfterEvidenceModeChange() {
    if (currentMode === "isolated" && GraphState.getSelected()) {
      GraphEngine.showDependencyGraph(GraphState.getSelected());
    } else {
      GraphEngine.restoreHierarchyView();
    }

    GraphRenderer.clearHighlight();
    GraphRenderer.render(GraphEngine.getVisibleGraph(), {
      layoutName: "fcose",
      randomize: true,
      forceLayout: true,
      layoutOptions: forceLayoutOptions({
        padding: 120,
        idealEdgeLength: 250,
        nodeRepulsion: 16000,
        nodeSeparation: 110,
      }),
    });

    const cy = GraphRenderer.getCy();
    if (!cy) {
      updateModeStatus();
      return;
    }
    cy.one("layoutstop", () => {
      syncSelectionToCy();
      const selectedId = GraphState.getSelected();
      if (selectedId) {
        GraphRenderer.highlightNodeAndNeighbours(
          selectedId,
          GraphEngine.getNeighbours(selectedId),
        );
      }
      updateModeStatus();
    });
  }

  /**
   * Node tap  -> select + highlight + enable Isolate.
   * Double tap -> expand/collapse in place.
   * Background tap -> deferred clear (setTimeout 0) so it never
   *                   cancels a node-tap that fired in the same tick.
   */
  function initializeGraphEvents() {
    const cy = GraphRenderer.getCy();
    if (!cy) return;

    let previousTapTime = 0;
    let previousTapNodeId = null;
    let lastNodeTapAt = 0;

    cy.on("tap", "node", (evt) => {
      lastNodeTapAt = Date.now();
      const node = evt.target;
      const data = node.data();
      const current = Date.now();

      GraphState.setSelected(data.id);
      updateIsolateButtonState();

      const neighbours = GraphEngine.getNeighbours(data.id);
      GraphRenderer.highlightNodeAndNeighbours(data.id, neighbours);
      updateDetails(data);

      const isDoubleTap =
        current - previousTapTime < 500 && previousTapNodeId === node.id();

      if (isDoubleTap) {
        GraphEngine.toggleNode(node.id());
        GraphRenderer.render(GraphEngine.getVisibleGraph(), {
          layoutName: "fcose",
          randomize: false,
          layoutOptions: forceLayoutOptions(),
        });
        cy.one("layoutstop", () => {
          syncSelectionToCy();
          GraphRenderer.highlightNodeAndNeighbours(data.id, neighbours);
        });
        previousTapTime = 0;
        previousTapNodeId = null;
      } else {
        previousTapTime = current;
        previousTapNodeId = node.id();
      }
    });

    cy.on("tap", (evt) => {
      if (evt.target !== cy) return;
      setTimeout(() => {
        if (Date.now() - lastNodeTapAt < 50) return;
        GraphRenderer.clearHighlight();
        GraphState.setSelected(null);
        updateIsolateButtonState();
        clearDetails();
      }, 0);
    });
  }

  function initializeLeftPanelResizer() {
    const panel = document.getElementById("leftPanel");
    const handle = document.getElementById("leftPanelResizeHandle");
    if (!panel || !handle) return;

    handle.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = panel.offsetWidth;

      const onMouseMove = (moveEvent) => {
        const style = getComputedStyle(document.documentElement);
        const minWidth =
          parseFloat(style.getPropertyValue("--left-panel-min-width")) || 32;
        const maxWidth =
          parseFloat(style.getPropertyValue("--left-panel-max-width")) || 420;
        const nextWidth = Math.min(
          maxWidth,
          Math.max(minWidth, startWidth + moveEvent.clientX - startX),
        );
        document.documentElement.style.setProperty(
          "--left-panel-width",
          `${nextWidth}px`,
        );
        GraphRenderer.resize();
      };
      const onMouseUp = () => {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        GraphRenderer.resize();
        GraphRenderer.fit();
      };
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    });
  }

  function updateDetails(node) {
    const details = document.getElementById("details");
    if (!details) return;
    details.classList.remove("empty");
    const filePath = node.filePath || "";
    const fileName = fileNameFromPath(filePath);
    const displayName = node.label || fileName || "Unnamed item";
    const lineText = node.lineNumber
      ? escapeHtml(String(node.lineNumber))
      : "Not available";
    const rangeText = formatSourceRange(node.sourceRange);
    const locationTitle = filePath ? ` title="${escapeHtml(filePath)}"` : "";
    details.innerHTML = `
            <div class="selectionCard">
                <div class="fileStrip">
                    <div class="fileMeta">
                        <span>${escapeHtml(node.type || "Name")}</span>
                        <strong>${escapeHtml(displayName)}</strong>
                    </div>
                    <div class="fileMeta compact">
                        <span>Line</span>
                        <strong>${lineText}</strong>
                    </div>
                    <div class="fileMeta locationMeta">
                        <span>Location</span>
                        <strong${locationTitle}>${escapeHtml(filePath || "Not available")}</strong>
                    </div>
                    <div class="fileMeta locationMeta">
                        <span>Range</span>
                        <strong>${escapeHtml(rangeText)}</strong>
                    </div>
                </div>
            </div>
        `;
    notifySelection(node);
  }

  function clearDetails() {
    const details = document.getElementById("details");
    if (!details) return;
    details.classList.add("empty");
    details.innerHTML = `
            <div class="selectionEmpty">
                Select a node to inspect its name, line, and location.
            </div>
        `;
    notifySelection(null);
  }

  function setLeftPanelCollapsed(collapsed) {
    document.body.classList.toggle("left-panel-collapsed", Boolean(collapsed));
    GraphRenderer.resize();
    GraphRenderer.fit();
  }

  function setRelationshipFilters(enabledRelationships) {
    requestedRelationshipFilterIds = inferRequestedFilterIds(enabledRelationships);
    const normalizedRelationships = normalizeRequestedRelationships(Array.from(requestedRelationshipFilterIds));
    GraphEngine.setRelationshipFilters(normalizedRelationships);
    syncPreciseReferencesToggle();
    syncRelationshipCheckboxes();
    GraphRenderer.render(GraphEngine.getVisibleGraph(), {
      layoutName: "fcose",
      randomize: true,
      forceLayout: true,
      layoutOptions: forceLayoutOptions({
        padding: 120,
        idealEdgeLength: 260,
        nodeRepulsion: 18000,
        nodeSeparation: 120,
      }),
    });
    const cy = GraphRenderer.getCy();
    if (cy) {
      cy.one("layoutstop", () => {
        syncSelectionToCy();
        const selectedId = GraphState.getSelected();
        if (selectedId) {
          GraphRenderer.highlightNodeAndNeighbours(
            selectedId,
            GraphEngine.getNeighbours(selectedId),
          );
        }
        updateModeStatus();
      });
    }
    updateModeStatus();
  }

  function syncRelationshipCheckboxes() {
    const enabledRelationships = new Set(GraphState.getEnabledRelationships());
    document
      .querySelectorAll("#leftPanel input[data-relationship-filter='true']")
      .forEach((box) => {
        const item = relationshipFilterItemMap.get(box.value);
        const active = item
          ? item.relationships.some((relationship) => enabledRelationships.has(relationship))
          : GraphState.isRelationshipVisible(box.value);
        const requested = requestedRelationshipFilterIds.has(box.value);
        box.checked = active;
        const chip = box.closest(".filterItem");
        chip?.classList.toggle("active", active);
        chip?.classList.toggle("autoEnabled", active && !requested);
        const autoLabel = chip?.querySelector(".filterAuto");
        if (autoLabel) autoLabel.hidden = !(active && !requested);
      });
    updateInspectorCounts();
  }

  function updateInspectorCounts() {
    const relationshipCounts = new Map();
    GraphState.state.edges.forEach((edge) => {
      const type = edge.relationshipType || edge.label || "RELATED";
      relationshipCounts.set(type, (relationshipCounts.get(type) || 0) + 1);
    });
    if (GraphState.state.nodes.length > 0) {
      relationshipCounts.set(
        "DEEP_DEPENDENCIES",
        relationshipCounts.get("DEEP_DEPENDENCIES") ||
          GraphState.state.nodes.length,
      );
    }

    updateRelationshipFilterCounts(relationshipCounts);

    document.querySelectorAll("[data-relationship-count]").forEach((el) => {
      const type = el.getAttribute("data-relationship-count");
      el.textContent = String(relationshipCounts.get(type) || 0);
    });

    const nodeCounts = new Map();
    GraphState.state.nodes.forEach((node) => {
      const type = node.type || "Unknown";
      nodeCounts.set(type, (nodeCounts.get(type) || 0) + 1);
    });
    document.querySelectorAll("[data-node-count]").forEach((el) => {
      const type = el.getAttribute("data-node-count");
      el.textContent = String(nodeCounts.get(type) || 0);
    });
  }

  function notifySelection(node) {
    if (!vscode) return;
    vscode.postMessage({
      command: "graphSelectionChanged",
      node: node
        ? {
            id: node.id,
            label: node.label,
            type: node.type,
            filePath: node.filePath,
            lineNumber: node.lineNumber,
            sourceRange: node.sourceRange,
          }
        : null,
    });
  }

  function notifyRelationshipFilters() {
    if (!vscode) return;
    vscode.postMessage({
      command: "graphRelationshipFiltersChanged",
      enabledRelationships: GraphState.getEnabledRelationships(),
      requestedRelationships: Array.from(requestedRelationshipFilterIds),
    });
  }

  function updateIsolateButtonState() {
    const isolateButton = document.getElementById("isolateBtn");
    if (!isolateButton) return;
    isolateButton.disabled = !GraphState.getSelected();
  }

  /**
   * Small breadcrumb-style status showing the current view mode.
   */
  function updateModeStatus() {
    const visible = GraphEngine.getVisibleGraph();
    const nodeCount = visible.nodes.length;
    const edgeCount = visible.edges.length;
    updateSummary(nodeCount, edgeCount);

    let text;
    if (currentMode === "isolated" && isolatedNodeLabel) {
      text = `Focused on: ${isolatedNodeLabel} - ${nodeCount} items, ${edgeCount} connections`;
    } else {
      text = `Full map - ${nodeCount} items, ${edgeCount} connections`;
    }
    updateStatus(text);
  }

  function updateStatus(text) {
    const status = document.getElementById("status");
    if (status) status.textContent = text;
  }

  function updateSummary(nodeCount, edgeCount) {
    const summaryNodes = document.getElementById("summaryNodes");
    const summaryEdges = document.getElementById("summaryEdges");
    if (summaryNodes) summaryNodes.textContent = String(nodeCount);
    if (summaryEdges) summaryEdges.textContent = String(edgeCount);
    updateInspectorCounts();
  }

  function formatSourceRange(range) {
    if (!range) return "Not available";
    const startLine = range.startLine ?? "?";
    const startColumn = range.startColumn ?? "?";
    const endLine = range.endLine ?? "?";
    const endColumn = range.endColumn ?? "?";
    return `${startLine}:${startColumn} to ${endLine}:${endColumn}`;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function fileNameFromPath(filePath) {
    if (!filePath) return "Not available";
    const parts = String(filePath).split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || filePath;
  }

  return {
    initialize,
    updateDetails,
    clearDetails,
    updateStatus,
    updateModeStatus,
    setLeftPanelCollapsed,
    setRelationshipFilters,
  };
})();

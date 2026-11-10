const GraphRenderer = (() => {
  let cy = null;
  const FIT_PADDING = 40;

  function buildElements(graph) {
    const elements = [];
    graph.nodes.forEach((node) => {
      elements.push({
        data: {
          id: node.id,
          label: node.label,
          type: node.type,
          filePath: node.filePath,
          lineNumber: node.lineNumber,
          sourceRange: node.sourceRange,
        },
      });
    });
    graph.edges.forEach((edge) => {
      elements.push({
        data: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: edge.relationshipType,
        },
      });
    });
    return elements;
  }

  function initialize(containerId) {
    if (cy) cy.destroy();
    cy = cytoscape({
      container: document.getElementById(containerId),
      elements: [],
      style: GraphStyle.getStyles(0),
      layout: { name: "preset" },
    });
    GraphState.setCy(cy);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function getViewportSize() {
    const container = cy?.container();
    return {
      width: Math.max(container?.clientWidth || window.innerWidth || 900, 320),
      height: Math.max(container?.clientHeight || window.innerHeight || 600, 240),
    };
  }

  function getAdaptiveLayoutOptions(name) {
    const nodeCount = cy ? cy.nodes().length : 0;
    const edgeCount = cy ? cy.edges().length : 0;
    const evidenceCount = cy
      ? cy.nodes().filter((node) => GraphTypes.isEvidenceNode(node.data("type"))).length
      : 0;
    const { width, height } = getViewportSize();
    const area = width * height;
    const slots = Math.max(8, area / 36000);
    const crowding = clamp(Math.sqrt(Math.max(nodeCount, 1) / slots), 1, 2.6);
    const edgePressure = clamp(edgeCount / Math.max(nodeCount, 1), 0.8, 2.4);
    const evidenceBoost = evidenceCount > 0 ? 1.25 : 1;
    const availableCell = Math.sqrt(area / Math.max(nodeCount, 1));
    const labelSpacing = clamp(availableCell * 0.55, 90, 180);

    if (name === "fcose") {
      const nodeSeparation = Math.round(
        clamp(Math.max(labelSpacing, 82 * crowding * evidenceBoost), 82, 240),
      );
      const idealEdgeLength = Math.round(
        clamp(Math.max(labelSpacing * 1.55, 175 * crowding * evidenceBoost), 175, 460),
      );
      const nodeRepulsion = Math.round(
        clamp(9500 * crowding * crowding * edgePressure * evidenceBoost, 10000, 70000),
      );
      return {
        padding: Math.round(clamp(60 + crowding * 28, 80, 150)),
        idealEdgeLength,
        nodeRepulsion,
        nodeSeparation,
        gravity: clamp(0.34 / crowding, 0.12, 0.3),
      };
    }

    if (name === "breadthfirst") {
      return {
        spacingFactor: clamp(1.35 + crowding * 0.25, 1.6, 2.4),
      };
    }

    if (name === "concentric") {
      return {
        spacingFactor: clamp(1.25 + crowding * 0.22, 1.45, 2.2),
        minNodeSpacing: Math.round(clamp(labelSpacing, 70, 170)),
      };
    }

    return {};
  }

  function mergeLayoutOptions(base, specific, adaptive, overrides) {
    const merged = { ...base, ...specific, ...adaptive, ...overrides };
    ["padding", "idealEdgeLength", "nodeRepulsion", "nodeSeparation", "spacingFactor", "minNodeSpacing"].forEach((key) => {
      if (typeof adaptive[key] === "number" && typeof overrides[key] === "number") {
        merged[key] = Math.max(adaptive[key], overrides[key]);
      }
    });
    return merged;
  }

  // Layout-specific option builders - prevents fcose-only options
  // (nodeRepulsion / idealEdgeLength) from breaking other layouts.
  function getLayoutOptions(name, randomize, overrides = {}) {
    const base = {
      name,
      animate: true,
      animationDuration: 500,
      fit: false,
      padding: 30,
    };
    let specific;
    switch (name) {
      case "fcose":
        specific = {
          randomize,
          quality: "default",
          nodeRepulsion: 12000,
          idealEdgeLength: 220,
          edgeElasticity: 0.1,
          gravity: 0.25,
          numIter: 2500,
          tile: true,
          nodeSeparation: 90,
        };
        break;
      case "cose":
        specific = {
          randomize,
          nodeRepulsion: () => 400000,
          idealEdgeLength: () => 160,
          edgeElasticity: () => 100,
          gravity: 80,
          numIter: 1500,
        };
        break;
      case "breadthfirst":
        specific = { directed: true, spacingFactor: 1.6, grid: false };
        break;
      case "concentric":
        specific = {
          spacingFactor: 1.4,
          minNodeSpacing: 50,
          concentric: (node) => node.degree(),
          levelWidth: () => 2,
        };
        break;
      default:
        specific = {};
    }
    return mergeLayoutOptions(base, specific, getAdaptiveLayoutOptions(name), overrides);
  }

  function fitToViewport(animated = false) {
    if (!cy || cy.elements().length === 0) return;
    cy.resize();
    if (animated) {
      cy.animate({
        fit: { eles: cy.elements(), padding: FIT_PADDING },
        duration: 300,
      });
    } else {
      cy.fit(cy.elements(), FIT_PADDING);
    }
  }

  function runLayout(name = "fcose", randomize = false, layoutOptions = {}) {
    if (!cy || cy.elements().length === 0) return;
    const opts = getLayoutOptions(name, randomize, layoutOptions);
    const layout = cy.layout(opts);
    // Single, guaranteed fit *after* layout completes — fixes:
    //  - initial-load bad viewport
    //  - "root/edges off-screen" on layout switch
    //  - filter-change viewport (when layout runs)
    layout.one("layoutstop", () => fitToViewport(false));
    layout.run();
  }

  function render(graph, options = {}) {
    if (!cy) return;
    const {
      runLayoutOnChange = true,
      forceLayout = false,
      layoutName = "fcose",
      randomize = false,
      layoutOptions = {},
    } = options;

    const currentEles = cy.elements();
    const newEles = buildElements(graph);
    const newIds = new Set(newEles.map((e) => e.data.id));
    const toAdd = newEles.filter((e) =>
      currentEles.getElementById(e.data.id).empty(),
    );
    const toRemove = currentEles.filter((e) => !newIds.has(e.id()));

    // Apply style FIRST so newly-added elements render correctly on first paint.
    cy.style(GraphStyle.getStyles(graph.nodes.length));
    cy.batch(() => {
      cy.remove(toRemove);
      cy.add(toAdd);
    });

    const structureChanged = toAdd.length > 0 || toRemove.length > 0;
    if (forceLayout || (runLayoutOnChange && structureChanged)) {
      runLayout(layoutName, randomize, layoutOptions);
    } else {
      // No structural change (e.g. filter-only toggle that hid/showed
      // edges via visible set) — still refit so graph fills the panel.
      fitToViewport(true);
    }
  }

  function highlightNodeAndNeighbours(nodeId, neighbours) {
    if (!cy) return;
    cy.elements().removeClass("highlight").addClass("faded");
    cy.$id(nodeId).removeClass("faded").addClass("highlight");
    neighbours.forEach((id) =>
      cy.$id(id).removeClass("faded").addClass("highlight"),
    );
    cy.edges().forEach((edge) => {
      if (edge.data("source") === nodeId || edge.data("target") === nodeId) {
        edge.removeClass("faded").addClass("highlight");
      }
    });
  }

  function clearHighlight() {
    if (!cy) return;
    cy.elements().removeClass("highlight").removeClass("faded");
  }

  function focusNode(nodeId) {
    if (!cy) return;
    const node = cy.$id(nodeId);
    if (node.empty()) return;
    cy.resize();
    cy.animate({
      fit: { eles: node.closedNeighborhood(), padding: 80 },
      duration: 400,
    });
    node.select();
  }

  function fit() {
    fitToViewport(false);
  }

  function fitVisibleGraph() {
    fitToViewport(true);
  }

  function center(nodeId) {
    if (!cy) return;
    const node = cy.$id(nodeId);
    if (!node.empty()) cy.center(node);
  }

  function zoom(level) {
    if (cy) cy.zoom(level);
  }
  function resize() {
    if (cy) cy.resize();
  }
  function getCy() {
    return cy;
  }

  return {
    initialize,
    render,
    runLayout,
    fit,
    fitVisibleGraph,
    center,
    zoom,
    resize,
    highlightNodeAndNeighbours,
    clearHighlight,
    focusNode,
    getCy,
  };
})();

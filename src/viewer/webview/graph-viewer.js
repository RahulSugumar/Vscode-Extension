(function () {
  let pendingRelationshipFilters = null;

  if (
    typeof cytoscape !== "undefined" &&
    typeof cytoscapeFcose !== "undefined"
  ) {
    cytoscape.use(cytoscapeFcose);
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message) return;
    if (message.command === "setLeftPanelCollapsed") {
      GraphUI.setLeftPanelCollapsed(message.collapsed);
      return;
    }
    if (message.command === "setRelationshipFilters") {
      if (GraphRenderer.getCy()) {
        GraphUI.setRelationshipFilters(message.enabledRelationships || []);
      } else {
        pendingRelationshipFilters = message.enabledRelationships || [];
      }
      return;
    }
    if (message.command !== "loadGraph") return;
    loadGraph(
      message.graph,
      message.leftPanelCollapsed,
      message.enabledRelationships,
    );
  });

  function loadGraph(
    graph,
    leftPanelCollapsed = true,
    enabledRelationships = null,
  ) {
    // 1) Renderer first — creates the Cytoscape instance so downstream
    //    modules (GraphState, GraphUI) can bind to it.
    GraphRenderer.initialize("cy");

    // 2) Always start from the clean structural overview.
    //    Deep Links / evidence filters are intentionally opt-in after load.
    GraphState.resetToDefaultRelationshipFilters();
    GraphEngine.initialize(graph);

    // 3) UI is safe to bind now because cy exists.
    GraphUI.initialize();
    GraphUI.setLeftPanelCollapsed(leftPanelCollapsed);
    pendingRelationshipFilters = null;

    GraphUI.updateStatus(`Laying out ${graph.nodes.length} items...`);

    // 4) Single render with a fresh fcose layout.
    //    randomize=true ensures nodes get real spacing on first paint
    //    (fixes the "clumsy, no spacing, no root/edges visible" issue).
    //    The renderer's internal layoutstop handler will call cy.fit(),
    //    so we do NOT call fit() here — that avoids the double-zoom /
    //    premature-fit flash on initial load.
    GraphRenderer.render(GraphEngine.getVisibleGraph(), {
      runLayoutOnChange: true,
      layoutName: "fcose",
      randomize: true,
      layoutOptions: {
        padding: 90,
        idealEdgeLength: 220,
        nodeRepulsion: 12000,
        nodeSeparation: 100,
      },
    });

    // 5) Once layout finishes, flip the status bar to the final counts.
    const cy = GraphRenderer.getCy();
    if (cy) {
      cy.one("layoutstop", () => {
        GraphUI.updateModeStatus();
      });
    } else {
      GraphUI.updateModeStatus();
    }
  }
})();

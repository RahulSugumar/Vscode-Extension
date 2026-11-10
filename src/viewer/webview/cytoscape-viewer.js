if (typeof cytoscape !== "undefined" && typeof cytoscapeFcose !== "undefined") {
  cytoscape.use(cytoscapeFcose);
}

let cy;

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.command === "loadGraph") {
    const { nodes, edges } = message.graph;
    const cyElements = [];
    nodes.forEach((n) =>
      cyElements.push({
        data: {
          id: n.id,
          label: n.label,
          type: n.type,
          filePath: n.filePath,
          lineNumber: n.lineNumber,
          sourceRange: n.sourceRange,
        },
      }),
    );
    edges.forEach((e) =>
      cyElements.push({
        data: {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.relationshipType,
        },
      }),
    );

    document.getElementById("stats").textContent =
      `${nodes.length} nodes • ${edges.length} edges`;

    initCytoscape(cyElements);
  }
});

function pickInitialLayout(nodeCount) {
  if (nodeCount > 2000) {
    return {
      name: "fcose",
      animate: false,
      randomize: true,
      quality: "draft",
      numIter: 1000,
      nodeRepulsion: 4500,
      idealEdgeLength: 50,
      packComponents: true,
    };
  }
  return { name: "fcose", animate: true, randomize: true, quality: "default" };
}

function initCytoscape(elements) {
  const nodeCount = elements.filter((el) => !el.data.source).length;

  cy = cytoscape({
    container: document.getElementById("cy"),
    elements: elements,
    style: [
      {
        selector: "node",
        style: {
          "background-color": "#7A96B8",
          label: "data(label)",
          color: "#EEF2F6",
          "text-outline-width": 0,
          "font-size": "12px",
        },
      },
      {
        selector: 'node[type="File"]',
        style: { "background-color": "#e67e22", shape: "round-rectangle" },
      },
      {
        selector: 'node[type="Folder"]',
        style: { "background-color": "#f1c40f", shape: "rectangle" },
      },
      {
        selector: 'node[type="Class"]',
        style: { "background-color": "#9b59b6", shape: "hexagon" },
      },
      {
        selector: 'node[type="Method"]',
        style: { "background-color": "#50FA7B", shape: "ellipse" },
      },
      {
        selector: 'node[type="Interface"]',
        style: { "background-color": "#16A085", shape: "diamond" },
      },
      {
        selector: 'edge[label="CONTAINS"]',
        style: { "line-color": "#425C7A", "target-arrow-color": "#425C7A" },
      },
      {
        selector: 'edge[label="CALLS"]',
        style: {
          "line-color": "#50FA7B",
          "target-arrow-color": "#50FA7B",
          "line-style": "solid",
        },
      },
      {
        selector: 'edge[label="IMPORTS_FROM"]',
        style: {
          "line-color": "#F39C12",
          "target-arrow-color": "#F39C12",
          "line-style": "dashed",
        },
      },
      {
        selector: 'edge[label="EXTENDS"]',
        style: {
          "line-color": "#E74C3C",
          "target-arrow-color": "#E74C3C",
          width: 3,
        },
      },
      {
        selector: 'edge[label="IMPLEMENTS"]',
        style: {
          "line-color": "#9B59B6",
          "target-arrow-color": "#9B59B6",
          "line-style": "dashed",
        },
      },
      {
        selector: 'edge[label="INSTANTIATES"]',
        style: { "line-color": "#3498DB", "target-arrow-color": "#3498DB" },
      },
      {
        selector: "edge",
        style: {
          width: 2,
          "line-color": "#425C7A",
          "target-arrow-color": "#425C7A",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          label: nodeCount > 2000 ? "" : "data(label)",
          "font-size": "10px",
          color: "#C9D6E5",
          "text-rotation": "autorotate",
        },
      },
    ],
    layout: pickInitialLayout(nodeCount),
  });

  cy.on("tap", "node", function (evt) {
    showDetails(evt.target.data());
  });

  document.getElementById("layout-select").addEventListener("change", (e) => {
    const name = e.target.value;
    const opts = { name, animate: nodeCount <= 2000 };
    if (name === "fcose" && nodeCount > 2000) {
      opts.quality = "draft";
      opts.randomize = true;
      opts.numIter = 1000;
    }
    cy.layout(opts).run();
  });

  document.getElementById("fit-btn").addEventListener("click", () => cy.fit());
}

function showDetails(data) {
  const sidebar = document.getElementById("sidebar");
  const content = document.getElementById("details-content");
  let html = `<p><strong>Name:</strong> ${data.label || "N/A"}</p>`;
  html += `<p><strong>Type:</strong> ${data.type || "N/A"}</p>`;
  if (data.filePath) html += `<p><strong>File:</strong> ${data.filePath}</p>`;
  if (data.lineNumber)
    html += `<p><strong>Line:</strong> ${data.lineNumber}</p>`;
  content.innerHTML = html;
  sidebar.classList.add("open");
}

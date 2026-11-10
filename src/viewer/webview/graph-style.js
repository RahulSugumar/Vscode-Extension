// filename: graph-style.js
window.GraphStyle = {
  getStyles(nodeCount) {
    const showEdgeLabels = nodeCount < 150;
    const nodeFontSize = nodeCount < 80 ? 13 : nodeCount < 200 ? 12 : 11;

    return [
      {
        selector: "node",
        style: {
          "background-color": "#7C8EA6",
          label: "data(label)",
          color: "#ffffff",
          "font-size": nodeFontSize,
          "font-weight": "600",
          "font-family": 'Inter, "Segoe UI", Roboto, sans-serif',
          "text-valign": "bottom",
          "text-halign": "center",
          "text-margin-y": 6,
          "text-wrap": "wrap",
          "text-max-width": 160,
          "text-background-color": "#111B27",
          "text-background-opacity": 0.92,
          "text-background-padding": 4,
          "text-background-shape": "round-rectangle",
          "text-border-opacity": 0,
          "text-border-width": 0,
          "border-width": 0,
          width: 44,
          height: 44,
        },
      },

      {
        selector: 'node[type="Folder"]',
        style: {
          shape: "round-rectangle",
          "background-color": "#D9B24C",
          width: 60,
          height: 44,
          "font-size": nodeFontSize + 1,
          "font-weight": "700",
        },
      },
      {
        selector: 'node[type="File"]',
        style: {
          shape: "round-rectangle",
          "background-color": "#4FB6A9",
          width: 54,
          height: 42,
        },
      },
      {
        selector: 'node[type="Class"]',
        style: {
          shape: "hexagon",
          "background-color": "#A78BFA",
          width: 50,
          height: 46,
        },
      },
      {
        selector: 'node[type="Interface"]',
        style: {
          shape: "diamond",
          "background-color": "#5DADE2",
          width: 50,
          height: 50,
        },
      },
      {
        selector: 'node[type="Method"]',
        style: {
          shape: "ellipse",
          "background-color": "#8CCB7E",
          width: 44,
          height: 36,
        },
      },
      {
        selector: 'node[type="Function"]',
        style: {
          shape: "ellipse",
          "background-color": "#F59E72",
          width: 46,
          height: 38,
        },
      },

      {
        selector:
          'node[type="Symbol"], node[type="Definition"], node[type="Declaration"], node[type="Reference"], node[type="ExternalSymbol"]',
        style: {
          label: "data(label)",
          "text-opacity": 0.94,
          "text-background-opacity": 0.9,
          "font-size": 10,
          "font-weight": "650",
          "text-margin-y": 6,
          "text-max-width": 112,
          "text-background-padding": 3,
          width: 30,
          height: 24,
          opacity: 0.95,
          "border-width": 1,
          "border-color": "rgba(255, 255, 255, 0.28)",
          "z-index": 10,
        },
      },
      {
        selector: 'node[type="Symbol"]',
        style: {
          shape: "round-rectangle",
          "background-color": "#AEB8C7",
          width: 36,
          height: 26,
        },
      },
      {
        selector: 'node[type="Definition"]',
        style: {
          shape: "round-rectangle",
          "background-color": "#43C59E",
          width: 34,
          height: 26,
        },
      },
      {
        selector: 'node[type="Declaration"]',
        style: {
          shape: "round-rectangle",
          "background-color": "#D7B84F",
          width: 34,
          height: 26,
        },
      },
      {
        selector: 'node[type="Reference"]',
        style: {
          shape: "ellipse",
          "background-color": "#67B7F7",
          label: "data(label)",
          "text-opacity": 0.9,
          "text-background-opacity": 0.84,
          width: 22,
          height: 22,
        },
      },
      {
        selector: 'node[type="ExternalSymbol"]',
        style: {
          shape: "round-rectangle",
          "background-color": "#C084FC",
          width: 38,
          height: 28,
          "border-width": 2,
          "border-color": "#E9D5FF",
          "border-style": "dashed",
        },
      },

      {
        selector:
          'node[type="Module"], node[type="Package"], node[type="Namespace"], node[type="Variable"], node[type="Local"], node[type="Parameter"], node[type="Field"], node[type="Property"], node[type="Constant"], node[type="Import"], node[type="Export"], node[type="TypeAlias"], node[type="Enum"], node[type="EnumMember"], node[type="Decorator"], node[type="Annotation"], node[type="Comment"], node[type="DocBlock"], node[type="ConfigFile"], node[type="Dependency"]',
        style: {
          label: "data(label)",
          shape: "round-rectangle",
          "text-opacity": 0.94,
          "text-background-opacity": 0.9,
          "font-size": 10,
          "font-weight": "650",
          "text-margin-y": 6,
          "text-max-width": 128,
          "text-background-padding": 3,
          width: 34,
          height: 26,
          opacity: 0.94,
          "border-width": 1,
          "border-color": "rgba(255, 255, 255, 0.22)",
          "z-index": 12,
        },
      },
      {
        selector: 'node[type="Parameter"]',
        style: { "background-color": "#E3B65B", shape: "ellipse" },
      },
      {
        selector: 'node[type="Field"], node[type="Property"]',
        style: { "background-color": "#55C7D6" },
      },
      {
        selector: 'node[type="Variable"], node[type="Local"], node[type="Constant"]',
        style: { "background-color": "#A8C66C" },
      },
      {
        selector: 'node[type="Import"], node[type="Export"], node[type="Dependency"], node[type="ConfigFile"]',
        style: { "background-color": "#7EA7F5" },
      },
      {
        selector: 'node[type="TypeAlias"], node[type="Enum"], node[type="EnumMember"], node[type="Namespace"], node[type="Module"], node[type="Package"]',
        style: { "background-color": "#B792F6" },
      },
      {
        selector:
          'node[type="CallExpression"], node[type="Argument"], node[type="Receiver"], node[type="ReturnValue"]',
        style: {
          label: "data(label)",
          shape: "round-rectangle",
          "text-opacity": 0.94,
          "text-background-opacity": 0.9,
          "font-size": 10,
          "font-weight": "650",
          "text-margin-y": 6,
          "text-max-width": 128,
          "text-background-padding": 3,
          width: 36,
          height: 26,
          opacity: 0.95,
          "border-width": 1,
          "border-color": "rgba(255, 255, 255, 0.24)",
          "z-index": 14,
        },
      },
      {
        selector: 'node[type="CallExpression"]',
        style: { "background-color": "#4DA3A9", shape: "round-rectangle" },
      },
      {
        selector: 'node[type="Argument"]',
        style: { "background-color": "#E0A458", shape: "ellipse" },
      },
      {
        selector: 'node[type="Receiver"]',
        style: { "background-color": "#7C98D8" },
      },
      {
        selector: 'node[type="ReturnValue"]',
        style: { "background-color": "#8BCB88", shape: "round-rectangle" },
      },

      {
        selector:
          'node[type="Route"], node[type="Endpoint"], node[type="Controller"], node[type="Service"], node[type="Repository"], node[type="ReactComponent"], node[type="AngularComponent"], node[type="AngularService"], node[type="FrameworkModule"], node[type="Hook"], node[type="StateVariable"], node[type="EventHandler"], node[type="ORMModel"], node[type="DatabaseTable"], node[type="MessageTopic"], node[type="Template"]',
        style: {
          label: "data(label)",
          shape: "round-rectangle",
          "text-opacity": 0.96,
          "text-background-opacity": 0.9,
          "font-size": 10,
          "font-weight": "650",
          "text-margin-y": 6,
          "text-max-width": 140,
          "text-background-padding": 3,
          width: 42,
          height: 30,
          opacity: 0.96,
          "border-width": 1,
          "border-color": "rgba(255, 255, 255, 0.26)",
          "z-index": 16,
        },
      },
      {
        selector: 'node[type="Route"], node[type="Endpoint"]',
        style: { "background-color": "#4FA3D8", shape: "round-rectangle" },
      },
      {
        selector: 'node[type="Controller"]',
        style: { "background-color": "#E6B450", width: 46, height: 32 },
      },
      {
        selector: 'node[type="Service"], node[type="AngularService"]',
        style: { "background-color": "#58B482", width: 46, height: 32 },
      },
      {
        selector: 'node[type="Repository"], node[type="ORMModel"], node[type="DatabaseTable"]',
        style: { "background-color": "#6D9DE8", width: 46, height: 32 },
      },
      {
        selector: 'node[type="ReactComponent"], node[type="AngularComponent"], node[type="FrameworkModule"], node[type="Template"]',
        style: { "background-color": "#B58AE2", width: 46, height: 32 },
      },
      {
        selector: 'node[type="Hook"], node[type="StateVariable"], node[type="EventHandler"], node[type="MessageTopic"]',
        style: { "background-color": "#D88A6A", width: 40, height: 30 },
      },

      {
        selector:
          'node[type="BasicBlock"], node[type="IfStatement"], node[type="Loop"], node[type="SwitchCase"], node[type="TryCatch"], node[type="ReturnStatement"], node[type="ThrowStatement"], node[type="BreakStatement"], node[type="ContinueStatement"], node[type="Value"], node[type="Assignment"], node[type="Expression"], node[type="SourceExpression"], node[type="SinkExpression"]',
        style: {
          label: "data(label)",
          shape: "round-rectangle",
          "text-opacity": 0.95,
          "text-background-opacity": 0.9,
          "font-size": 10,
          "font-weight": "650",
          "text-margin-y": 6,
          "text-max-width": 132,
          "text-background-padding": 3,
          width: 38,
          height: 28,
          opacity: 0.94,
          "border-width": 1,
          "border-color": "rgba(255, 255, 255, 0.24)",
          "z-index": 18,
        },
      },
      {
        selector: 'node[type="BasicBlock"]',
        style: { "background-color": "#7D93A8", width: 34, height: 24 },
      },
      {
        selector: 'node[type="IfStatement"], node[type="SwitchCase"]',
        style: { "background-color": "#D7B84F", shape: "diamond", width: 40, height: 40 },
      },
      {
        selector: 'node[type="Loop"], node[type="TryCatch"]',
        style: { "background-color": "#6AA6D8", width: 42, height: 30 },
      },
      {
        selector: 'node[type="ReturnStatement"], node[type="ThrowStatement"], node[type="BreakStatement"], node[type="ContinueStatement"]',
        style: { "background-color": "#E07A66", width: 42, height: 30 },
      },
      {
        selector: 'node[type="Assignment"]',
        style: { "background-color": "#E0A458", width: 42, height: 30 },
      },
      {
        selector: 'node[type="Value"]',
        style: { "background-color": "#8BCB88", shape: "ellipse", width: 34, height: 28 },
      },
      {
        selector: 'node[type="Expression"], node[type="SourceExpression"], node[type="SinkExpression"]',
        style: { "background-color": "#9E8FD8", width: 40, height: 28 },
      },
      {
        selector: 'node[type="SourceExpression"]',
        style: { "border-width": 2, "border-color": "#7ED6A8" },
      },
      {
        selector: 'node[type="SinkExpression"]',
        style: { "border-width": 2, "border-color": "#E6B450" },
      },

      {
        selector: "edge",
        style: {
          "curve-style": "bezier",
          width: 1.6,
          "line-color": "#A7B7C8",
          "target-arrow-color": "#A7B7C8",
          "target-arrow-shape": "triangle",
          "arrow-scale": 1.1,
          opacity: 0.68,
          label: showEdgeLabels ? "data(label)" : "",
          "font-size": 9,
          "font-weight": "600",
          "text-background-color": "#111B27",
          "text-background-opacity": 0.92,
          "text-background-padding": 3,
          "text-background-shape": "round-rectangle",
          "text-rotation": "autorotate",
          color: "#E6EEF8",
        },
      },
      {
        selector: 'edge[label="CONTAINS"]',
        style: {
          "line-color": "#8796A8",
          "target-arrow-color": "#8796A8",
          opacity: 0.48,
        },
      },
      {
        selector: 'edge[label="CALLS"]',
        style: {
          "line-color": "#57C98D",
          "target-arrow-color": "#57C98D",
          width: 2.4,
        },
      },
      {
        selector: 'edge[label="IMPORTS_FROM"]',
        style: {
          "line-style": "dashed",
          "line-color": "#5FA8E8",
          "target-arrow-color": "#5FA8E8",
        },
      },
      {
        selector: 'edge[label="EXTENDS"]',
        style: {
          width: 2.6,
          "line-color": "#F07E73",
          "target-arrow-color": "#F07E73",
        },
      },
      {
        selector: 'edge[label="IMPLEMENTS"]',
        style: {
          "line-style": "dashed",
          "line-color": "#B58AE2",
          "target-arrow-color": "#B58AE2",
        },
      },
      {
        selector: 'edge[label="INSTANTIATES"]',
        style: {
          "line-color": "#4CC9D9",
          "target-arrow-color": "#4CC9D9",
        },
      },

      {
        selector:
          'edge[label="HAS_OCCURRENCE"], edge[label="DEFINES"], edge[label="DECLARES"], edge[label="REFERS_TO"], edge[label="RESOLVES_TO"], edge[label="REF_CALL"]',
        style: {
          width: 1.1,
          opacity: 0.42,
          "arrow-scale": 0.8,
          "line-color": "#8A97AA",
          "target-arrow-color": "#8A97AA",
        },
      },
      {
        selector: 'edge[label="HAS_OCCURRENCE"]',
        style: {
          "line-style": "dotted",
          "line-color": "#5F6F85",
          "target-arrow-color": "#5F6F85",
        },
      },
      {
        selector: 'edge[label="RESOLVES_TO"], edge[label="REF_CALL"]',
        style: {
          "line-color": "#6FC6FF",
          "target-arrow-color": "#6FC6FF",
          opacity: 0.7,
        },
      },
      {
        selector: 'edge[label="DEFINES"], edge[label="DECLARES"]',
        style: {
          "line-color": "#7ED6A8",
          "target-arrow-color": "#7ED6A8",
          opacity: 0.62,
        },
      },

      {
        selector:
          'edge[label="HAS_PARAM"], edge[label="HAS_FIELD"], edge[label="HAS_PROPERTY"], edge[label="HAS_TYPE_PARAM"], edge[label="TYPE_OF"], edge[label="RETURNS"], edge[label="IMPORTS"], edge[label="EXPORTS"], edge[label="REEXPORTS"], edge[label="ALIASES"], edge[label="DOCUMENTS"], edge[label="ANNOTATED_BY"]',
        style: {
          width: 1.15,
          opacity: 0.5,
          "arrow-scale": 0.82,
          "line-color": "#B5C4D6",
          "target-arrow-color": "#B5C4D6",
        },
      },
      {
        selector: 'edge[label="HAS_PARAM"], edge[label="HAS_FIELD"], edge[label="HAS_PROPERTY"]',
        style: {
          "line-color": "#E3B65B",
          "target-arrow-color": "#E3B65B",
          opacity: 0.66,
        },
      },
      {
        selector: 'edge[label="IMPORTS"], edge[label="EXPORTS"], edge[label="REEXPORTS"]',
        style: {
          "line-style": "dashed",
          "line-color": "#7EA7F5",
          "target-arrow-color": "#7EA7F5",
        },
      },
      {
        selector: 'edge[label="TYPE_OF"], edge[label="RETURNS"], edge[label="ALIASES"]',
        style: {
          "line-color": "#B792F6",
          "target-arrow-color": "#B792F6",
        },
      },
      {
        selector:
          'edge[label="CALL_SITE_OF"], edge[label="HAS_ARGUMENT"], edge[label="ARGUMENT_FLOWS_TO_PARAMETER"], edge[label="RECEIVER_OF"], edge[label="RETURN_FLOWS_TO_CALLER"], edge[label="OVERRIDES"], edge[label="CALLS_OVERRIDE"]',
        style: {
          width: 1.2,
          opacity: 0.58,
          "arrow-scale": 0.85,
          "line-color": "#C7B36A",
          "target-arrow-color": "#C7B36A",
        },
      },
      {
        selector: 'edge[label="CALL_SITE_OF"], edge[label="HAS_ARGUMENT"], edge[label="RECEIVER_OF"]',
        style: {
          "line-color": "#58B8C2",
          "target-arrow-color": "#58B8C2",
        },
      },
      {
        selector: 'edge[label="ARGUMENT_FLOWS_TO_PARAMETER"], edge[label="RETURN_FLOWS_TO_CALLER"]',
        style: {
          "line-color": "#E0A458",
          "target-arrow-color": "#E0A458",
        },
      },
      {
        selector: 'edge[label="OVERRIDES"], edge[label="CALLS_OVERRIDE"]',
        style: {
          "line-style": "dashed",
          "line-color": "#C084FC",
          "target-arrow-color": "#C084FC",
        },
      },

      {
        selector:
          'edge[label="ROUTES_TO"], edge[label="HANDLES"], edge[label="CALLS_SERVICE"], edge[label="QUERIES_TABLE"], edge[label="USES_MODEL"], edge[label="EMITS_EVENT"], edge[label="SUBSCRIBES_TO"], edge[label="RENDERS"], edge[label="USES_HOOK"], edge[label="UPDATES_STATE"], edge[label="BINDS_TEMPLATE"], edge[label="DEPENDS_ON"], edge[label="USED_BY"], edge[label="AFFECTS"], edge[label="IMPACT_PATH"], edge[label="CHANGES_PUBLIC_API"]',
        style: {
          width: 1.35,
          opacity: 0.62,
          "arrow-scale": 0.88,
          "line-color": "#9FC6D8",
          "target-arrow-color": "#9FC6D8",
        },
      },
      {
        selector: 'edge[label="ROUTES_TO"], edge[label="HANDLES"]',
        style: {
          "line-color": "#4FA3D8",
          "target-arrow-color": "#4FA3D8",
          width: 2,
        },
      },
      {
        selector: 'edge[label="CALLS_SERVICE"], edge[label="QUERIES_TABLE"], edge[label="USES_MODEL"]',
        style: {
          "line-color": "#58B482",
          "target-arrow-color": "#58B482",
          width: 2,
        },
      },
      {
        selector: 'edge[label="RENDERS"], edge[label="USES_HOOK"], edge[label="UPDATES_STATE"], edge[label="BINDS_TEMPLATE"]',
        style: {
          "line-color": "#D88A6A",
          "target-arrow-color": "#D88A6A",
        },
      },
      {
        selector: 'edge[label="AFFECTS"], edge[label="IMPACT_PATH"], edge[label="CHANGES_PUBLIC_API"]',
        style: {
          "line-style": "dashed",
          "line-color": "#E6B450",
          "target-arrow-color": "#E6B450",
          width: 2.1,
        },
      },
      {
        selector:
          'edge[label="CFG_NEXT"], edge[label="BRANCH_TRUE"], edge[label="BRANCH_FALSE"], edge[label="LOOP_BACK"], edge[label="EXCEPTION_FLOW"], edge[label="RETURNS_TO"], edge[label="DOMINATES"], edge[label="POST_DOMINATES"], edge[label="CONTROL_DEPENDS_ON"], edge[label="READS"], edge[label="WRITES"], edge[label="ASSIGNS"], edge[label="USES_VALUE"], edge[label="DEFINES_VALUE"], edge[label="REACHING_DEF"], edge[label="FLOWS_TO"], edge[label="PARAM_FLOWS_TO_ARG"], edge[label="ARG_FLOWS_TO_PARAM"], edge[label="RETURN_FLOWS_TO"], edge[label="FIELD_READ"], edge[label="FIELD_WRITE"], edge[label="CAPTURES"]',
        style: {
          width: 1.15,
          opacity: 0.52,
          "arrow-scale": 0.82,
          "line-color": "#92A7B8",
          "target-arrow-color": "#92A7B8",
        },
      },
      {
        selector: 'edge[label="BRANCH_TRUE"], edge[label="BRANCH_FALSE"], edge[label="CONTROL_DEPENDS_ON"]',
        style: { "line-color": "#D7B84F", "target-arrow-color": "#D7B84F" },
      },
      {
        selector: 'edge[label="LOOP_BACK"], edge[label="EXCEPTION_FLOW"]',
        style: { "line-style": "dashed", "line-color": "#6AA6D8", "target-arrow-color": "#6AA6D8" },
      },
      {
        selector: 'edge[label="READS"], edge[label="USES_VALUE"], edge[label="FIELD_READ"]',
        style: { "line-color": "#8BCB88", "target-arrow-color": "#8BCB88" },
      },
      {
        selector: 'edge[label="WRITES"], edge[label="DEFINES_VALUE"], edge[label="ASSIGNS"], edge[label="FIELD_WRITE"]',
        style: { "line-color": "#E0A458", "target-arrow-color": "#E0A458" },
      },
      {
        selector: 'edge[label="REACHING_DEF"], edge[label="FLOWS_TO"], edge[label="RETURN_FLOWS_TO"], edge[label="RETURNS_TO"]',
        style: { "line-color": "#B58AE2", "target-arrow-color": "#B58AE2" },
      },

      {
        selector: ":selected",
        style: {
          "border-width": 0,
          "z-index": 9999,
          "font-size": nodeFontSize + 2,
          "font-weight": "700",
          "text-background-color": "#2C2614",
          "text-border-width": 0,
        },
      },
      {
        selector:
          'node[type="Symbol"]:selected, node[type="Definition"]:selected, node[type="Declaration"]:selected, node[type="Reference"]:selected, node[type="ExternalSymbol"]:selected, node[type="Symbol"].highlight, node[type="Definition"].highlight, node[type="Declaration"].highlight, node[type="Reference"].highlight, node[type="ExternalSymbol"].highlight',
        style: {
          label: "data(label)",
          "text-opacity": 1,
          "text-background-opacity": 0.92,
          "font-size": 10,
          "text-margin-y": 5,
        },
      },
      {
        selector: ".highlight",
        style: {
          "border-width": 0,
          opacity: 1,
          "z-index": 9998,
          "font-weight": "700",
        },
      },
      {
        selector: ".faded",
        style: {
          opacity: 0.14,
          "text-opacity": 0.12,
        },
      },
      {
        selector: ".hidden",
        style: { display: "none" },
      },
    ];
  },
};

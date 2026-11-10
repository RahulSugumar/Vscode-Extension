import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

import { Graph } from "../models/Graph";
import { JsonExporter } from "../exporter/JsonExporter";

export interface GraphPanelSelection {
    id: string;
    label?: string;
    type?: string;
    filePath?: string;
    lineNumber?: number;
}

export class GraphPanel {

    public static currentPanel: GraphPanel | undefined;

    private static leftPanelCollapsed = true;

    private static readonly selectionEmitter =
        new vscode.EventEmitter<GraphPanelSelection | null>();

    public static readonly onDidChangeSelection =
        GraphPanel.selectionEmitter.event;

    private static readonly relationshipFiltersEmitter =
        new vscode.EventEmitter<string[]>();

    public static readonly onDidChangeRelationshipFilters =
        GraphPanel.relationshipFiltersEmitter.event;

    private static enabledRelationships: string[] | undefined;

    private static readonly relationshipDependencies: Record<string, string[]> = {
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

    private readonly panel: vscode.WebviewPanel;

    private readonly extensionPath: string;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionPath: string
    ) {

        this.panel = panel;

        this.extensionPath = extensionPath;

        this.panel.onDidDispose(() => {

            GraphPanel.currentPanel = undefined;

            GraphPanel.selectionEmitter.fire(null);

        });

        this.panel.webview.onDidReceiveMessage(message => {

            if (!message) {

                return;

            }

            if (message.command === "graphSelectionChanged") {

                GraphPanel.selectionEmitter.fire(

                    this.normalizeSelection(message.node)

                );

                return;

            }

            if (message.command === "graphRelationshipFiltersChanged") {

                GraphPanel.enabledRelationships = GraphPanel.normalizeRelationshipFilters(

                    message.enabledRelationships

                );

                GraphPanel.relationshipFiltersEmitter.fire(

                    GraphPanel.enabledRelationships

                );

            }

        });

    }

    //----------------------------------------------------------

    public static createOrShow(extensionPath: string): GraphPanel {

        const column =
            vscode.window.activeTextEditor?.viewColumn;

        if (GraphPanel.currentPanel) {

            GraphPanel.currentPanel.panel.reveal(column);

            return GraphPanel.currentPanel;

        }

        const panel = vscode.window.createWebviewPanel(

            "codeKnowledgeGraph",

            "Project Graph",

            column ?? vscode.ViewColumn.One,

            {

                enableScripts: true,

                retainContextWhenHidden: true,

                localResourceRoots: [

                    vscode.Uri.file(

                        path.join(

                            extensionPath,

                            "dist",

                            "viewer",

                            "webview"

                        )

                    )

                ]

            }

        );

        GraphPanel.currentPanel =

            new GraphPanel(panel, extensionPath);

        return GraphPanel.currentPanel;

    }

    //----------------------------------------------------------

    public static closeCurrent(): boolean {

        if (!GraphPanel.currentPanel) {

            return false;

        }

        GraphPanel.currentPanel.dispose();

        return true;

    }

    //----------------------------------------------------------

    public static isOpen(): boolean {

        return Boolean(GraphPanel.currentPanel);

    }

    //----------------------------------------------------------

    public static setRelationshipFilters(enabledRelationships: string[]): void {

        GraphPanel.enabledRelationships = GraphPanel.normalizeRelationshipFilters(enabledRelationships);

        GraphPanel.currentPanel?.postRelationshipFilters();

    }

    //----------------------------------------------------------

    public dispose(): void {

        this.panel.dispose();

    }

    //----------------------------------------------------------

    public toggleSidebar(): boolean {

        GraphPanel.leftPanelCollapsed = !GraphPanel.leftPanelCollapsed;

        this.setSidebarCollapsed(GraphPanel.leftPanelCollapsed);

        return GraphPanel.leftPanelCollapsed;

    }

    //----------------------------------------------------------

    public setSidebarCollapsed(collapsed: boolean): void {

        GraphPanel.leftPanelCollapsed = collapsed;

        void this.panel.webview.postMessage({

            command: "setLeftPanelCollapsed",

            collapsed

        });

    }

    //----------------------------------------------------------

    private postRelationshipFilters(): void {

        const enabledRelationships = GraphPanel.enabledRelationships ?? [];

        void this.panel.webview.postMessage({

            command: "setRelationshipFilters",

            enabledRelationships

        });

    }

    //----------------------------------------------------------

    public async loadFromWorkspace(): Promise<void> {

        const folders = vscode.workspace.workspaceFolders;

        if (!folders || folders.length === 0) {

            vscode.window.showInformationMessage(

                "Open a project folder first."

            );

            return;

        }

        const exporter = new JsonExporter();

        const graph = await exporter.tryLoad(

            folders[0],

            ".code-knowledge-graph.json"

        );

        if (!graph) {
            return;

        }

        this.updateGraph(graph);

    }

    //----------------------------------------------------------

    public updateGraph(graph: Graph): void {

        this.panel.webview.html = this.getHtml();

        setTimeout(() => {

            this.panel.webview.postMessage({

                command: "loadGraph",

                graph,

                leftPanelCollapsed: GraphPanel.leftPanelCollapsed,

                enabledRelationships: GraphPanel.enabledRelationships

            });

        }, 300);

    }

    //----------------------------------------------------------

    private getHtml(): string {

        const webviewFolder = path.join(

            this.extensionPath,

            "dist",

            "viewer",

            "webview"

        );

        let html = fs.readFileSync(

            path.join(webviewFolder, "index.html"),

            "utf8"

        );

        const replace = (file: string) => {

            html = html.replace(

                `src="${file}"`,

                `src="${this.panel.webview.asWebviewUri(
                    vscode.Uri.file(
                        path.join(webviewFolder, file)
                    )
                )}"`

            );

        };

        [

            "cytoscape.min.js",

            "layout-base.js",

            "cose-base.js",

            "cytoscape-fcose.js",

            "graph-state.js",

            "graph-style.js",

            "graph-engine.js",

            "graph-renderer.js",

            "graph-ui.js",

            "graph-viewer.js"

        ].forEach(replace);

        return html;

    }

    //----------------------------------------------------------

    private normalizeSelection(raw: unknown): GraphPanelSelection | null {

        if (!raw || typeof raw !== "object") {

            return null;

        }

        const value = raw as Record<string, unknown>;
        const id = typeof value.id === "string" ? value.id : "";

        if (!id) {

            return null;

        }

        const label = typeof value.label === "string" ? value.label : undefined;
        const type = typeof value.type === "string" ? value.type : undefined;
        const filePath = typeof value.filePath === "string" ? value.filePath : undefined;
        const lineNumber = typeof value.lineNumber === "number" ? value.lineNumber : undefined;

        return { id, label, type, filePath, lineNumber };

    }

    //----------------------------------------------------------

    private static expandRelationshipFilters(relationships: string[]): string[] {

        const expanded = new Set<string>();
        const pending = [...relationships];

        while (pending.length > 0) {

            const relationship = pending.shift();

            if (!relationship || expanded.has(relationship)) {

                continue;

            }

            expanded.add(relationship);

            for (const dependency of GraphPanel.relationshipDependencies[relationship] ?? []) {

                if (!expanded.has(dependency)) {

                    pending.push(dependency);

                }

            }

        }

        return [...expanded];

    }

    //----------------------------------------------------------

    private static normalizeRelationshipFilters(raw: unknown): string[] {

        if (!Array.isArray(raw)) {

            return [];

        }

        const requested = raw

            .filter((item): item is string => typeof item === "string")

            .map(item => item.trim())

            .filter(Boolean);

        return GraphPanel.expandRelationshipFilters(requested);

    }

}
